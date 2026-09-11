// US-3265: creating the three business policies a first-time seller has none of.
//
//   deno test --allow-read --allow-env src/tests/ebay-policy-create_test.ts
//
// The client function itself talks to eBay, so what is testable without a
// seller token is the SHAPE of what it sends and the rules around it. That is
// also where this can go wrong in a way nobody notices: eBay accepts a policy
// with a missing field and then refuses the publish that uses it, which lands
// as "invalid shipping policy" days later on the seller's first sale.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";

const ROOT = new URL("../", import.meta.url);
const read = (p: string) => Deno.readTextFileSync(new URL(p, ROOT));

const CLIENT = read("lib/ebay-client.ts");
const ROUTE = read("routes/flipdesk-ebay.ts");

// The body of one route handler, bounded by the NEXT route registration rather
// than by a character count. A fixed slice quietly stops covering the end of a
// handler the moment the handler grows, which turns a real assertion into a
// test that passes because it is looking at nothing.
function routeBody(start: string): string {
  const idx = ROUTE.indexOf(start);
  assert(idx > 0, `route not found: ${start}`);
  const next = ROUTE.indexOf("flipdeskEbayRoutes.", idx + start.length);
  return ROUTE.slice(idx, next > idx ? next : undefined);
}

const CREATE_ROUTE = routeBody('flipdeskEbayRoutes.post("/policies/create"');

Deno.test("all three policy kinds are POSTed, not just read", () => {
  // Before this the client had four GETs on /sell/account/v1 and no POST to any
  // policy endpoint, which is the whole defect: FlipDesk read the policies, opted
  // the account into managing them, created the merchant location, and then sent
  // the seller to eBay to make the policies by hand.
  for (const kind of ["fulfillment", "payment", "return"]) {
    assertStringIncludes(CLIENT, `${kind}_policy`);
  }
  assertStringIncludes(CLIENT, "export async function createDefaultPolicies");
  assertStringIncludes(CLIENT, `method: "POST"`);
});

Deno.test("a duplicate name is treated as a re-run, not a failure", () => {
  // eBay answers 20400 for a name that already exists. Failing there would mean
  // a seller who pressed the button twice, or whose first press half-succeeded,
  // could never finish -- and creating a SECOND policy would leave them choosing
  // between two identical ones.
  assertStringIncludes(CLIENT, "20400");
  assertStringIncludes(CLIENT, "findPolicyIdByName");
});

Deno.test("only the missing policies are created", () => {
  // An account with its own shipping policy from years ago keeps it. `have` is
  // the set of kinds already present and each branch is guarded on it.
  for (const kind of ["fulfillment", "payment", "return"]) {
    assertStringIncludes(CLIENT, `if (!have.has("${kind}"))`);
  }
});

Deno.test("the fulfillment policy carries a handling time and a real service", () => {
  // A fulfillment policy with no shippingServices is accepted by the Account
  // API and then rejected at publish.
  assertStringIncludes(CLIENT, "handlingTime:");
  assertStringIncludes(CLIENT, "shippingServices:");
  assertStringIncludes(CLIENT, "shippingCarrierCode");
  assertStringIncludes(CLIENT, "freeShipping: free");
});

Deno.test("free shipping sends no shippingCost at all", () => {
  // eBay refuses a service that is both free and priced. The spread is
  // conditional rather than sending a zero.
  assertStringIncludes(CLIENT, "...(free ? {} : {");
});

Deno.test("the route opts the account into policy management first", () => {
  // eBay refuses policy writes on an account outside SELLING_POLICY_MANAGEMENT,
  // with an error naming neither the program nor the fix.
  const body = CREATE_ROUTE;
  assertStringIncludes(body, 'optInToProgram(ownerId, "SELLING_POLICY_MANAGEMENT")');
  assertStringIncludes(body, "isAlreadyInProgramStateError");
  // And the opt-in comes before the creation.
  assert(
    body.indexOf("optInToProgram") < body.indexOf("createDefaultPolicies"),
    "the policies are created before the account is opted in",
  );
});

Deno.test("the route is tenant-scoped and validates every answer", () => {
  const body = CREATE_ROUTE;
  assertStringIncludes(body, 'c.get("workspaceOwnerId") ?? c.get("userId")');
  // Four answers, four refusals. A handling time of 400 days or a negative
  // shipping cost is a 400 here rather than an eBay error later.
  assertStringIncludes(body, "handlingDays > 30");
  assertStringIncludes(body, "shippingCostCents < 0");
  assertStringIncludes(body, "returnDays !== 30 && returnDays !== 60");
});

Deno.test("an account that already has all three is left alone", () => {
  const body = CREATE_ROUTE;
  assertStringIncludes(body, "if (have.size === 3)");
});

Deno.test("defaults are written through the one existing writer", () => {
  // setDefaultPolicies is what the picker uses. A second way to set a default
  // is how the two disagree later.
  const body = CREATE_ROUTE;
  assertStringIncludes(body, "await setDefaultPolicies(ownerId, selection)");
  assertEquals(body.split("setDefaultPolicies(").length - 1, 1);
});

// ── Knowing, rather than assuming ──────────────────────────────────────────
//
// US-2641 was three eBay verbs -- price, end, relist -- that each reported
// success without ever confirming it, because the call did not throw. Creating
// a policy is the same shape: optInToProgram returns void, and a POST that
// eBay accepts is not yet a policy the publish path can read. Both of the
// assumptions below were in this route and both are now checked.

Deno.test("the opt-in is confirmed by reading it back, not inferred from a quiet call", () => {
  // optInToProgram(): Promise<void>. "It did not throw" is not "the account is
  // in the program" -- get_opted_in_programs is the read that settles it, and
  // the client already has it.
  assertStringIncludes(CREATE_ROUTE, "getOptedInPrograms(ownerId)");
  assert(
    CREATE_ROUTE.indexOf("getOptedInPrograms") <
      CREATE_ROUTE.indexOf("createDefaultPolicies"),
    "the programs are read back AFTER the policies are created, which is too late",
  );
});

Deno.test("an account eBay does not report as opted in is refused, not written to", () => {
  assertStringIncludes(CREATE_ROUTE, 'optedIn && !optedIn.includes("SELLING_POLICY_MANAGEMENT")');
});

Deno.test("the seller is told to publish only after the policies are read back", () => {
  // The handler re-syncs from eBay and re-reads the cache. It used to return
  // ok:true regardless of what came back, so a create that half-worked read as
  // "you can publish now" and the next publish still said "Configure eBay
  // business policies".
  assertStringIncludes(CREATE_ROUTE, "stillMissing");
  assert(
    CREATE_ROUTE.indexOf("stillMissing") > CREATE_ROUTE.lastIndexOf("await listCachedPolicies(ownerId)"),
    "the confirmation does not read the post-create list",
  );
  assertStringIncludes(CREATE_ROUTE, "still_missing:");
});
