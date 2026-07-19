// US-2038 AC3, class (b): a money/cert integration suite must not SILENTLY skip
// where it was supposed to run.
//
// Five suites gate on integration fixtures — credit-refund, ledger-consistency,
// ai-quota-concurrency, public-certificate, passport-claim — and grepping
// .github/workflows for TEST_SUPABASE_URL / TEST_LEDGER_USER_ID / TEST_CERT_ID /
// TEST_GARMENT_ID returns nothing. There is no CI job for any of them.
// ledger-consistency_test.ts asserts the credit-ledger balance invariant,
// arguably the single most important money assertion in the repo, and it has
// never run anywhere but a developer's machine.
//
// Each one prints "[name] SKIPPED — set ..." and passes. In a CI summary a skip
// and a pass are indistinguishable, which is exactly how five money-path suites
// stayed invisible while the workflow reported green.
//
// ── What this file does, and deliberately does NOT do ──
//
// AC2 ("stand up a job that provides the env vars, or delete those suites") is a
// DECISION, not a task: standing up the job needs credentials, and deleting
// money-path tests is not a unilateral call. This file does not pre-empt it.
//
// What it does is make that decision STICK once taken. Today, with no job and no
// flag, behaviour is byte-for-byte unchanged — the suites skip exactly as they
// did. The moment a job sets INTEGRATION_TESTS_REQUIRED=1, a missing fixture
// becomes a loud module-load failure naming the variable, instead of a green
// skip. Without this, AC2's job could be stood up with one env var typo'd and
// report success forever, which is the same defect one layer up.
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

  console.warn(
    `[${suite}] SKIPPED — set ${vars.join(" + ")} to run this suite. ` +
      `(Set INTEGRATION_TESTS_REQUIRED=1 to make this a hard failure.)`,
  );
  return false;
}
