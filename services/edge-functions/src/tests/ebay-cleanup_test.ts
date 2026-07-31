// US-1978 (AC2): the already-deleted predicate for the eBay cleanup verbs.
//
// DELETE offer / DELETE inventory_item are the two DESTRUCTIVE verbs in the eBay
// surface, and both can legitimately fail because the artifact is ALREADY GONE — a
// prior cleanup removed it, or eBay expired it. That is the DESIRED end state, so
// the routes reconcile instead of erroring (same shape as isOfferAlreadyEndedError
// on the end path).
//
// The predicate has to be tight in BOTH directions, which is why it earns its own
// test:
//   • too loose  → a transient 5xx or a rate-limit reads as "already gone", the
//     route reports ok, and the stale artifact silently survives while the seller
//     believes it was cleaned up.
//   • too strict → routine cleanup of an already-gone artifact 502s at the seller.
//
// ebay-client.ts constructs the supabase client at load → dummy env first (the
// same pattern as denim-content_test.ts).
import { assert, assertEquals } from "@std/assert";

Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);

const { isAlreadyDeletedError, isAlreadyInProgramStateError } = await import(
  "../lib/ebay-client.ts"
);
const { resolveEndStrategy } = await import("../routes/flipdesk-ebay.ts");

// A minimal publishable variation matrix (resolveEndStrategy only checks that the
// matrix is non-null; normalizeVariations already dropped unpublishable ones).
const VARIATIONS = {
  specifications: ["Size"],
  variants: [
    { aspects: { Size: "S" }, quantity: 1 },
    { aspects: { Size: "M" }, quantity: 1 },
  ],
};

Deno.test("US-1978: an already-gone artifact reconciles rather than erroring", () => {
  for (const msg of [
    "eBay 404: offer not found",
    "eBay 404: The offer does not exist",
    "400 Bad Request: no inventory item with that SKU",
    "eBay 400: Invalid SKU",
  ]) {
    assert(
      isAlreadyDeletedError(new Error(msg)),
      `should treat as already-deleted: ${msg}`,
    );
  }
});

Deno.test("US-1978: a real failure is NEVER swallowed as already-deleted", () => {
  // The dangerous direction. If any of these read as "already gone", the route
  // tells the seller the artifact was cleaned up while it is still sitting there.
  for (const msg of [
    "eBay 500: Internal Server Error",
    "eBay 503: Service Unavailable",
    "eBay 429: rate limit exceeded",
    "eBay 403: insufficient permissions",
    "network timeout",
    "eBay 409: offer is published and cannot be deleted",
  ]) {
    assert(
      !isAlreadyDeletedError(new Error(msg)),
      `must NOT be swallowed as already-deleted: ${msg}`,
    );
  }
});

Deno.test("US-1978: the status code alone is necessary, not sufficient", () => {
  assert(
    !isAlreadyDeletedError(new Error("eBay 404: route not found on api.ebay.com")),
    "a 404 whose reason is unrelated to the artifact must not be swallowed",
  );
});

Deno.test("US-1978: non-Error inputs don't throw (catch sites pass `unknown`)", () => {
  assert(!isAlreadyDeletedError("something odd"), "a bare string is not already-deleted");
  assert(!isAlreadyDeletedError(null), "null is not already-deleted");
  assert(!isAlreadyDeletedError(undefined), "undefined is not already-deleted");
});

// ── US-1979 (AC3): the seller-program toggle's already-in-state predicate ───
//
// Same shape, same two-directional risk. eBay 409s an opt_in when the seller is
// already opted in — that is SUCCESS (they are in the state they asked for), and
// erroring would make the toggle look broken for doing nothing wrong. But swallow
// too much and a genuine rejection reads as "you're opted in" when you are not,
// which for OUT_OF_STOCK means the seller believes their evergreen listings
// survive qty 0 when eBay is still ending them.

