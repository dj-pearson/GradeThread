// MeasureCard mail requests: who may ask for one (MC-01) and what an address
// has to look like before it is accepted (MC-02). Pure helpers plus the source
// contracts that pin which tenant's plan the route reads.
//
//   deno test --allow-env --allow-read src/tests/flipdesk-measure-card-request_test.ts

import { assert, assertEquals } from "@std/assert";

Deno.env.set(
  "SUPABASE_URL",
  Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321",
);
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);

const { cardRequestEligibility } = await import(
  "../routes/flipdesk-measure.ts"
);

const ROUTE = await Deno.readTextFile(
  new URL("../routes/flipdesk-measure.ts", import.meta.url),
);

// ── MC-01: eligibility comes from the OWNER's plan and the caller's role ─────

Deno.test("MC-01: a paid owner with no request may request a card", () => {
  assertEquals(
    cardRequestEligibility({ role: "owner", ownerPlan: "pro", latestStatus: null }),
    { can_request: true, reason: "ok" },
  );
});

Deno.test("MC-01: a free-plan owner's workspace is free_plan for every member", () => {
  // The member's OWN plan is not an input at all, which is the point: a paid
  // member of a free workspace used to see the form and then meet a 403.
  for (const role of ["owner", "admin", "listing_manager", "member"]) {
    assertEquals(
      cardRequestEligibility({ role, ownerPlan: "free", latestStatus: null }),
      { can_request: false, reason: "free_plan" },
    );
  }
  assertEquals(
    cardRequestEligibility({ role: "member", ownerPlan: null, latestStatus: null })
      .reason,
    "free_plan",
  );
});

Deno.test("MC-01: a viewer is refused whatever the plan", () => {
  assertEquals(
    cardRequestEligibility({ role: "viewer", ownerPlan: "pro", latestStatus: null }),
    { can_request: false, reason: "viewer" },
  );
  assertEquals(
    cardRequestEligibility({ role: "viewer", ownerPlan: "free", latestStatus: "requested" })
      .reason,
    "viewer",
  );
});

Deno.test("MC-01: an unshipped request blocks a second; a shipped one does not", () => {
  for (const s of ["requested", "exported"]) {
    assertEquals(
      cardRequestEligibility({ role: "owner", ownerPlan: "pro", latestStatus: s }),
      { can_request: false, reason: "active_request" },
    );
  }
  assertEquals(
    cardRequestEligibility({ role: "owner", ownerPlan: "pro", latestStatus: "shipped" }),
    { can_request: true, reason: "ok" },
  );
});

Deno.test("MC-01: GET /card-request reads the plan of the workspace owner", () => {
  const at = ROUTE.indexOf('flipdeskMeasureRoutes.get("/card-request"');
  assert(at > -1, "GET /card-request moved");
  const body = ROUTE.slice(at, ROUTE.indexOf("\n});", at));
  assert(body.includes('const ownerId = c.get("workspaceOwnerId") ?? c.get("userId");'));
  assert(/\.from\("users"\)[\s\S]*?\.eq\("id", ownerId\)/.test(body));
  assert(body.includes('role: c.get("workspaceRole")'));
  assert(body.includes("eligibility: cardRequestEligibility("));
});
