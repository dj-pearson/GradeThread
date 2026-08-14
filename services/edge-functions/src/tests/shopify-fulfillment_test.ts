// US-2328: Shopify tracking push.
//
// Shopify was REAL for connect/list/sync/delist/revise and SHELL for ship —
// there was no fulfillment call anywhere in the repo. A seller who shipped a
// Shopify order through FlipDesk left it unfulfilled, and since SHOPIFY is what
// emails the buyer their tracking, the gap was invisible on our side and
// obvious on theirs.
//
// AC3 asks for a sandbox test, which needs a real shop and cannot run here.
// What CAN be pinned without one is every decision this code makes before and
// after the network call, and those are the parts that were wrong in the
// equivalent eBay/Depop paths historically: which fulfillment orders to submit,
// and whether a refusal is noticed.
import { assert, assertEquals, assertRejects } from "@std/assert";

Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);

const {
  assertNoUserErrors,
  createShopifyFulfillment,
  selectFulfillableOrders,
} = await import("../lib/shopify-fulfillment.ts");

Deno.test("US-2328: only fulfillable fulfillment orders are selected", () => {
  const picked = selectFulfillableOrders([
    { id: "fo/1", status: "OPEN" },
    { id: "fo/2", status: "IN_PROGRESS" },
    { id: "fo/3", status: "CLOSED" },
    { id: "fo/4", status: "CANCELLED" },
    { id: "fo/5", status: "ON_HOLD" },
    { id: "fo/6", status: "INCOMPLETE" },
  ]);
  assertEquals(picked.map((o) => o.id), ["fo/1", "fo/2"]);
});

Deno.test("US-2328: a fulfillment order held by a 3rd-party service is left alone", () => {
  // Status OPEN but assigned out. Submitting for it would claim someone else's
  // work is done, and the seller would see the buyer notified for a parcel that
  // is still sitting with the fulfilment provider.
  const picked = selectFulfillableOrders([
    { id: "fo/1", status: "OPEN", requestStatus: "SUBMITTED" },
    { id: "fo/2", status: "OPEN", requestStatus: "ACCEPTED" },
    { id: "fo/3", status: "OPEN", requestStatus: "UNSUBMITTED" },
    { id: "fo/4", status: "OPEN", requestStatus: null },
  ]);
  assertEquals(picked.map((o) => o.id), ["fo/3", "fo/4"]);
});

Deno.test("US-2328: userErrors THROW — a refusal must not read as a shipment", () => {
  // The specific trap. fulfillmentCreate answers HTTP 200 with a populated
  // userErrors array when it refuses, so a handler checking only the transport
  // status tells the seller their buyer has tracking when Shopify said no.
  assertEquals(assertNoUserErrors([]), undefined);
  assertEquals(assertNoUserErrors(null), undefined);

  let msg = "";
  try {
    assertNoUserErrors([
      { field: ["fulfillment", "trackingInfo"], message: "Tracking number is invalid" },
    ]);
  } catch (e) {
    msg = e instanceof Error ? e.message : String(e);
  }
  // The seller has to be told WHAT Shopify objected to, not that "something
  // failed" — they are the only one who can fix a bad tracking number.
  assert(msg.includes("Tracking number is invalid"), `lost the reason: ${msg}`);
  assert(msg.includes("fulfillment.trackingInfo"), `lost the field: ${msg}`);
});

/** A graphql fake: first call answers the read, the rest answer the mutation. */
function fakeGraphql(
  nodes: Array<{ id: string; status: string; requestStatus?: string | null }>,
  mutationResult: (foId: string) => unknown,
) {
  const calls: Array<{ query: string; variables: Record<string, unknown> }> = [];
  const graphql = (
    _shop: string,
    _token: string,
    query: string,
    variables: Record<string, unknown> = {},
    // deno-lint-ignore no-explicit-any
  ): Promise<any> => {
    calls.push({ query, variables });
    if (query.includes("fulfillmentOrders")) {
      return Promise.resolve({
        data: { order: { id: "gid://shopify/Order/1", fulfillmentOrders: { nodes } } },
      });
    }
    const fo = (variables.fulfillment as {
      lineItemsByFulfillmentOrder: Array<{ fulfillmentOrderId: string }>;
    }).lineItemsByFulfillmentOrder[0]!.fulfillmentOrderId;
    return Promise.resolve({ data: { fulfillmentCreate: mutationResult(fo) } });
  };
  // deno-lint-ignore no-explicit-any
  return { graphql: graphql as any, calls };
}

