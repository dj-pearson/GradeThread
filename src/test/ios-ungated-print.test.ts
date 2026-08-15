import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

// US-698's guard, ported so it RUNS ON THE MACHINE THE WORK IS ON.
//
// CLAUDE.md said "Only `python3 ios/Scripts/no-ungated-print.py` runs locally",
// and on this Windows checkout there is no python3 — so the one iOS check
// documented as available locally was not available at all, and the real local
// iOS safety net was zero. That matters more than it sounds: seven iOS stories
// in the current review are deferred on the reasoning that Swift written here
// would be unverified until a macOS lane runs, and the mitigation named in the
// contributor docs did not exist.
//
// This is a PORT, not a replacement. `ios/Scripts/no-ungated-print.py` stays and
// still runs in iOS CI; the parity test at the bottom asserts the two agree on
// scope, so a fix to one cannot silently leave the other scanning less. Same
// approach US-2534 took for the accessibility ratchet, and for the same stated
// reason.
//
// WHAT IT ENFORCES. Release builds must not log to the console: a stray
// `print(error)` can put tokens, signed storage URLs or PII into device logs and
// screen recordings. Diagnostic prints belong inside `#if DEBUG`.

const IOS_ROOT = resolve(process.cwd(), "ios");

/** Mirrors TARGET_DIRS in ios/Scripts/_scan_scope.py. Parity-checked below. */
const TARGET_DIRS = [
  "GradeThread",
  "ShareExtension",
  "GradeThreadWidget",
  "Shared",
  "Packages",
];

/** A `print(` that starts a statement, allowing leading whitespace. */
const PRINT_RE = /^\s*print\s*\(/;

function swiftFiles(dir: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return []; // a target dir that does not exist is not a failure
  }
  const out: string[] = [];
  for (const name of entries) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...swiftFiles(full));
    else if (name.endsWith(".swift")) out.push(full);
  }
  return out;
}

/**
 * 0-based indices of lines that compile only under DEBUG.
 *
 * Tracks `#if` / `#elseif` / `#else` / `#endif` nesting; a line is gated when
 * EVERY enclosing branch is a `#if DEBUG` branch. Ported line-for-line from the
 * Python so the two cannot disagree about what "gated" means — including the
 * subtlety that the `#else` of an `#if DEBUG` is the NON-debug branch, which is
 * exactly where an ungated print would hide from a naive scanner.
 */
export function debugGatedLines(lines: string[]): Set<number> {
  const gated = new Set<number>();
  const stack: boolean[] = [];
  lines.forEach((line, i) => {
    const s = line.trim();
    if (s.startsWith("#if ")) {
      stack.push(s.slice("#if ".length).trim() === "DEBUG");
      return;
    }
    if (s.startsWith("#elseif ")) {
      if (stack.length) stack[stack.length - 1] = s.slice("#elseif ".length).trim() === "DEBUG";
      return;
    }
    if (s === "#else") {
      if (stack.length) stack[stack.length - 1] = false;
      return;
    }
    if (s.startsWith("#endif")) {
      stack.pop();
      return;
    }
    if (stack.length > 0 && stack.every(Boolean)) gated.add(i);
  });
  return gated;
}

/** Ungated print sites, as "path:line: source". */
export function ungatedPrints(): string[] {
  const offenders: string[] = [];
  for (const target of TARGET_DIRS) {
    for (const path of swiftFiles(join(IOS_ROOT, target))) {
      const lines = readFileSync(path, "utf8").split(/\r?\n/);
      const gated = debugGatedLines(lines);
      lines.forEach((line, i) => {
        if (PRINT_RE.test(line) && !gated.has(i)) {
          offenders.push(`${relative(IOS_ROOT, path).replace(/\\/g, "/")}:${i + 1}: ${line.trim()}`);
        }
      });
    }
  }
  return offenders;
}

