// US-2038 AC3 (class b): the anti-skip guard for the money/cert integration
// suites. This is the guard's own guard — if it silently returns false in a lane
// that set INTEGRATION_TESTS_REQUIRED=1, five money-path suites go back to being
// invisible and nothing says so.

import { assert, assertEquals, assertThrows } from "@std/assert";
import {
  integrationIsRequired,
  requireIntegrationFixtures,
} from "./integration-required.ts";

const envOf = (m: Record<string, string>) => (k: string) => m[k];

Deno.test("US-2038: required only when explicitly opted IN", () => {
  // Opposite default to dist-required.ts, deliberately: most CI lanes cannot
  // reach a database, and a guard that reddens every unrelated PR gets switched
  // off — which is how anti-skip guards die.
  assertEquals(integrationIsRequired(envOf({})), false);
  assertEquals(integrationIsRequired(envOf({ CI: "true" })), false);
  assertEquals(integrationIsRequired(envOf({ INTEGRATION_TESTS_REQUIRED: "1" })), true);
  assertEquals(integrationIsRequired(envOf({ INTEGRATION_TESTS_REQUIRED: "true" })), true);
  assertEquals(integrationIsRequired(envOf({ INTEGRATION_TESTS_REQUIRED: "0" })), false);
});

Deno.test("US-2038: configured fixtures always run, flag or not", () => {
  assertEquals(requireIntegrationFixtures("s", ["A"], true, envOf({})), true);
  assertEquals(
    requireIntegrationFixtures("s", ["A"], true, envOf({ INTEGRATION_TESTS_REQUIRED: "1" })),
    true,
  );
});

Deno.test("US-2038: missing fixtures skip quietly when no lane claims them", () => {
  // Unchanged behaviour for a developer machine — this is what keeps the change
  // byte-for-byte safe to land before AC2's job exists.
  assertEquals(requireIntegrationFixtures("s", ["A"], false, envOf({})), false);
});

Deno.test("US-2038: missing fixtures THROW when the lane declared it runs them", () => {
  const err = assertThrows(
    () =>
      requireIntegrationFixtures(
        "ledger-consistency",
        ["TEST_SUPABASE_URL", "TEST_LEDGER_USER_ID"],
        false,
        envOf({ INTEGRATION_TESTS_REQUIRED: "1", TEST_SUPABASE_URL: "https://x" }),
      ),
    Error,
  );
  const msg = String(err);
  // The message has to be actionable: which suite, and which var is absent.
  assert(msg.includes("ledger-consistency"), "must name the suite");
  assert(msg.includes("TEST_LEDGER_USER_ID"), "must name the MISSING var");
  assert(
    !msg.includes("TEST_SUPABASE_URL:"),
    "must not blame a var that is actually present",
  );
});

Deno.test("US-2038: a blank env var counts as missing, not as set", () => {
  // A CI secret that failed to resolve expands to "" rather than being absent.
  // Treating that as configured is precisely how a job reports green while
  // asserting nothing.
  assertThrows(() =>
    requireIntegrationFixtures(
      "credit-refund",
      ["TEST_SUPABASE_URL"],
      false,
      envOf({ INTEGRATION_TESTS_REQUIRED: "1", TEST_SUPABASE_URL: "   " }),
    ),
  );
});
