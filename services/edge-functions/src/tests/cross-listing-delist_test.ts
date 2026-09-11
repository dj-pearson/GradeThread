// US-2164 / US-2165 — what actually happens to each sibling's UPSTREAM listing
// when the garment sells somewhere else.
//
// cross-listing-sale_test.ts covers the pure planner (which siblings to pull).
// This covers the dispatch that pulls them, which is where the oversell bug
// lived: Etsy matched no branch, so a live Etsy listing survived the sale of the
// garment it described, and the local row was marked "ended" anyway.
//
// The property under test is a CLASSIFICATION, not a call. "We could not end it"
// must never be reported as "ended" — that is the whole story. The marketplace
// calls are injected, so every arm is asserted without a network or a DB.

import "./_env.ts";
import { assert, assertEquals } from "@std/assert";
import {
  attemptUpstreamDelist,
  buildDelistQueuePayload,
  type DelistDeps,
  selectSiblingRows,
  type SiblingRow,
} from "../lib/cross-listings.ts";

function row(over: Partial<SiblingRow> = {}): SiblingRow {
  return {
    id: "listing-1",
    platform: "etsy",
    platform_offer_id: null,
    platform_listing_id: "etsy-123",
    listing_status: "active",
    listing_url: "https://www.etsy.com/listing/etsy-123",
    inventory_item_id: "item-1",
    inventory_items: { user_id: "owner-1", sku: "SKU-1" },
    ...over,
  };
}

/** Deps that fail loudly if an arm calls something it shouldn't. */
function deps(over: Partial<DelistDeps> = {}): DelistDeps {
  const nope = (what: string) => () => {
    throw new Error(`unexpected call: ${what}`);
  };
  return {
    withdrawOffer: nope("withdrawOffer") as DelistDeps["withdrawOffer"],
    isOfferAlreadyEndedError: () => false,
    isNoEbayConnectionError: () => false,
    getShopifyConnection: nope(
      "getShopifyConnection",
    ) as unknown as DelistDeps["getShopifyConnection"],
    deleteProductGraphql: nope(
      "deleteProductGraphql",
    ) as DelistDeps["deleteProductGraphql"],
    getDepopConnection: nope(
      "getDepopConnection",
    ) as unknown as DelistDeps["getDepopConnection"],
    deleteDepopProduct: nope("deleteDepopProduct") as DelistDeps["deleteDepopProduct"],
    isEtsyEnabled: () => true,
    getEtsyConnection: nope(
      "getEtsyConnection",
    ) as unknown as DelistDeps["getEtsyConnection"],
    setEtsyListingState: nope(
      "setEtsyListingState",
    ) as DelistDeps["setEtsyListingState"],
    ...over,
  };
}

// ── US-2164 (AC5): Etsy ─────────────────────────────────────────────

Deno.test("US-2164: an Etsy sibling is inactivated upstream on a sibling sale", () => {
  const calls: Array<[string, string, string, string]> = [];
  return attemptUpstreamDelist(
    "owner-1",
    row(),
    deps({
      getEtsyConnection: () =>
        Promise.resolve({ token: "tok", shopId: "shop-9" }),
      setEtsyListingState: (token, shopId, listingId, state) => {
        calls.push([token, shopId, listingId, state]);
        return Promise.resolve();
      },
    }),
  ).then((outcome) => {
    assertEquals(outcome.kind, "ended");
    // The listing must be set INACTIVE — the delist verb Etsy actually has.
    assertEquals(calls, [["tok", "shop-9", "etsy-123", "inactive"]]);
  });
});

Deno.test("US-2164: a DISABLED Etsy connector is unresolved, never a clean end", () => {
  // The heart of AC5. A disabled connector must not degrade to a silent
  // success — the Etsy listing is still live and buyable, so the row has to
  // carry the US-2165 marker and the seller has to be told.
  return attemptUpstreamDelist(
    "owner-1",
    row(),
    // isEtsyEnabled false, and every marketplace call is a throw-if-called, so
    // this also proves we never attempt the call behind a disabled flag.
    deps({ isEtsyEnabled: () => false }),
  ).then((outcome) => {
    assertEquals(outcome.kind, "unresolved");
    assert(
      outcome.kind === "unresolved" && /etsy/i.test(outcome.reason),
      "the reason must name the marketplace",
    );
  });
});

Deno.test("US-2164: a DISCONNECTED Etsy account is unresolved", () => {
  return attemptUpstreamDelist(
    "owner-1",
    row(),
    deps({ getEtsyConnection: () => Promise.resolve(null) }),
  ).then((outcome) => assertEquals(outcome.kind, "unresolved"));
});

