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

const {
  cardRequestEligibility,
  validateMailAddress,
  MAIL_FIELD_LIMITS,
  STATE_REQUIRED_COUNTRIES,
} = await import(
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

// ── MC-02: refuse, never shorten ─────────────────────────────────────────────

const GOOD = {
  ship_name: "Pat Doe",
  address_line1: "1 Main St",
  address_line2: "",
  city: "Austin",
  state: "TX",
  postal_code: "78701",
  country: "us",
};

Deno.test("MC-02: a valid address passes, trimmed and uppercased, not sliced", () => {
  const r = validateMailAddress({ ...GOOD, city: "  Austin  " });
  assert(r.ok);
  assertEquals(r.value.city, "Austin");
  assertEquals(r.value.country, "US");
  assertEquals(r.value.address_line2, "");
});

Deno.test("MC-02: a 250-character address line is refused and named", () => {
  const r = validateMailAddress({ ...GOOD, address_line1: "a".repeat(250) });
  assert(!r.ok);
  assertEquals(r.fields?.address_line1, "max 200 characters");
});

Deno.test("MC-02: one character over each limit is refused; exactly at it passes", () => {
  for (const [key, max] of Object.entries(MAIL_FIELD_LIMITS)) {
    const at = validateMailAddress({ ...GOOD, [key]: "x".repeat(max) });
    assert(at.ok, `${key} at ${max} should pass`);
    const over = validateMailAddress({ ...GOOD, [key]: "x".repeat(max + 1) });
    assert(!over.ok, `${key} at ${max + 1} should be refused`);
    assertEquals(over.fields?.[key], `max ${max} characters`);
  }
});

Deno.test("MC-02: 'United Kingdom' is a malformed code, not an unsupported country", () => {
  const r = validateMailAddress({ ...GOOD, country: "United Kingdom" });
  assert(!r.ok);
  assert(r.error.includes("two-letter code"), r.error);
  assert(!r.error.includes("print-at-home"));
  // A well-formed code we do not post to still gets the helpful message.
  const fr = validateMailAddress({ ...GOOD, country: "FR" });
  assert(!fr.ok);
  assert(fr.error.includes("print-at-home"));
});

Deno.test("MC-02: formula-looking names and address lines are refused", () => {
  for (const bad of ["=HYPERLINK(\"http://x\",\"y\")", "+1", "-2", "@SUM(A1)"]) {
    for (const key of ["ship_name", "address_line1", "address_line2", "city"]) {
      const r = validateMailAddress({ ...GOOD, [key]: bad });
      assert(!r.ok, `${key}=${bad} should be refused`);
      assert(r.fields?.[key], `${key} should be named`);
    }
  }
  // A hyphen inside a value is fine.
  assert(validateMailAddress({ ...GOOD, ship_name: "Mary-Jane O'Neil" }).ok);
});

Deno.test("MC-02: the POST no longer slices fields", () => {
  const at = ROUTE.indexOf('flipdeskMeasureRoutes.post("/card-request"');
  const body = ROUTE.slice(at, ROUTE.indexOf("\n});", at));
  assert(!body.includes(".slice(0, max)"));
  assert(body.includes("validateMailAddress(body)"));
  assert(body.includes("fields: checked.fields"));
});

// ── MC-08: state only where an address has one ─────────────────────────────

Deno.test("MC-08: state is required for US, CA and AU only", () => {
  assertEquals([...STATE_REQUIRED_COUNTRIES], ["US", "CA", "AU"]);
  for (const country of ["US", "CA", "AU"]) {
    const r = validateMailAddress({ ...GOOD, country, state: "" });
    assert(!r.ok, `${country} without a state should be refused`);
    assert(r.error.includes("state"));
  }
  for (const country of ["GB", "IE", "NZ"]) {
    const r = validateMailAddress({ ...GOOD, country, state: "" });
    assert(r.ok, `${country} without a state should pass`);
    assertEquals(r.value.state, "");
  }
});
