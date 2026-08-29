// US-2902: every Android CI job that runs the app's Gradle tasks needs the same
// BuildConfig env, and one of them did not have it.
//
// WHAT THIS CAUGHT. `build-and-test` carries `env: SUPABASE_ANON_KEY:
// ci-placeholder-anon-key`, added when 161 unit tests died in setup: the Hilt
// graph constructs SupabaseShared, which asserts the field is non-blank, and a
// runner has no local.properties for `secret()` to fall back to. The
// `instrumented` job runs the same app on an emulator and never got the block.
// Every instrumented run since died in Application.onCreate with
// "SUPABASE_ANON_KEY missing", all four tests reported FAILED for one missing
// string, and `continue-on-error: true` reported the workflow green anyway.
//
// The cost was not the four tests. RoomMigrationTest is the only thing in the
// repo that proves a Room migration runs against real SQLite, the workflow tells
// people to read that job before any schema bump, and it had never executed.
//
// WHY A GUARD AND NOT JUST THE FIX. The fix is one env block, and the identical
// omission has now happened once per job that exists. A third job that runs
// `./gradlew ...` on this app will need it too, and the failure mode is not a
// missing-variable error at the top of the log — it is the app crashing at
// launch, which reads like a broken app rather than a broken workflow.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const WORKFLOW = join(process.cwd(), ".github", "workflows", "android-ci.yml");
const KEY = "SUPABASE_ANON_KEY";

const yaml = readFileSync(WORKFLOW, "utf8").replace(/\r\n?/g, "\n");

/**
 * Job blocks, keyed by name.
 *
 * Parsed by indentation rather than with a YAML library on purpose: the
 * question is "what does the block for this job contain", and a parsed tree
 * would answer it for `env` while losing the comments that say why the value is
 * what it is. Jobs sit at exactly two spaces under `jobs:`.
 */
function jobs(): Map<string, string> {
  const out = new Map<string, string>();
  const lines = yaml.split("\n");
  const start = lines.findIndex((l) => l === "jobs:");
  expect(start, "no `jobs:` key — this guard is reading the wrong file").toBeGreaterThanOrEqual(0);
  let name: string | null = null;
  let buf: string[] = [];
  for (const line of lines.slice(start + 1)) {
    const header = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(line);
    if (header) {
      if (name) out.set(name, buf.join("\n"));
      name = header[1]!;
      buf = [];
      continue;
    }
    if (name) buf.push(line);
  }
  if (name) out.set(name, buf.join("\n"));
  return out;
}

/** Comments stripped: the workflow NAMES this variable while explaining it. */
const withoutComments = (s: string) => s.replace(/^\s*#.*$/gm, "");

describe("US-2902: the Android CI jobs cannot drift on BuildConfig env", () => {
  it("finds the jobs it is meant to check", () => {
    // Guards the guard. A renamed job would silently drop out of the loop
    // below, and a loop over nothing passes exactly like a loop over
    // everything-correct.
    const names = [...jobs().keys()];
    expect(names).toContain("build-and-test");
    expect(names).toContain("instrumented");
  });

  it("every job that runs the app's Gradle tasks declares SUPABASE_ANON_KEY", () => {
    // The rule is derived, not listed: a job qualifies by RUNNING gradle on
    // this app, so a new one is covered the day it is written rather than the
    // day someone remembers to add it here.
    const offenders: string[] = [];
    for (const [name, block] of jobs()) {
      const body = withoutComments(block);
      if (!/\.\/gradlew\s/.test(body)) continue;
      if (!new RegExp(`^\\s*${KEY}:\\s*\\S`, "m").test(body)) offenders.push(name);
    }
    expect(
      offenders,
      `these jobs run ./gradlew without ${KEY}, so the app asserts at launch and ` +
        "every test in them fails for one missing string",
    ).toEqual([]);
  });

  it("at least one job actually matched, so the rule is not vacuous", () => {
    const running = [...jobs()].filter(([, b]) => /\.\/gradlew\s/.test(withoutComments(b)));
    expect(running.length, "no job runs ./gradlew — the parse is wrong").toBeGreaterThan(1);
  });

  it("the placeholder is a placeholder, not a real key", () => {
    // The value is committed in plain text, so it has to stay obviously fake.
    // A real anon key here would be a secret in the repository and would also
    // trip gitleaks on entropy, which is a worse way to find out.
    for (const [, block] of jobs()) {
      for (const m of withoutComments(block).matchAll(new RegExp(`${KEY}:\\s*(\\S+)`, "g"))) {
        expect(m[1]).toBe("ci-placeholder-anon-key");
      }
    }
  });
});