Deno.test("US-2164: an Etsy connection with no shop id is unresolved", () => {
  return attemptUpstreamDelist(
    "owner-1",
    row(),
    deps({
      getEtsyConnection: () => Promise.resolve({ token: "tok", shopId: null }),
    }),
  ).then((outcome) => assertEquals(outcome.kind, "unresolved"));
});

Deno.test("US-2164: an Etsy rejection is unresolved and carries the reason", () => {
  return attemptUpstreamDelist(
    "owner-1",
    row(),
    deps({
      getEtsyConnection: () => Promise.resolve({ token: "t", shopId: "s" }),
      setEtsyListingState: () => Promise.reject(new Error("etsy 500")),
    }),
  ).then((outcome) => {
    assertEquals(outcome.kind, "unresolved");
    assert(outcome.kind === "unresolved" && outcome.reason.includes("etsy 500"));
  });
});

Deno.test("US-2164: an Etsy row that was never published is nothing_live", () => {
  // Not a failure: a draft sibling has nothing live to pull, so it must NOT
  // raise the badge. That distinction is what keeps the marker meaningful.
  return attemptUpstreamDelist(
    "owner-1",
    row({ platform_listing_id: null }),
    deps({ isEtsyEnabled: () => false }), // would be unresolved if it got that far
  ).then((outcome) => assertEquals(outcome.kind, "nothing_live"));
});

// ── US-2165: every other arm classifies honestly ────────────────────

Deno.test("US-2165: whatnot is unresolved, and the reason names it", () => {
  // whatnot has no delist channel (its listing path is 501 pending US-1662), so
  // it must earn the marker rather than a silent local end.
  return attemptUpstreamDelist(
    "owner-1",
    row({ platform: "whatnot" }),
    deps(),
  ).then((outcome) => {
    assertEquals(outcome.kind, "unresolved");
    assert(outcome.kind === "unresolved" && outcome.reason.includes("whatnot"));
  });
});

Deno.test("US-2165: an extension marketplace is queued, not ended", async () => {
  // await each one: firing three floating promises and returning would let the
  // test pass before a single assertion ran, and Deno's op sanitizer would flag
  // the leak. A vacuous test on an oversell path is worse than no test.
  for (const platform of ["poshmark", "mercari", "grailed"]) {
    const outcome = await attemptUpstreamDelist(
      "owner-1",
      row({ platform }),
      deps(),
    );
    assertEquals(outcome.kind, "queued", platform);
  }
});

Deno.test("US-2165: an eBay withdraw failure is unresolved, not a silent end", () => {
  // The wider fix: before US-2165 this console.warn-ed and marked the row ended.
  return attemptUpstreamDelist(
    "owner-1",
    row({ platform: "ebay", platform_offer_id: "offer-1" }),
    deps({
      withdrawOffer: () => Promise.reject(new Error("ebay 503")),
    }),
  ).then((outcome) => {
    assertEquals(outcome.kind, "unresolved");
    assert(outcome.kind === "unresolved" && outcome.reason.includes("ebay 503"));
  });
});

Deno.test("US-2165: an ALREADY-ended eBay offer is ended, not a false alarm", () => {
  // A withdraw legitimately fails when the offer is already gone. Flagging those
  // would put a "may still be live" banner on ordinary stale rows, which is how
  // a warning becomes noise people stop reading.
  return attemptUpstreamDelist(
    "owner-1",
    row({ platform: "ebay", platform_offer_id: "offer-1" }),
    deps({
      withdrawOffer: () => Promise.reject(new Error("already ended")),
      isOfferAlreadyEndedError: () => true,
    }),
  ).then((outcome) => assertEquals(outcome.kind, "ended"));
});

Deno.test("US-2165: a disconnected eBay account is unresolved and says so", () => {
  return attemptUpstreamDelist(
    "owner-1",
    row({ platform: "ebay", platform_offer_id: "offer-1" }),
    deps({
      withdrawOffer: () => Promise.reject(new Error("no connection")),
      isNoEbayConnectionError: () => true,
    }),
  ).then((outcome) => {
    assertEquals(outcome.kind, "unresolved");
    assert(outcome.kind === "unresolved" && /connected/i.test(outcome.reason));
  });
});

Deno.test("US-2165: a Shopify delete failure is unresolved", () => {
  return attemptUpstreamDelist(
    "owner-1",
    row({ platform: "shopify", platform_listing_id: "gid://p/1" }),
    deps({
      getShopifyConnection: () => Promise.resolve({ shop: "s", token: "t" }),
      deleteProductGraphql: () => Promise.reject(new Error("shopify 422")),
    }),
  ).then((outcome) => {
    assertEquals(outcome.kind, "unresolved");
    assert(outcome.kind === "unresolved" && outcome.reason.includes("shopify 422"));
  });
});