Deno.test("US-1979: already-in-the-requested-state is success, not an error", () => {
  for (const msg of [
    "eBay 409: seller already opted in to OUT_OF_STOCK_CONTROL",
    "eBay 409: already enrolled",
    "eBay 400: not opted in to that program",
  ]) {
    assert(
      isAlreadyInProgramStateError(new Error(msg)),
      `should treat as already-in-state: ${msg}`,
    );
  }
});

// ── US-1978 (AC1): end-strategy selection for DELETE /listings/:id ──────────
//
// A multi-variation listing is ONE eBay listing over an inventory_item_group and
// carries NO single platform_offer_id, so the single-offer withdraw cannot end
// it — before AC1 it fell through to a local-only no-op and the listing stayed
// LIVE on eBay forever. resolveEndStrategy is the pure decision at the heart of
// the fix; the ORDER (group before offer) is the whole point and is what this
// test pins.

Deno.test("US-1978 (AC1): a variation listing ends by GROUP KEY, not the offer", () => {
  // The bug's exact shape: a group listing whose row ALSO happens to carry a
  // stale offer id must STILL end by group — group is resolved first.
  const s = resolveEndStrategy({
    variations: VARIATIONS,
    itemSku: "SKU-BASE-1",
    platformOfferId: "9988776655", // present but must be ignored
  });
  assertEquals(s, { kind: "group", groupKey: "SKU-BASE-1" });
});

Deno.test("US-1978 (AC1): a single-SKU listing with a live offer ends by offer", () => {
  const s = resolveEndStrategy({
    variations: null,
    itemSku: "SKU-BASE-1",
    platformOfferId: "9988776655",
  });
  assertEquals(s, { kind: "offer", offerId: "9988776655" });
});

Deno.test("US-1978 (AC1): no offer and no variations → local-only end (unchanged)", () => {
  const s = resolveEndStrategy({
    variations: null,
    itemSku: "SKU-BASE-1",
    platformOfferId: null,
  });
  assertEquals(s, { kind: "local" });
});

Deno.test("US-1978 (AC1): a variations matrix without a group key falls back safely", () => {
  // A group listing must have a SKU (== the group key). If the join somehow
  // returns no sku, we must NOT try to withdraw a group with an empty key — fall
  // through to the offer path (or local), never fabricate a key.
  assertEquals(
    resolveEndStrategy({ variations: VARIATIONS, itemSku: null, platformOfferId: "42" }),
    { kind: "offer", offerId: "42" },
  );
  assertEquals(
    resolveEndStrategy({ variations: VARIATIONS, itemSku: null, platformOfferId: null }),
    { kind: "local" },
  );
});

Deno.test("US-1979: a real program failure is never swallowed", () => {
  // The dangerous direction: reporting opted_in when eBay refused means the seller
  // trusts their evergreen listings survive qty 0 while eBay keeps ending them.
  for (const msg of [
    "eBay 403: account not eligible for this program",
    "eBay 500: Internal Server Error",
    "eBay 429: rate limit exceeded",
    "network timeout",
    "eBay 409: conflicting request in flight",
  ]) {
    assert(
      !isAlreadyInProgramStateError(new Error(msg)),
      `must NOT be swallowed as already-in-state: ${msg}`,
    );
  }
  assert(!isAlreadyInProgramStateError("nope"), "a bare string is not evidence");
  assert(!isAlreadyInProgramStateError(null), "null is not evidence");
});

// ── US-2166: the platform-agnostic end must reach the SAME decision ─────────
//
// US-2162 pointed the listings page at POST /api/flipdesk/listings/:id/end, but
// the eBay adapter's delist looked only at platformOfferId — which a variation
// listing does not have. So a seller with a multi-variation eBay listing got
// "This listing has no eBay offer id to withdraw" and the listing stayed LIVE:
// the exact US-1978 bug, reintroduced through a different door.
//
// The fix routes the adapter through resolveEndStrategy and plumbs the two
// fields it needs (variations + the item SKU) down from the route. These guard
// the wiring, because the decision itself is already covered above and what
// broke was the inputs never arriving.

const listingsRoute = Deno.readTextFileSync(
  new URL("../routes/flipdesk-listings.ts", import.meta.url),
);
const ebayAdapterSrc = Deno.readTextFileSync(
  new URL("../lib/marketplace-adapters/ebay.ts", import.meta.url),
);

