// US-2038 AC3, class (b): a money/cert integration suite must not SILENTLY skip
// where it was supposed to run.
//
// Five suites gate on integration fixtures — credit-refund, ledger-consistency,
// ai-quota-concurrency, public-certificate, passport-claim. (COUNT CORRECTED
// 2026-09-11, US-3368: eight files call this function now, the three added
// since being ledger-append-only, sync-review-lands and grade-outcome-lands,
// and thirteen edge test files are fixture-gated by any mechanism. Count them
// with scripts/integration-lane-coverage.test.mjs rather than trusting this
// sentence.) Each one prints
// "[name] SKIPPED — set ..." and passes when the fixture is absent, and in a CI
// summary a skip and a pass are indistinguishable. That is how all 11 of their
// assertions — including ledger-consistency_test.ts, the credit-ledger balance
// invariant and the most load-bearing money assertion in the repo — stayed
// invisible for months while every workflow reported green.
//
// ── STATUS: the job now exists ──
//
// .github/workflows/money-cert-integration.yml boots a throwaway local Supabase
// stack, seeds the fixture (scripts/seed-money-cert-fixture.ts), starts the edge
// service and runs all five with INTEGRATION_TESTS_REQUIRED=1. So this file is
// no longer waiting on a decision; it is what makes that job honest.
//
// Do not re-read the old framing from the history: AC2 was recorded twice as
// "needs credentials I do not have", and that was wrong. These suites never
// needed production — they need a schema and rows they may destroy, which is
// what `supabase start` gives you, and which is SAFER than prod because every
// one of them mutates its subject.
//
// ── What this file is for ──
//
// Without it the job could be stood up with one env var typo'd and report
// success forever, asserting nothing — the same defect one layer up. With it, a
// missing fixture in a lane that declared it would run these is a loud
// module-load failure naming the variable. Behaviour OUTSIDE that lane is
// unchanged: no flag, no fixture, quiet skip, exactly as before.
//
// Mirrors the two patterns the repo already uses: tenant-isolation_test.ts
// (TENANT_ISOLATION_REQUIRED=1) and src/test/dist-required.ts (US-2038 class a).
//
// NOTE the opposite default to dist-required.ts, and it is deliberate. dist/ is
// opt-OUT (required in CI unless disabled) because every CI lane builds. These
// fixtures are opt-IN (required only when a lane says so) because most lanes
// legitimately cannot reach a database, and a default that reddens every
// unrelated PR would simply get switched off — which is how anti-skip guards die.

/** True when a missing integration fixture should FAIL rather than skip. */
export function integrationIsRequired(
  get: (k: string) => string | undefined = (k) => Deno.env.get(k),
): boolean {
  const raw = (get("INTEGRATION_TESTS_REQUIRED") ?? "").trim().toLowerCase();
  return raw === "1" || raw === "true";
}

/**
 * Report a suite's fixture state, and refuse to skip quietly where the lane
 * declared it would run.
 *
 * Throws at MODULE LOAD rather than inside a test, for the same reason
 * dist-required.ts does: a thrown suite is a loud red file, whereas a failing
 * assertion inside a suite that reported "0 tests" is easy to scroll past.
 *
 * @param suite   short name used in the message, e.g. "ledger-consistency"
 * @param vars    the env var names this suite needs, for an actionable message
 * @param configured whether they are all present
 * @returns true when the suite should run
 */
export function requireIntegrationFixtures(
  suite: string,
  vars: readonly string[],
  configured: boolean,
  get: (k: string) => string | undefined = (k) => Deno.env.get(k),
): boolean {
  if (configured) return true;

  const missing = vars.filter((v) => !(get(v) ?? "").trim());
  const detail = missing.length > 0 ? missing.join(", ") : vars.join(", ");

  if (integrationIsRequired(get)) {
    throw new Error(
      `[${suite}] INTEGRATION_TESTS_REQUIRED=1 but the fixtures are missing: ` +
        `${detail}. This lane declared it would run the money/cert integration ` +
        `suites, so a skip here would be a silent loss of the assertion — ` +
        `see US-2038.`,
    );
  }

  // US-3368 AC3: a console.warn is a log line nobody scrolls back to, and the
  // summary deno prints for a fully-gated file is
  //
  //   ok | 0 passed | 0 failed | 3 ignored
  //
  // which is exactly what a suite that did nothing wrong looks like. There is
  // no red, no annotation and no line in the job summary, so "this assertion
  // did not execute" and "this assertion held" render identically on the
  // dashboard. That is the same defect one layer up from the one this file was
  // written for.
  //
  // `::warning::` is the one thing a step can print that the runner lifts OUT
  // of the log and onto the job's Annotations panel and the run summary. So a
  // lane that skips an integration suite now says so where the result is read,
  // not only where the log is.
  //
  // Deliberately stdout via console.log, not the console.warn below: the runner
  // parses workflow commands out of the step's output, and keeping the machine
  // line and the human line on separate streams means a future change to either
  // cannot swallow the other. Gated on GITHUB_ACTIONS so a developer machine
  // still sees plain prose and not runner syntax.
  if ((get("GITHUB_ACTIONS") ?? "").trim() === "true") {
    console.log(
      `::warning title=Integration suite skipped::${suite} did not run in this ` +
        `job: ${detail} not set. Its database assertions did not execute.`,
    );
  }

  console.warn(
    `[${suite}] SKIPPED — set ${vars.join(" + ")} to run this suite. ` +
      `(Set INTEGRATION_TESTS_REQUIRED=1 to make this a hard failure.)`,
  );
  return false;
}
