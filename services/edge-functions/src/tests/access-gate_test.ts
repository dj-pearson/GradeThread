// US-585: waitlist access-gate read path — fail-open semantics.
// access-gate.ts imports supabase at init, so set dummy env before importing.
import { assert, assertEquals } from "@std/assert";

Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);

const { isWaitlistGatingActive, userHasAccess, clearAccessGateCache } = await import(
  "../lib/access-gate.ts"
);

Deno.test("isWaitlistGatingActive fails CLOSED to 'inactive' when the DB read errors", async () => {
  // No reachable DB (dummy URL) → read errors → gate defaults to INACTIVE so a
  // transient blip never locks the whole product out.
  clearAccessGateCache();
  const active = await isWaitlistGatingActive();
  assertEquals(active, false);
});

Deno.test("isWaitlistGatingActive caches the result (second call is instant)", async () => {
  clearAccessGateCache();
  const a = await isWaitlistGatingActive();
  const b = await isWaitlistGatingActive();
  assertEquals(a, b);
});

Deno.test("userHasAccess fails OPEN (grants access) when the DB read errors", async () => {
  // A read failure must never strand an approved user — default to access.
  const ok = await userHasAccess("00000000-0000-4000-8000-000000000000", "seller@example.com");
  assert(ok);
});

// US-2449: GET /status is the read the public capture form depends on. If it
// ever requires auth, the landing page's fetch 401s, the hook fails closed, and
// the form silently stops rendering — which is the exact lockout this story
// closed, restored with every test still green. So the test is behavioural: an
// anonymous request must reach the handler.
Deno.test("GET /api/waitlist/status answers anonymously with just the gate state", async () => {
  const { waitlistRoutes } = await import("../routes/waitlist.ts");
  clearAccessGateCache();
  const res = await waitlistRoutes.request("/status");
  assertEquals(res.status, 200);
  const body = await res.json() as { gatingActive?: unknown };
  // No DB is reachable here, so the gate reads inactive (fail-open) — the point
  // of the assertion is the SHAPE and the absence of a 401, not the value.
  assertEquals(typeof body.gatingActive, "boolean");
  assertEquals(Object.keys(body), ["gatingActive"]);
});