describe("no ungated print() in iOS app sources (US-698)", () => {
  it("finds none", () => {
    const offenders = ungatedPrints();
    expect(
      offenders,
      offenders.length
        ? `Wrap these in #if DEBUG — a release print can leak tokens, signed ` +
          `URLs or PII into device logs:\n  ${offenders.join("\n  ")}`
        : "",
    ).toEqual([]);
  });

  it("actually scanned something", () => {
    // Without this the suite passes cheerfully on a checkout with no iOS tree,
    // or after a rename that leaves every target dir missing — the shape of
    // green that means "nothing was checked".
    let count = 0;
    for (const t of TARGET_DIRS) count += swiftFiles(join(IOS_ROOT, t)).length;
    expect(count, "no Swift files were scanned").toBeGreaterThan(100);
  });
});

describe("the DEBUG-gating rule matches the Python", () => {
  it("gates a plain #if DEBUG block", () => {
    expect([...debugGatedLines(["#if DEBUG", "print(x)", "#endif"])]).toEqual([1]);
  });

  it("does NOT gate the #else of an #if DEBUG", () => {
    // The case a naive scanner gets wrong: the else branch ships.
    const lines = ["#if DEBUG", "print(a)", "#else", "print(b)", "#endif"];
    const gated = debugGatedLines(lines);
    expect(gated.has(1)).toBe(true);
    expect(gated.has(3)).toBe(false);
  });

  it("does not gate a non-DEBUG condition", () => {
    expect([...debugGatedLines(["#if os(iOS)", "print(x)", "#endif"])]).toEqual([]);
  });

  it("requires EVERY enclosing branch to be DEBUG", () => {
    const lines = ["#if os(iOS)", "#if DEBUG", "print(x)", "#endif", "#endif"];
    expect(debugGatedLines(lines).has(2)).toBe(false);
  });

  it("handles #elseif switching a branch on and off", () => {
    const on = ["#if os(iOS)", "#elseif DEBUG", "print(x)", "#endif"];
    expect(debugGatedLines(on).has(2)).toBe(true);
    const off = ["#if DEBUG", "#elseif os(iOS)", "print(x)", "#endif"];
    expect(debugGatedLines(off).has(2)).toBe(false);
  });

  it("only matches a print that STARTS a statement", () => {
    // `sprint(` and a print inside a string or after other code are not calls
    // this guard is about; matching them would train people to ignore it.
    expect(PRINT_RE.test("    print(error)")).toBe(true);
    expect(PRINT_RE.test("    sprint(error)")).toBe(false);
    expect(PRINT_RE.test('    let s = "print("')).toBe(false);
  });
});

describe("this port and the Python guard scan the same tree", () => {
  it("mirrors TARGET_DIRS from _scan_scope.py", () => {
    // US-2342 exists because four scripts each carried their own copy of this
    // list and all four omitted `Packages`, leaving the money math unguarded.
    // A fifth copy in TypeScript would be the same bug again, so it is compared
    // rather than trusted.
    const scope = readFileSync(resolve(process.cwd(), "ios/Scripts/_scan_scope.py"), "utf8");
    const block = /TARGET_DIRS = \[([\s\S]*?)\]/.exec(scope);
    expect(block, "TARGET_DIRS moved in _scan_scope.py").toBeTruthy();
    const dirs = [...block![1]!.replace(/#[^\n]*/g, "").matchAll(/"([^"]+)"/g)].map(
      (m) => m[1]!,
    );
    expect(dirs).toEqual(TARGET_DIRS);
  });

  it("uses the same print pattern the Python does", () => {
    const py = readFileSync(
      resolve(process.cwd(), "ios/Scripts/no-ungated-print.py"),
      "utf8",
    );
    // The Python source of the regex, spelled the same way.
    expect(py).toContain(String.raw`r"^\s*print\s*\("`);
    expect(PRINT_RE.source).toBe(String.raw`^\s*print\s*\(`);
  });

  it("leaves the Python guard in place for iOS CI", () => {
    // This is a PORT, not a replacement. Deleting the Python would remove the
    // check from the macOS lane, where the rest of the iOS guards still live.
    const workflow = readFileSync(
      resolve(process.cwd(), ".github/workflows/ios-ci.yml"),
      "utf8",
    );
    expect(workflow).toContain("python3 ios/Scripts/no-ungated-print.py");
  });
});