Deno.test("US-2328: EVERY fulfillable order is submitted, not just the first", async () => {
  // A multi-location order has several fulfillment orders. Submitting only the
  // first marks part of it shipped and silently leaves the rest — which reads
  // as complete success to the seller and to us.
  const { graphql, calls } = fakeGraphql(
    [
      { id: "fo/1", status: "OPEN" },
      { id: "fo/2", status: "OPEN" },
      { id: "fo/3", status: "CLOSED" },
    ],
    (fo) => ({ fulfillment: { id: `f-${fo}` }, userErrors: [] }),
  );

  const r = await createShopifyFulfillment(
    "shop.myshopify.com",
    "tok",
    "gid://shopify/Order/1",
    { trackingNumber: "1Z999", carrier: "UPS" },
    { graphql },
  );

  assertEquals(r.fulfilled, 2);
  assertEquals(r.fulfillmentIds, ["f-fo/1", "f-fo/2"]);
  assertEquals(r.alreadyFulfilled, false);
  // One read + one mutation per fulfillable order.
  assertEquals(calls.length, 3);

  // The tracking actually travels, with the carrier as `company`.
  const mutation = calls[1]!.variables.fulfillment as {
    trackingInfo: { number: string; company?: string };
    notifyCustomer: boolean;
  };
  assertEquals(mutation.trackingInfo.number, "1Z999");
  assertEquals(mutation.trackingInfo.company, "UPS");
  // Notifying the buyer is the POINT of this call, so it defaults on.
  assertEquals(mutation.notifyCustomer, true);
});

Deno.test("US-2328: nothing fulfillable is a no-op, not an error", async () => {
  // Re-shipping an already-fulfilled order is the common case — a retry, or a
  // seller correcting tracking. Throwing would turn a no-op into a red banner.
  const { graphql, calls } = fakeGraphql(
    [{ id: "fo/1", status: "CLOSED" }],
    () => ({ fulfillment: { id: "nope" }, userErrors: [] }),
  );
  const r = await createShopifyFulfillment(
    "shop.myshopify.com",
    "tok",
    "gid://shopify/Order/1",
    { trackingNumber: "1Z999" },
    { graphql },
  );
  assertEquals(r, { fulfilled: 0, fulfillmentIds: [], alreadyFulfilled: true });
  assertEquals(calls.length, 1, "it called fulfillmentCreate with nothing to fulfil");
});

Deno.test("US-2328: a refusal on the SECOND order still fails the call", async () => {
  // The partial case, which is the one a loop gets wrong: order one succeeds,
  // order two is refused. Reporting success because something worked would
  // leave half the order unshipped with the seller told otherwise.
  const { graphql } = fakeGraphql(
    [
      { id: "fo/1", status: "OPEN" },
      { id: "fo/2", status: "OPEN" },
    ],
    (fo) =>
      fo === "fo/2"
        ? { fulfillment: null, userErrors: [{ message: "Line items already fulfilled" }] }
        : { fulfillment: { id: `f-${fo}` }, userErrors: [] },
  );
  await assertRejects(
    () =>
      createShopifyFulfillment(
        "shop.myshopify.com",
        "tok",
        "gid://shopify/Order/1",
        { trackingNumber: "1Z999" },
        { graphql },
      ),
    Error,
    "Line items already fulfilled",
  );
});

