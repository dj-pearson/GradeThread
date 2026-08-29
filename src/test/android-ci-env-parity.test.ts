// US-2902: every workflow job that runs the app's Gradle tasks needs the
// BuildConfig env, and one of them did not have it.
//
// WHAT THIS CAUGHT. `build-and-test` carries `env: SUPABASE_ANON_KEY:
// ci-placeholder-anon-key`, added when 161 unit tests died in setup: the Hilt
// graph constructs SupabaseShared, which asserts the field is non-blank, and a
// runner has no local.properties for `secret()` to fall back to. The
// `instrumented` job runs the same app on an emulator and never got the block.
// Every instrumented run since died in Application.onCreate with
// "SUPABASE_ANON_KEY missing", all its tests reported FAILED for one missing
// string, and `continue-on-error: true` reported the workflow green anyway.
//
// The cost was not the tests. RoomMigrationTest is the only thing in the repo
// that proves a Room migration runs against real SQLite, the workflow tells
// people to read that job before any schema bump, and it had never executed.
//
// WHY A GUARD AND NOT JUST THE FIX. The fix is one env block, and the identical
// omission had already happened once per job that existed. The failure mode is
// not a missing-variable error at the top of the log — it is the app crashing at
// launch, which reads like a broken app rather than a broken workflow.
//
// ⚠ AND THE FIRST VERSION OF THIS GUARD READ ONE FILE. Within the day a second
// workflow that runs `./gradlew` appeared (android-dependency-drift.yml, US-2906
// AC5) and was not covered. Hardcoding the filename reproduced the exact bug
// this exists for: a rule that covers the case someone remembered and not the
// next one. It now walks the whole workflow directory.

import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const WORKFLOW_DIR = join(process.cwd(), ".github", "workflows");
const KEY = "SUPABASE_ANON_KEY";

const workflows = readdirSync(WORKFLOW_DIR)
  .filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"))
  .map((f) => ({
    file: f,
    yaml: readFileSync(join(WORKFLOW_DIR, f), "utf8").replace(/\r\n?/g, "\n"),
  }));

/**
 * Job blocks, keyed by name.
 *
 * Parsed by indentation rather than with a YAML library on purpose: the
 * question is "what does the block for this job contain", and a parsed tree
 * would answer it for `env` while losing the comments that say why the value is
 * what it is. Jobs sit at exactly two spaces under `jobs:`.
 */
function jobs(yaml: string): Map<string, string> {
  const out = new Map<string, string>();
  const lines = yaml.split("\n");
  const start = lines.findIndex((l) => l === "jobs:");
  if (start < 0) return out;
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

/** Comments stripped: the workflows NAME this variable while explaining it. */
const withoutComments = (s: string) => s.replace(/^\s*#.*$/gm, "");

/**
 * Does this job make the key available, by either of the two legitimate routes?
 *
 * ⚠ THERE ARE TWO, and knowing only one produced a false positive on the lane
 * that matters most. android-release.yml's `instrumented` and `release` jobs
 * carry no placeholder because they must not: they inject the REAL key and then
 * assert on it in shell, which fails the job with a better message than this
 * test could. A CI lane builds with a throwaway; a RELEASE lane doing that would
 * ship an app that crashes on launch for every user.
 *
 * So the rule is "the key is available", derived. An exclusion list naming the
 * release workflow would have worked today and rotted the moment a third lane
 * appeared — which is how this guard got its scope wrong once already.
 */
function keyIsAvailable(body: string): boolean {
  const declared = new RegExp(`^\\s*${KEY}:\\s*\\S`, "m").test(body);
  // The shell form: `: "${SUPABASE_ANON_KEY:?missing from env ...}"`.
  const assertedInShell = body.includes("${" + KEY + ":?");
  return declared || assertedInShell;
}

/**
 * Literal values from `env:` mappings only, never from a `run:` body.
 *
 * The value check reads what the key is SET to, and the shell assertion above
 * matches a naive `KEY:\s*(\S+)` and yields `?missing` — which is not a value
 * anyone set. An indented bare key followed by a value is a YAML mapping entry;
 * a shell line is not.
 */
function declaredValues(body: string): string[] {
  return [...body.matchAll(new RegExp(`^\\s{2,}${KEY}:[ \\t]+(\\S+)\\s*$`, "gm"))].map(
    (m) => m[1]!,
  );
}

describe("US-2902: no workflow job runs Gradle without the BuildConfig env", () => {
  it("finds the jobs it is meant to check", () => {
    // Guards the guard. A renamed job would silently drop out of the loop
    // below, and a loop over nothing passes exactly like a loop over
    // everything-correct.
    const ci = workflows.find((w) => w.file === "android-ci.yml");
    expect(ci, "android-ci.yml is gone — this guard is reading the wrong directory").toBeDefined();
    const names = [...jobs(ci!.yaml).keys()];
    expect(names).toContain("build-and-test");
    expect(names).toContain("instrumented");
  });

  it("every job that runs the app's Gradle tasks has the key available", () => {
    // Derived, not listed: a job qualifies by RUNNING gradle, so a new one is
    // covered the day it is written rather than the day someone remembers.
    const offenders: string[] = [];
    for (const { file, yaml } of workflows) {
      for (const [name, block] of jobs(yaml)) {
        const body = withoutComments(block);
        if (!/\.\/gradlew\s/.test(body)) continue;
        if (!keyIsAvailable(body)) offenders.push(`${file}:${name}`);
      }
    }
    expect(
      offenders,
      `these jobs run ./gradlew with no ${KEY} in their env and no shell assertion ` +
        "for it, so the app asserts at launch and every test in them fails for one " +
        "missing string",
    ).toEqual([]);
  });

  it("more than one job actually matched, so the rule is not vacuous", () => {
    const running = workflows.flatMap(({ yaml }) =>
      [...jobs(yaml)].filter(([, b]) => /\.\/gradlew\s/.test(withoutComments(b))),
    );
    expect(running.length, "no job runs ./gradlew — the parse is wrong").toBeGreaterThan(1);
  });

  it("a literal value is the placeholder, never a real key", () => {
    // The value is committed in plain text, so it has to stay obviously fake. A
    // real anon key here would be a secret in the repository and would also trip
    // gitleaks on entropy, which is a worse way to find out.
    //
    // A `${{ secrets.* }}` / `${{ env.* }}` expression is not a literal and is
    // how the release lane legitimately passes the real key.
    for (const { file, yaml } of workflows) {
      for (const [name, block] of jobs(yaml)) {
        for (const value of declaredValues(withoutComments(block))) {
          if (value.startsWith("${{")) continue;
          expect(value, `${file}:${name} sets a literal ${KEY}`).toBe("ci-placeholder-anon-key");
        }
      }
    }
  });
});
