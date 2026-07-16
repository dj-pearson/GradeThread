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

const { negotiationScope403Body, negotiationCapability } = await import(
  "../routes/flipdesk-ebay.ts"
);

Deno.test("US-1421: scope 403 with the deployment scoped = reconnect_required", () => {
  const body = negotiationScope403Body(true);
  assertEquals(body.code, "reconnect_required");
  assert(body.error.toLowerCase().includes("reconnect"), "copy must name the fix");
});

Deno.test("US-1421: scope 403 without the deployment scope = feature_unavailable", () => {
  const body = negotiationScope403Body(false);
  assertEquals(body.code, "feature_unavailable");
});

// US-1967: clients gate their send-offer entry point on this, so an unlicensed
// deployment must resolve to "unavailable" BEFORE any eBay round trip.
Deno.test("US-1967: no deployment scope = send-offer unavailable, not reconnectable", () => {
  const cap = negotiationCapability(false, false);
  assertEquals(cap.send_offer_available, false);
  assertEquals(cap.code, "feature_unavailable");
  assert(cap.detail, "an unavailable capability must carry seller-facing copy");
  // The whole point of US-1967: never tell a seller to reconnect when
  // reconnecting cannot possibly help.
  assert(
    !cap.detail!.toLowerCase().includes("reconnect"),
    "unlicensed deployment must not suggest reconnecting",
  );
});

Deno.test("US-1967: a denied token under a scoped deployment = reconnect_required", () => {
  const cap = negotiationCapability(true, true);
  assertEquals(cap.send_offer_available, false);
  assertEquals(cap.code, "reconnect_required");
  assert(cap.detail!.toLowerCase().includes("reconnect"), "copy must name the fix");
});

Deno.test("US-1967: scoped deployment + healthy token = send-offer available", () => {
  const cap = negotiationCapability(true, false);
  assertEquals(cap.send_offer_available, true);
  assertEquals(cap.code, null);
  assertEquals(cap.detail, null);
});

// The deployment gate dominates: a stale denial flag must never resurrect the
// feature, and must never downgrade the honest "unavailable" to "reconnect".
Deno.test("US-1967: deployment gate dominates a stale denial flag", () => {
  assertEquals(negotiationCapability(false, true).code, "feature_unavailable");
});