Deno.test("US-2328: a missing order is refused, not treated as fulfilled", async () => {
  // A null order means the id is wrong or belongs to another shop. Returning
  // "already fulfilled" there would silently swallow a real misconfiguration.
  // deno-lint-ignore no-explicit-any
  const graphql = ((): Promise<any> => Promise.resolve({ data: { order: null } })) as any;
  await assertRejects(
    () =>
      createShopifyFulfillment(
        "shop.myshopify.com",
        "tok",
        "gid://shopify/Order/404",
        { trackingNumber: "1Z999" },
        { graphql },
      ),
    Error,
    "has no order",
  );
});

Deno.test("US-2328: no fulfillment id and no error is refused", async () => {
  // A shape we do not understand. Reporting a fulfilment we cannot point at is
  // the one answer that is definitely wrong.
  const { graphql } = fakeGraphql(
    [{ id: "fo/1", status: "OPEN" }],
    () => ({ fulfillment: null, userErrors: [] }),
  );
  await assertRejects(
    () =>
      createShopifyFulfillment(
        "shop.myshopify.com",
        "tok",
        "gid://shopify/Order/1",
        { trackingNumber: "1Z999" },
        { graphql },
      ),
    Error,
    "no fulfillment and no error",
  );
});

Deno.test("US-2328: the sale carries the Shopify order id, or nothing can ship", () => {
  // The precondition the story does not mention. ingestShopifyOrder recorded
  // the money and dropped the only handle back to Shopify — sales.platform_order_id
  // was never populated for Shopify, so the ship route would have had nothing
  // to fulfil against. eBay has stored it since 00032.
  const src = Deno.readTextFileSync(
    new URL("../lib/shopify-orders.ts", import.meta.url),
  ).replace(/(^|\s)\/\/[^\n]*/g, "$1");
  assert(
    /platform_order_id: String\(order\.id\)/.test(src),
    "the Shopify order id is no longer stored on the sale, so shipping has no " +
      "target and every fulfilment attempt 409s",
  );
});

Deno.test("US-2328: a sale with no order id is REFUSED, not silently recorded", () => {
  // Sales ingested before this story have a null platform_order_id. Writing
  // tracking locally and returning ok would tell the seller their buyer was
  // notified when no Shopify call was ever made — the exact failure this story
  // exists to remove, reintroduced for older rows.
  const src = Deno.readTextFileSync(
    new URL("../routes/flipdesk-shopify.ts", import.meta.url),
  );
  const at = src.indexOf('flipdeskShopifyRoutes.post("/orders/:saleId/ship"');
  assert(at > -1, "the Shopify ship route is gone");
  const handler = src.slice(at);
  assert(
    /if \(!sale\.platform_order_id\)[\s\S]{0,600}409/.test(handler),
    "a sale with no Shopify order id no longer refuses",
  );
  // And the refusal must come BEFORE the local write-back.
  //
  // BOTH indices are checked for presence first, and that is the point rather
  // than defensiveness: `indexOf` returns -1 when the marker is GONE, and
  // -1 < anything is true — so deleting the code entirely would have satisfied
  // an ordering comparison written the obvious way. Negative verification
  // caught exactly that: removing the marker left this case green.
  const refusalAt = handler.indexOf("missing_platform_order_id");
  // \r?\n, not a literal \n: the working copy is CRLF on Windows
  // (core.autocrlf), so this marker never matched there and the case failed
  // locally while passing in CI on the LF checkout. A guard that is red for
  // everyone on one platform is a guard everyone learns to ignore.
  //
  // ` {4}`, not four literal spaces: `deno lint`'s no-regex-spaces rejects a run
  // of consecutive spaces in a pattern, because in source they are impossible to
  // count. Same match, and it says the indent depth out loud.
  const writeAt = handler.search(/\.from\("sales"\)\r?\n {4}\.update\(/);
  assert(refusalAt > -1, "the missing_platform_order_id refusal code is gone");
  assert(writeAt > -1, "the local sale write-back is gone or was reshaped");
  assert(
    refusalAt < writeAt,
    "the local write happens before the missing-order-id check, so a sale with " +
      "no Shopify order id would be recorded as shipped",
  );
});
