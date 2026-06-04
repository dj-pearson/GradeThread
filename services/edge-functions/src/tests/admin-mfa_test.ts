// US-357: admin MFA gate decision + startup-assertion unit tests.
// admin-auth.ts transitively imports the service-role supabase client, which
// throws at module init without env — set dummy creds BEFORE the dynamic import
// (mirrors ai-photo-qa_test / grading-monitor_test). (US-510: keeps the suite
// green so the CI test gate is trustworthy.)
import { assert, assertEquals, assertThrows } from "@std/assert";
import type { AuthAssuranceClaims } from "../lib/jwt-claims.ts";

Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);

const { adminMfaBlocked } = await import("../middleware/admin-auth.ts");
const { assertAdminMfaConfig } = await import("../lib/env.ts");

const aal2: AuthAssuranceClaims = { aal: "aal2", amr: [{ method: "totp", timestamp: 1 }] };
const aal1: AuthAssuranceClaims = { aal: "aal1", amr: [{ method: "password", timestamp: 1 }] };

Deno.test("adminMfaBlocked: aal1 admin token is BLOCKED when enforced", () => {
  assertEquals(adminMfaBlocked(aal1, true), true);
});

Deno.test("adminMfaBlocked: missing claims are BLOCKED when enforced (fail-closed)", () => {
  assertEquals(adminMfaBlocked(undefined, true), true);
});

Deno.test("adminMfaBlocked: aal2 token is allowed when enforced", () => {
  assertEquals(adminMfaBlocked(aal2, true), false);
});

Deno.test("adminMfaBlocked: enforcement off allows even aal1 (enrollment window)", () => {
  assertEquals(adminMfaBlocked(aal1, false), false);
  assertEquals(adminMfaBlocked(undefined, false), false);
});

// ── startup assertion ────────────────────────────────────────────────────────

function envFrom(map: Record<string, string>) {
  return (k: string) => map[k];
}

Deno.test("assertAdminMfaConfig: THROWS in prod when MFA disabled w/o enrollment window", () => {
  assertThrows(
    () => assertAdminMfaConfig(envFrom({ EDGE_ENV: "production", ADMIN_MFA_ENFORCED: "false" })),
    Error,
    "Refusing to start",
  );
});

Deno.test("assertAdminMfaConfig: allows disabled MFA in prod with explicit enrollment window", () => {
  const original = console.error;
  let warned = "";
  console.error = (...a: unknown[]) => {
    warned = a.join(" ");
  };
  try {
    assertAdminMfaConfig(envFrom({
      EDGE_ENV: "production",
      ADMIN_MFA_ENFORCED: "false",
      ADMIN_MFA_ENROLLMENT_WINDOW: "true",
    }));
  } finally {
    console.error = original;
  }
  assert(warned.includes("enrollment window"), warned);
});

Deno.test("assertAdminMfaConfig: no-op when enforced in prod", () => {
  assertAdminMfaConfig(envFrom({ EDGE_ENV: "production", ADMIN_MFA_ENFORCED: "true" }));
  // defaults to enforced when unset
  assertAdminMfaConfig(envFrom({ EDGE_ENV: "production" }));
});

Deno.test("assertAdminMfaConfig: no-op outside production even if disabled", () => {
  assertAdminMfaConfig(envFrom({ EDGE_ENV: "development", ADMIN_MFA_ENFORCED: "false" }));
});
