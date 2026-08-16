// A BLANK EDGE_ENV must not stop the service believing it is in production.
//
// FOUND 2026-08-16 while reading features.pages_origin_bypass for US-2612.
// `edgeEnv()` was `Deno.env.get("EDGE_ENV") ?? Deno.env.get("DENO_ENV") ??
// "production"`, and `??` falls through on null/undefined but NEVER on an empty
// string. So `EDGE_ENV=` — a blank field in the Coolify UI, or a trailing `=`
// in an env file — resolved to `""`, which is not "production".
//
// Measured, not argued:
//
//   EDGE_ENV absent → missingRequiredEnv() = [STRIPE_SECRET_KEY,
//                     STRIPE_WEBHOOK_SECRET, FLIPDESK_INTERNAL_JOB_SECRET,
//                     EDGE_ENCRYPTION_KEY, CERT_SIGNING_KEY, API_KEY_PEPPER]
//   EDGE_ENV=""     → missingRequiredEnv() = []
//
// So the blank value made /health/ready report READY with none of those
// secrets, disabled the pages_origin_bypass reporting US-2612 waits on, made
// isProduction() false wherever it gates behaviour, and short-circuited
// assertAdminMfaConfig — the boot check that refuses to start with admin MFA
// off.
//
// Same defect as the release identity had (lib/release-identity.ts states the
// rule: fall through on a placeholder VALUE, not merely on an unset key). That
// fix never reached this module, and the two are three files apart.
import { assertEquals, assertThrows } from "@std/assert";
import { assertAdminMfaConfig, resolveEdgeEnv } from "../lib/env.ts";

const get = (env: Record<string, string>) => (k: string) => env[k];

Deno.test("a blank EDGE_ENV resolves to production, like an absent one", () => {
  assertEquals(resolveEdgeEnv(get({})), "production");
  assertEquals(resolveEdgeEnv(get({ EDGE_ENV: "" })), "production");
  assertEquals(resolveEdgeEnv(get({ EDGE_ENV: "   " })), "production");
});

Deno.test("a blank EDGE_ENV falls through to DENO_ENV before defaulting", () => {
  // Order still matters: an explicit DENO_ENV should win over the default,
  // exactly as it did before, or a staging box silently becomes production.
  assertEquals(resolveEdgeEnv(get({ EDGE_ENV: "", DENO_ENV: "staging" })), "staging");
  assertEquals(resolveEdgeEnv(get({ DENO_ENV: "test" })), "test");
});

Deno.test("an explicit value still wins, and is normalised", () => {
  assertEquals(resolveEdgeEnv(get({ EDGE_ENV: "test" })), "test");
  assertEquals(resolveEdgeEnv(get({ EDGE_ENV: "  PRODUCTION  " })), "production");
  // EDGE_ENV beats DENO_ENV when both are real.
  assertEquals(resolveEdgeEnv(get({ EDGE_ENV: "test", DENO_ENV: "production" })), "test");
});

Deno.test("a blank EDGE_ENV cannot skip the admin-MFA boot assertion", () => {
  // The check exists to refuse to boot with admin MFA disabled in production.
  // It carried its own copy of the `??` chain, so a blank value returned early
  // and it simply did not run.
  assertThrows(
    () => assertAdminMfaConfig(get({ EDGE_ENV: "", ADMIN_MFA_ENFORCED: "false" })),
    Error,
    "Refusing to start",
  );
  // …and the deliberate escape hatch still works, so this is not a tightening
  // of the enrollment window.
  assertAdminMfaConfig(
    get({ EDGE_ENV: "", ADMIN_MFA_ENFORCED: "false", ADMIN_MFA_ENROLLMENT_WINDOW: "true" }),
  );
});
