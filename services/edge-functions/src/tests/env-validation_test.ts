// US-777: boot-time env validation + feature-aware readiness.
import { assert, assertEquals, assertThrows } from "@std/assert";
import {
  assertRequiredEnv,
  computeFeatureReadiness,
  missingRequiredEnv,
} from "../lib/env-validation.ts";

// A fake env getter from a plain map.
function envOf(map: Record<string, string>): (k: string) => string | undefined {
  return (k) => map[k];
}

// The full set a healthy production deploy must have.
const PROD_OK: Record<string, string> = {
  SUPABASE_URL: "https://api.example.com",
  SUPABASE_SERVICE_ROLE_KEY: "svc",
  ANTHROPIC_API_KEY: "sk-ant",
  STRIPE_SECRET_KEY: "sk_live",
  STRIPE_WEBHOOK_SECRET: "whsec",
  FLIPDESK_INTERNAL_JOB_SECRET: "job",
  EDGE_ENCRYPTION_KEY: "enc",
  CERT_SIGNING_KEY: "cert",
  API_KEY_PEPPER: "pepper",
};

Deno.test("prod: a complete required set passes (no throw)", () => {
  assertRequiredEnv(envOf(PROD_OK), "production");
  assertEquals(missingRequiredEnv(envOf(PROD_OK), "production"), []);
});

Deno.test("prod: a missing CORE var crashes boot", () => {
  const env = { ...PROD_OK };
  delete env.SUPABASE_SERVICE_ROLE_KEY;
  assertThrows(
    () => assertRequiredEnv(envOf(env), "production"),
    Error,
    "SUPABASE_SERVICE_ROLE_KEY",
  );
});

Deno.test("prod: a missing prod-only var (CERT_SIGNING_KEY) crashes boot", () => {
  const env = { ...PROD_OK };
  delete env.CERT_SIGNING_KEY;
  assertThrows(() => assertRequiredEnv(envOf(env), "production"), Error, "CERT_SIGNING_KEY");
});

Deno.test("Anthropic accepts either name (CLAUDE_API_KEY satisfies it)", () => {
  const env = { ...PROD_OK };
  delete env.ANTHROPIC_API_KEY;
  env.CLAUDE_API_KEY = "sk-ant";
  assertEquals(missingRequiredEnv(envOf(env), "production"), []);
});

Deno.test("dev: permissive — minimal vars boot without throwing", () => {
  const env = { SUPABASE_URL: "x", SUPABASE_SERVICE_ROLE_KEY: "y" };
  // Missing Anthropic + all prod-required, but dev mode must NOT throw.
  assertRequiredEnv(envOf(env), "development");
  // prod-required vars are NOT demanded outside production.
  assertEquals(missingRequiredEnv(envOf(env), "development"), ["ANTHROPIC_API_KEY"]);
});

Deno.test("feature readiness: a fully-configured feature is 'ok', a gap names the missing var", () => {
  const env = {
    SMTP_HOST: "h", SMTP_USER: "u", SMTP_PASS: "p", SMTP_ADMIN_EMAIL: "a@b.c",
    EBAY_APP_ID: "1", EBAY_CERT_ID: "2", EBAY_DEV_ID: "3", // EBAY_VERIFICATION_TOKEN missing
  };
  const r = computeFeatureReadiness(envOf(env));
  assertEquals(r.smtp, "ok");
  assert(r.ebay.includes("missing"));
  assert(r.ebay.includes("EBAY_VERIFICATION_TOKEN"));
  // A wholly-unconfigured group still reports cleanly (not "ok").
  assert(r.google_photos.startsWith("missing:"));
});

Deno.test("a degraded feature group never makes the env REQUIRED check fail", () => {
  // PROD_OK has zero feature-group vars, yet required env is complete.
  assertEquals(missingRequiredEnv(envOf(PROD_OK), "production"), []);
  const r = computeFeatureReadiness(envOf(PROD_OK));
  assert(r.ebay.startsWith("missing:")); // degraded…
  // …but assertRequiredEnv still passes (boot proceeds).
  assertRequiredEnv(envOf(PROD_OK), "production");
});
