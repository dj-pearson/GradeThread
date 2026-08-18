import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

// A guard for a break that LOOKS like it compiles and does not, and that no
// local check could see.
//
// `@Environment(\.openURL)` lost its backslash on the way into the file and
// became `@Environment(.openURL)`. That is still well-formed Swift — implicit
// member access on an inferred type — so it reads correctly, greps correctly,
// and passes all six iOS source guards. It fails only in the type checker, as
// "Generic parameter 'T' could not be inferred": an error that names no file,
// no line, and blames the whole module. Two macOS CI rounds went into finding
// one missing character.
//
// There are exactly two legal spellings of the attribute:
//   @Environment(\.someKeyPath)  — an EnvironmentValues key path
//   @Environment(SomeType.self)  — an @Observable object (iOS 17+)
// An opening paren followed directly by a dot is neither, and is always the
// dropped backslash. Cheap to check here, expensive to find there.

const IOS_ROOT = resolve(process.cwd(), "ios");

/** Mirrors TARGET_DIRS in ios/Scripts/_scan_scope.py. */
const TARGET_DIRS = [
  "GradeThread",
  "ShareExtension",
  "GradeThreadWidget",
  "Shared",
  "Packages",
];

/** `@Environment(` followed by a bare `.` — the backslash is gone. */
const BROKEN_KEYPATH_RE = /@Environment\s*\(\s*\./;

function swiftFiles(dir: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry);
    let stats;
    try {
      stats = statSync(full);
    } catch {
      continue;
    }
    if (stats.isDirectory()) {
      out.push(...swiftFiles(full));
    } else if (entry.endsWith(".swift")) {
      out.push(full);
    }
  }
  return out;
}

describe("iOS @Environment key paths keep their backslash", () => {
  it("has no @Environment( followed by a bare dot", () => {
    const hits: string[] = [];
    for (const dir of TARGET_DIRS) {
      for (const file of swiftFiles(join(IOS_ROOT, dir))) {
        const lines = readFileSync(file, "utf8").split(/\r?\n/);
        lines.forEach((line, i) => {
          if (BROKEN_KEYPATH_RE.test(line)) {
            hits.push(`${relative(IOS_ROOT, file)}:${i + 1}: ${line.trim()}`);
          }
        });
      }
    }
    expect(hits, hits.join("\n")).toEqual([]);
  });

  // A guard that cannot see the shape it exists for is not a guard. This repo
  // has shipped four of those.
  it("matches the break it was written for", () => {
    expect(
      BROKEN_KEYPATH_RE.test("    @Environment(.openURL) private var openURL"),
    ).toBe(true);
  });

  it("leaves both legal spellings alone", () => {
    expect(
      BROKEN_KEYPATH_RE.test(
        String.raw`    @Environment(\.openURL) private var openURL`,
      ),
    ).toBe(false);
    expect(
      BROKEN_KEYPATH_RE.test(
        "    @Environment(NetworkMonitor.self) private var monitor",
      ),
    ).toBe(false);
  });
});