Deno.test("US-2165: a Depop row with no SKU is nothing_live, not unresolved", () => {
  // Depop is SKU-addressed, so no SKU means nothing was ever live there.
  return attemptUpstreamDelist(
    "owner-1",
    row({
      platform: "depop",
      inventory_items: { user_id: "owner-1", sku: null },
    }),
    deps(),
  ).then((outcome) => assertEquals(outcome.kind, "nothing_live"));
});

Deno.test("US-2165: a successful Shopify and Depop delete is ended", async () => {
  const shopify = attemptUpstreamDelist(
    "owner-1",
    row({ platform: "shopify", platform_listing_id: "gid://p/1" }),
    deps({
      getShopifyConnection: () => Promise.resolve({ shop: "s", token: "t" }),
      deleteProductGraphql: () => Promise.resolve(),
    }),
  ).then((o) => assertEquals(o.kind, "ended"));
  const depop = attemptUpstreamDelist(
    "owner-1",
    row({ platform: "depop" }),
    deps({
      getDepopConnection: () => Promise.resolve({ token: "t" }),
      deleteDepopProduct: () => Promise.resolve(),
    }),
  ).then((o) => assertEquals(o.kind, "ended"));
  // await, not return: Deno.test wants Promise<void>, and returning
  // Promise.all's tuple fails the type check.
  await Promise.all([shopify, depop]);
});

// ── US-3141: the sale hands the delist to the extension's background drain ──
//
// The bug this covers was an ABSENCE, and absences do not fail a behaviour test.
// autoEndCrossListings stamped delist_requested_at and stopped, so the drain
// that had been claiming extension_work_queue rows every five minutes since
// US-2481 never saw the one job that matters most. Nothing was broken; the two
// halves had simply never been connected.
//
// It takes the service-role client with no seam to inject, so these read the
// source. That buys less than a behaviour test and it is what is available —
// so each one pins a property whose loss would silently restore the old bug.

const CROSS_SRC = await Deno.readTextFile(
  new URL("../lib/cross-listings.ts", import.meta.url),
);

function indexOfOrThrow(haystack: string, needle: string, what: string): number {
  const i = haystack.indexOf(needle);
  if (i < 0) throw new Error(`could not find ${what} in cross-listings.ts`);
  return i;
}

Deno.test("US-3141: a queued sibling is enqueued for the extension, not just stamped", () => {
  // The connection itself. Without it the seller must open the app and click,
  // and the sibling stays live and purchasable until they do.
  assert(
    /await queueExtensionDelist\(ownerId, row, searchAids\)/.test(CROSS_SRC),
    "the queued branch no longer hands the delist to the extension queue",
  );
  assert(
    /kind: "delist"/.test(CROSS_SRC) && /source: "cross-listing-sale"/.test(CROSS_SRC),
    "the queued job lost its kind or its source",
  );
  // US-3369: the payload is built by one pure function, tested below.
  assert(
    /payload: buildDelistQueuePayload\(row, aids\)/.test(CROSS_SRC),
    "the queued delist no longer uses buildDelistQueuePayload",
  );
});

Deno.test("US-3369: the queued payload carries the link, the titles and the handle", () => {
  const row = {
    id: "l1",
    platform: "poshmark",
    platform_offer_id: null,
    platform_listing_id: null,
    listing_status: "active",
    listing_url: "https://poshmark.com/listing/abc",
    listing_title: null,
    inventory_item_id: "i1",
    inventory_items: { user_id: "o", sku: null, title: "Vintage Levi's 501" },
  };
  assertEquals(
    buildDelistQueuePayload(row, {
      handles: { poshmark: "jane", mercari: "other" },
      variantTitles: { poshmark: "Levis 501 Posh" },
    }),
    {
      listingUrl: "https://poshmark.com/listing/abc",
      matchTitles: ["Levis 501 Posh", "Vintage Levi's 501"],
      sellerHandle: "jane",
    },
  );
  // No link: the extension searches. Nothing is invented to fill the gap.
  assertEquals(
    buildDelistQueuePayload({ ...row, platform: "mercari", listing_url: null }, {
      handles: {},
      variantTitles: {},
    }),
    { matchTitles: ["Vintage Levi's 501"] },
  );
});