Deno.test("US-2166: the eBay adapter delists via resolveEndStrategy", () => {
  // Not an offer-id check any more — the group arm has to exist and has to use
  // the group withdraw.
  assert(ebayAdapterSrc.includes("resolveEndStrategy("));
  assert(ebayAdapterSrc.includes("withdrawByInventoryItemGroup("));
});

Deno.test("US-2166: every delist call site passes variations AND the item SKU", () => {
  // Dropping either one silently degrades a group listing back to the
  // no-offer-id dead end, so both must ride along on EVERY call — the single
  // end and the bulk end alike.
  const callSites = listingsRoute.split("adapter.delist({").length - 1;
  assert(callSites >= 2, `expected the single + bulk end call sites, saw ${callSites}`);
  assertEquals(
    listingsRoute.split("variations: row.variations,").length - 1,
    callSites,
    "every adapter.delist call must pass variations",
  );
  assertEquals(
    listingsRoute.split("itemSku: row.item_sku,").length - 1,
    callSites,
    "every adapter.delist call must pass itemSku",
  );
});

Deno.test("US-2166: the owned-listing load actually selects those columns", () => {
  // The fields can only be passed if they were read. `variations` comes off the
  // listing; the group key (sku) lives on the ITEM, so the join has to ask for
  // it — that asymmetry is what makes this worth pinning.
  assert(listingsRoute.includes("variations, "), "must select listings.variations");
  assert(
    listingsRoute.includes("inventory_items!inner(user_id, sku)"),
    "must select the item sku (the group key)",
  );
});

// ── US-2166 (AC1 + AC5): one implementation, two mount points ───────────────
//
// price and bulk-edit each used to exist twice — once platform-agnostic, once
// under the eBay namespace. Two copies of an operation that moves a seller's
// prices is how a fix lands in one and not the other, and the price pair had
// already drifted (the agnostic one reports a marketplace-accepted-but-locally-
// unsaved write; the eBay one ignored it).
//
// The eBay paths must KEEP ANSWERING — shipped iOS, Android and extension
// builds call them and cannot be redeployed — so these pin both halves: the
// route is still registered, and it forwards rather than re-implementing.

const ebayRoute = Deno.readTextFileSync(
  new URL("../routes/flipdesk-ebay.ts", import.meta.url),
);

Deno.test("US-2166: the eBay price path forwards to the shared core", () => {
  assert(
    ebayRoute.includes('flipdeskEbayRoutes.post("/listings/:id/price"'),
    "the shipped-client path must stay registered",
  );
  assert(
    ebayRoute.includes("applyListingPrice("),
    "it must call the shared core",
  );
  // The tell that it kept its own copy: the direct marketplace call.
  assert(
    !ebayRoute.includes("await updateOfferPrice("),
    "it must not still push the price itself",
  );
});

Deno.test("US-2166: bulk-edit is mounted with the listing operations, and forwards", () => {
  assert(
    ebayRoute.includes('flipdeskEbayRoutes.post("/listings/bulk-edit"'),
    "the shipped-client path must stay registered",
  );
  assert(
    ebayRoute.includes("bulkEditListingsHandler(c)"),
    "it must forward to the moved handler",
  );
  assert(
    listingsRoute.includes('flipdeskListingsRoutes.post("/bulk-edit"'),
    "the canonical mount must exist",
  );
  assert(
    !ebayRoute.includes("processBulkEdit("),
    "the handler body must no longer live in the eBay router",
  );
});

Deno.test("US-2166: the moved bulk-edit keeps its Pro+ gate", () => {
  // A move is the easiest place to drop a plan gate, and dropping this one
  // hands a paid bulk action to every tier.
  const handler = listingsRoute.slice(
    listingsRoute.indexOf("export const bulkEditListingsHandler"),
  );
  assert(
    handler.slice(0, 600).includes('feature: "bulkActions"'),
    "bulk edit must still require the bulkActions entitlement",
  );
});
