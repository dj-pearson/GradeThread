// US-1421: negotiation scope-gate behavior — the pure body pick that decides
// whether a /sell/negotiation 403 reads as "reconnect required" (deployment
// requests the scope; THIS token predates the grant — re-consent fixes it) or
// "feature unavailable" (the deployment doesn't request it; nothing the
// seller can do).
import { assert, assertEquals } from "@std/assert";

Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);

const { negotiationScope403Body } = await import("../routes/flipdesk-ebay.ts");

Deno.test("US-1421: scope 403 with the deployment scoped = reconnect_required", () => {
  const body = negotiationScope403Body(true);
  assertEquals(body.code, "reconnect_required");
  assert(body.error.toLowerCase().includes("reconnect"), "copy must name the fix");
});

Deno.test("US-1421: scope 403 without the deployment scope = feature_unavailable", () => {
  const body = negotiationScope403Body(false);
  assertEquals(body.code, "feature_unavailable");
});
