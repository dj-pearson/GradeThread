import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

// Every Python guard under android/scripts runs in BOTH `npm run verify` and CI.
//
// src/test/ios-guard-lane.test.ts makes this assertion for ios/Scripts and has
// for a while; nothing made it for android/scripts, which is the half that grew
// a sixth guard this week. The failure it prevents is not dramatic and is very
// easy: a guard wired into the workflow and not the lane fails AFTER the push,
// and one wired into the lane and not the workflow is a guard the merge never
// has to satisfy. Either way it looks like it is working.
//
// The third assertion is the one that catches the quiet case: a .py sitting in
// android/scripts that NOTHING runs. A guard nobody invokes reports nothing,
// which is indistinguishable from a guard that finds nothing.
//
// KEYED ON THE FILENAME, not on parsing the invocation, for the same reason the
// Node half is: verify.mjs calls these through a resolved interpreter
// (`${py} scripts/x.py`) and the workflows through `run: python3 scripts/x.py`,
// and a parser for both would break more often than the thing it checks.

const root = process.cwd();
const ANDROID_SCRIPTS = resolve(root, "android/scripts");
const VERIFY = resolve(root, "scripts/verify.mjs");
const WORKFLOWS = resolve(root, ".github/workflows");

/** Python guards `npm run verify` invokes with android/ as its cwd. */
function laneScripts(): string[] {
  const src = readFileSync(VERIFY, "utf8");
  return [...src.matchAll(/\$\{py\}\s+scripts\/([a-z0-9-]+\.py)/g)].map((m) => m[1]!);
}

/** Python guards any workflow invokes out of android/scripts. */
function ciScripts(): string[] {
  const found = new Set<string>();
  for (const file of readdirSync(WORKFLOWS).filter((f) => /^android-.*\.ya?ml$/.test(f))) {
    const src = readFileSync(join(WORKFLOWS, file), "utf8");
    for (const m of src.matchAll(/python3?\s+scripts\/([a-z0-9-]+\.py)/g)) {
      // Comments name these scripts too; only a `run:` line invokes one.
      const line = src.slice(src.lastIndexOf("\n", m.index) + 1, src.indexOf("\n", m.index));
      if (!line.trimStart().startsWith("#")) found.add(m[1]!);
    }
  }
  return [...found];
}

/** Shared modules that a guard IMPORTS rather than something anyone invokes.
 *
 *  `label_rule.py` (US-2976 AC9) is the positional label rule. It is imported
 *  by `no-unlocalized-copy.py`, which both the lane and CI run, and its own
 *  `self_test()` is called on every one of those runs. Counting it as an
 *  unrun guard would be wrong: it is covered, just not from a command line.
 *
 *  The value is the guard that must import it, and the test below re-proves
 *  that link on every run, so an entry here cannot outlive its reason. */
const IMPORTED_MODULES: Record<string, string> = {
  "label_rule.py": "no-unlocalized-copy.py",
};

/** Every Python guard actually on disk. */
function onDisk(): string[] {
  return readdirSync(ANDROID_SCRIPTS)
    .filter((f) => f.endsWith(".py"))
    .filter((f) => !(f in IMPORTED_MODULES));
}

describe("the Android Python guards run in both places", () => {
  it("finds a real lane list and a real CI list", () => {
    // Guards the guard: an empty list on either side makes every comparison
    // below vacuously true, which is the failure mode of this whole file.
    expect(laneScripts().length).toBeGreaterThanOrEqual(4);
    expect(ciScripts().length).toBeGreaterThanOrEqual(4);
    expect(onDisk().length).toBeGreaterThanOrEqual(4);
  });

  it("every guard CI runs also runs in `npm run verify`", () => {
    const lane = new Set(laneScripts());
    const missing = ciScripts().filter((s) => !lane.has(s));
    expect(
      missing,
      `these run in an android workflow but not in the local lane: ${missing.join(", ")}. ` +
        "Add them next to the other `${py} scripts/*.py` calls in scripts/verify.mjs — a " +
        "guard only CI runs is a guard that fails after the push instead of before it.",
    ).toEqual([]);
  });

  it("every guard the lane runs also runs in CI", () => {
    const ci = new Set(ciScripts());
    const missing = laneScripts().filter((s) => !ci.has(s));
    expect(
      missing,
      `these run locally but no android workflow runs them: ${missing.join(", ")}. ` +
        "A guard the merge does not have to satisfy is a guard anyone can push past.",
    ).toEqual([]);
  });

  it("every guard the lane names actually exists", () => {
    const present = new Set(onDisk());
    for (const script of laneScripts()) {
      expect(present.has(script), `verify.mjs runs ${script} and android/scripts has no such file`).toBe(true);
    }
  });

  it("every exempt module is still imported by a guard that still runs", () => {
    const run = new Set([...laneScripts(), ...ciScripts()]);
    for (const [module, importer] of Object.entries(IMPORTED_MODULES)) {
      const stem = module.replace(/\.py$/, "");
      const src = readFileSync(join(ANDROID_SCRIPTS, importer), "utf8");
      expect(
        src.includes(`import ${stem}`),
        `${importer} no longer imports ${module}, so the exemption is stale: ` +
          "either delete the module or wire it up as a guard of its own.",
      ).toBe(true);
      expect(
        run.has(importer),
        `${module} is exempt because ${importer} imports it, but nothing runs ${importer}.`,
      ).toBe(true);
    }
  });

  it("nothing sits in android/scripts unrun", () => {
    const run = new Set([...laneScripts(), ...ciScripts()]);
    const orphans = onDisk().filter((s) => !run.has(s));
    expect(
      orphans,
      `these exist in android/scripts and nothing runs them: ${orphans.join(", ")}. ` +
        "A guard nobody invokes reports nothing, which reads exactly like a clean tree.",
    ).toEqual([]);
  });
});
