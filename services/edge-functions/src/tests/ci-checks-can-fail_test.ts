// US-2344: a CI check that cannot fail is worse than no check.
//
// Two of them were wired that way. `.github/workflows/ios-ci.yml` set
// `continue-on-error: true` on the entire UI-test job, and security.yml ran
// `deno coverage cov_profile || true`. Both appeared on the dashboard as green
// ticks, and neither could ever block anything — they occupied the slot a real
// check would take.
//
// The iOS one mattered more than it looked. iOS cannot be built or tested on the
// Windows dev host, so that macOS runner IS the safety net; wiring a safety net
// to ignore its own result makes it a decoration.
//
// THE DECISION WAS MADE ON EVIDENCE, and the evidence is recorded here so nobody
// has to re-gather it: over the last 14 runs on main (measured 2026-08-03) the
// UI-test job was 11 success, 2 failure, 1 cancelled — and BOTH failures were on
// runs where the blocking "Build + test" job failed too. It has never gone red
// on its own. It was not flaky; it was non-blocking. That also answers "quarantine
// the flaky cases": there is no independent failure to attribute to a case.
//
// These assertions are cheap and the thing they protect is a habit — re-adding
// `|| true` to unblock a build is a two-second edit that nobody reviews twice.

import { assert } from "@std/assert";

const WF = new URL("../../../../.github/workflows/", import.meta.url);
const read = (f: string) => Deno.readTextFileSync(new URL(f, WF));

Deno.test("US-2344: the iOS UI-test job can fail the build", () => {
  const src = read("ios-ci.yml");
  const at = src.indexOf("  ui-test:");
  assert(at > -1, "the ui-test job was renamed");
  // Only to the end of this job — a later job's own setting is not this test's
  // business.
  const nextJob = src.slice(at + 10).search(/\n {2}[a-z0-9-]+:\n/);
  const job = nextJob === -1 ? src.slice(at) : src.slice(at, at + 10 + nextJob);
  assert(
    !/^\s+continue-on-error:\s*true/m.test(job),
    "the UI-test job is non-blocking again. If a case turned flaky, quarantine " +
      "THAT CASE — restoring continue-on-error on the whole job is what put this " +
      "guard here.",
  );
});

Deno.test("US-2344: the edge coverage step is not swallowed", () => {
  const src = read("security.yml");
  // Anchored to a `run:` line, not to the text anywhere in the file: the step
  // above it explains what the old `|| true` did, and a bare substring scan
  // fires on that explanation. Third time in this session a guard has accused
  // its own prose — the fix is always to match the CONSTRUCT, not the words.
  const runLines = src
    .split("\n")
    .filter((l) => /^\s*(-\s*)?run:/.test(l) || /^\s{8,}deno coverage/.test(l));
  assert(
    !runLines.some((l) => /deno coverage[^\n]*\|\|\s*true/.test(l)),
    "`|| true` is back on the coverage step, so edge coverage is unenforced again",
  );
  assert(
    src.includes("scripts/coverage-floor.mjs"),
    "the coverage floor is no longer run in CI, so the script exists and " +
      "enforces nothing",
  );
});

Deno.test("US-2344: the floor script fails rather than warns", () => {
  // A floor that logs and exits 0 is the same defect one level down.
  const src = Deno.readTextFileSync(
    new URL("../../scripts/coverage-floor.mjs", import.meta.url),
  );
  assert(src.includes("Deno.exit(1)"), "the floor script cannot fail");
  assert(
    /if \(failed\)[\s\S]{0,400}Deno\.exit\(1\)/.test(src),
    "falling below the floor no longer exits non-zero",
  );
  // An empty profile must fail too. Reporting 0% as a catastrophic regression
  // would be wrong, but passing it silently is worse — it is what a test run
  // that never happened looks like.
  assert(
    /branch === 0 && fn === 0 && line === 0[\s\S]{0,400}Deno\.exit\(1\)/.test(src),
    "an empty coverage profile no longer fails, so a skipped test run reads as " +
      "a pass",
  );
});

Deno.test("US-2344: the floors are set below the measurement, not aspirationally", () => {
  // A floor above the current number blocks on day one and gets lowered, which
  // is how a floor becomes decoration. The comment records the measurement it
  // was set from; this asserts the relationship still holds.
  const src = Deno.readTextFileSync(
    new URL("../../scripts/coverage-floor.mjs", import.meta.url),
  );
  const m = /const FLOORS = \{ branch: (\d+), function: (\d+), line: (\d+) \}/.exec(src);
  assert(m, "the FLOORS constant is gone");
  const [, b, f, l] = m.map(Number);
  // Measured 2026-08-03: branch 86.3, function 62.5, line 49.4.
  assert(b! <= 86 && f! <= 62 && l! <= 49, "a floor was raised above the last measurement");
  // And not to zero, which would be the same as no floor.
  assert(b! > 0 && f! > 0 && l! > 0, "a floor was set to zero");
});