Deno.test("US-3369: siblings are the whole item; sold rows count only inside the draft group", () => {
  const rows = [
    { id: "sold", listing_status: "sold", draft_id: "g" },
    { id: "posh", listing_status: "active", draft_id: null },
    { id: "merc", listing_status: "draft", draft_id: null },
    { id: "ebay", listing_status: "active", draft_id: "g" },
    { id: "old-sale", listing_status: "sold", draft_id: null },
    { id: "twin", listing_status: "sold", draft_id: "g" },
    { id: "gone", listing_status: "ended", draft_id: "g" },
  ];
  const kept = selectSiblingRows(rows, { itemId: "i", draftId: "g", soldListingId: "sold" });
  assertEquals(kept.map((r) => r.id), ["posh", "merc", "ebay", "twin"]);
  // With no draft group, no sold row can be read as a double sale.
  const noGroup = selectSiblingRows(rows, { itemId: "i", draftId: null, soldListingId: null });
  assertEquals(noGroup.map((r) => r.id), ["posh", "merc", "ebay"]);
});

Deno.test("US-3141: the stamp survives alongside the queue row", () => {
  // Both paths, always. The stamp feeds loadPendingDelists, which is what the
  // seller clicks when the enqueue is refused (lapsed plan, depth cap) — and a
  // refusal is exactly when the manual path has to be there.
  assert(
    /update\.delist_requested_at = new Date\(\)\.toISOString\(\)/.test(CROSS_SRC),
    "the delist_requested_at stamp was replaced by the queue row rather than " +
      "joined by it, so a refused enqueue now leaves the seller nothing to click",
  );
});

Deno.test("US-3141: the enqueue runs after the row is marked ended", () => {
  // A row we failed to mark ended must never be queued for a browser to end:
  // the update failure path `continue`s, and ordering is what makes that hold.
  // Anchored on the call alone, not on the chain around it: the file is CRLF,
  // so a multi-line literal here would fail for the wrong reason.
  const update = indexOfOrThrow(CROSS_SRC, ".update(update)", "the sibling update");
  const enqueue = indexOfOrThrow(CROSS_SRC, "await queueExtensionDelist(ownerId, row, searchAids)", "the enqueue");
  assert(update < enqueue, "the enqueue moved ahead of the update that ends the row");
});

Deno.test("US-3141: the queue gate is the shared isAutoDelistable rule", () => {
  // A second copy of this rule has already cost a real oversell once
  // (pending-delists.ts documents it). Import it; never restate it.
  assert(
    /import \{\s*isAutoDelistable,[^}]*\} from "\.\/pending-delists\.ts"/.test(CROSS_SRC),
    "cross-listings.ts no longer imports the shared auto-delistable rule",
  );
  assert(
    /if \(!isAutoDelistable\(row\.platform, row\.listing_url\)\) return;/.test(CROSS_SRC),
    "the queue gate stopped using the shared rule, so a listing the extension " +
      "has no way to reach can be queued",
  );
  // US-3369: the background path still only takes CONFIRMED-live rows. A draft
  // is searched only when the seller presses Delist.
  assert(
    /if \(row\.listing_status !== "active"\) return;/.test(CROSS_SRC),
    "the queue gate now takes drafts, so a background search runs for listings " +
      "that were never posted and reports failures the seller did not cause",
  );
});

Deno.test("US-3141: a duplicate sale webhook cannot queue the delist twice", () => {
  const dedupe = indexOfOrThrow(
    CROSS_SRC,
    '.from("extension_work_queue")',
    "the dedupe read",
  );
  const insert = indexOfOrThrow(CROSS_SRC, "await enqueueExtensionWork(", "the enqueue call");
  assert(dedupe < insert, "the dedupe check no longer runs before the enqueue");
  assert(
    /\.in\("status", \["queued", "claimed"\]\)/.test(CROSS_SRC),
    "the dedupe stopped covering claimed rows, so a job already running gets a twin",
  );
  // US-268: the dedupe read is a query on a multi-tenant table like any other.
  const scoped = CROSS_SRC.slice(dedupe, dedupe + 400);
  assert(
    /\.eq\("user_id", ownerId\)/.test(scoped),
    "the dedupe read is not tenant-scoped",
  );
});

Deno.test("US-3141: a refused enqueue never aborts the auto-end pass", () => {
  // The remaining siblings are the point. Losing the automation on one is a
  // slower delist; abandoning the loop is the double sale this module prevents.
  const fn = CROSS_SRC.slice(
    indexOfOrThrow(CROSS_SRC, "async function queueExtensionDelist", "the helper"),
    indexOfOrThrow(CROSS_SRC, "// What happened to ONE sibling's upstream listing", "the helper's end"),
  );
  assert(/try \{/.test(fn) && /\} catch \(err\) \{/.test(fn), "the helper can throw into the caller");
  assert(!/throw /.test(fn), "the helper throws instead of logging");
  assert(
    /console\.warn\(/.test(fn),
    "a refusal is now silent, so a queue that never fills looks like one that is empty",
  );
});
