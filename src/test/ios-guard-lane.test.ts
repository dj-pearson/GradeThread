import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

// The iOS text guards run in CI and, since this lane, locally too. This file is
// what keeps those two lists the same.
//
// The failure it exists to prevent already happened, in a form nobody would have
// called drift: all six guards ran only in CI, because CLAUDE.md recorded them
// as unrunnable here — "there is no python3 on the Windows dev box". True about
// the NAME. Python 3.13 is installed under `python`, so six guards were one
// string away from working, and one of them was ported to a vitest file to work
// around it.
//
// Now that they run in both places, the cheap way to lose them again is to add
// a seventh guard to a workflow and forget the lane. That is what this checks.

const root = process.cwd();
const VERIFY = resolve(root, "scripts/verify.mjs");
const WORKFLOWS = resolve(root, ".github/workflows");
const IOS_SCRIPTS = resolve(root, "ios/Scripts");

/** The scripts the local lane runs, read out of its own list. */
function laneScripts(): string[] {
  const src = readFileSync(VERIFY, "utf8");
  const block = src.match(/const IOS_GUARDS = \[([\s\S]*?)\n\];/)?.[1];
  if (!block) throw new Error("IOS_GUARDS not found in scripts/verify.mjs — was it renamed?");
  return [...block.matchAll(/"([a-z0-9-]+\.py)"/g)].map((m) => m[1]!);
}

/** The scripts any workflow invokes out of ios/Scripts. */
function ciScripts(): string[] {
  const found = new Set<string>();
  for (const file of readdirSync(WORKFLOWS).filter((f) => /\.ya?ml$/.test(f))) {
    const src = readFileSync(join(WORKFLOWS, file), "utf8");
    for (const m of src.matchAll(/ios\/Scripts\/([a-z0-9-]+\.py)/g)) {
      // Comments reference the scripts too; only a `run:` line invokes one.
      const line = src.slice(src.lastIndexOf("\n", m.index) + 1, src.indexOf("\n", m.index));
      if (/^\s*(run:|-\s)/.test(line) || /python3?\s+ios\/Scripts/.test(line)) found.add(m[1]!);
    }
  }
  return [...found];
}

describe("the iOS guards run in both places", () => {
  it("finds a real lane list and a real CI list", () => {
    // Guards the guard: an empty list on either side would make every
    // comparison below vacuously true.
    expect(laneScripts().length).toBeGreaterThanOrEqual(6);
    expect(ciScripts().length).toBeGreaterThanOrEqual(6);
  });

  it("every guard CI runs also runs in `npm run verify`", () => {
    const lane = new Set(laneScripts());
    const missing = ciScripts().filter((s) => !lane.has(s));
    expect(
      missing,
      `these run in a workflow but not in the local lane: ${missing.join(", ")}. ` +
        "Add them to IOS_GUARDS in scripts/verify.mjs — a guard only CI runs is a " +
        "guard that fails after the push instead of before it.",
    ).toEqual([]);
  });

  it("every guard in the lane exists on disk", () => {
    const present = new Set(readdirSync(IOS_SCRIPTS));
    for (const s of laneScripts()) {
      expect(present.has(s), `${s} is in IOS_GUARDS but not in ios/Scripts`).toBe(true);
    }
  });

  it("no guard script is left out of both", () => {
    // _scan_scope.py is a shared module, not a guard — it has no main.
    const scripts = readdirSync(IOS_SCRIPTS).filter(
      (f) => f.endsWith(".py") && !f.startsWith("_"),
    );
    const covered = new Set([...laneScripts(), ...ciScripts()]);
    const orphans = scripts.filter((s) => !covered.has(s));
    expect(
      orphans,
      `these exist in ios/Scripts and nothing runs them: ${orphans.join(", ")}`,
    ).toEqual([]);
  });
});

describe("the lane can actually reach an interpreter", () => {
  it("verify.mjs resolves python by trying more than one name", () => {
    // The whole defect in one assertion. Hardcoding `python3` is what made
    // these CI-only on a machine that has Python.
    const src = readFileSync(resolve(root, "scripts/lib/python.mjs"), "utf8");
    for (const name of ["python3", "python", "py"]) {
      expect(src, `resolvePython no longer tries ${name}`).toContain(`"${name}"`);
    }
  });

  it("the lane skips with a reason rather than failing when there is no Python", () => {
    const src = readFileSync(VERIFY, "utf8");
    const lane = src.slice(src.indexOf('if (on("ios"))'), src.indexOf('if (on("android"))'));
    expect(lane).toContain("skipped.push");
    expect(lane).not.toMatch(/process\.exit/);
  });
});
