// US-1885 (AC1): pending cross-listing delist projection (pure). No DB.
//
// WHY THIS IS WORTH A TEST. `auto_delistable` decides whether a UI offers a
// one-click "end this listing". Get it wrong in the permissive direction and the
// seller is told a listing was handled when the extension had no live URL to
// open and did nothing — so a sold item stays live for a second buyer, which is
// the exact failure the whole delist queue exists to prevent. Two surfaces now
// read this queue (the SaaS over a JWT, the extension popup over an HMAC token)
// and they share this projection so they cannot drift apart on that rule.
import { assert, assertEquals } from "@std/assert";

Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key");

const {
  isAutoDelistable,
  toPendingDelist,
  EXTENSION_DELIST_PLATFORMS,
  LOCATE_DELIST_PLATFORMS,
  matchTitlesFor,
  normalizeSellerHandles,
  isValidSellerHandle,
} = await import("../lib/pending-delists.ts");

Deno.test("US-3369: a saved link makes any extension listing auto-delistable", () => {
  for (const p of EXTENSION_DELIST_PLATFORMS) {
    assert(isAutoDelistable(p, "https://example.test/listing/x"), `${p} with a link`);
  }
});

Deno.test("US-3369: with no link, only a platform the extension can SEARCH is auto-delistable", () => {
  // Poshmark, Mercari, Grailed and Facebook have an active-listings page the
  // extension can open from its own config and search by title.
  for (const p of LOCATE_DELIST_PLATFORMS) {
    assert(isAutoDelistable(p, null), `${p} should be searchable without a link`);
  }
  // Vinted's wardrobe needs a numeric member id we do not hold. Without a link
  // there is nothing for the extension to open, so it must say "by hand".
  assertEquals(isAutoDelistable("vinted", null), false);
  assertEquals(isAutoDelistable("vinted", ""), false);
  // An API platform is never the extension's job, link or not.
  assertEquals(isAutoDelistable("ebay", "https://www.ebay.com/itm/1"), false);
});

Deno.test("US-3369: a STAMPED row reads as auto-delistable even though it is 'ended' locally", () => {
  // THE BUG. autoEndCrossListings sets every sibling to 'ended' in the same
  // write that stamps it, and the old rule demanded 'active', so every
  // sale-triggered delist came back auto_delistable:false and the popup said
  // "By hand" for all of them.
  const out = toPendingDelist({
    id: "l", platform: "poshmark", listing_url: "https://poshmark.com/listing/abc",
    listing_status: "ended", inventory_item_id: "i",
    delist_requested_at: "2026-09-11T10:00:00.000Z",
    inventory_items: { user_id: "o", item_title: "Levi's 501" },
  });
  assertEquals(out.auto_delistable, true);
});

Deno.test("US-3369: every locate platform is an extension delist platform", () => {
  for (const p of LOCATE_DELIST_PLATFORMS) {
    assert(EXTENSION_DELIST_PLATFORMS.includes(p), `${p} is searchable but not routed to the extension`);
  }
});

Deno.test("US-3369: match titles are most-specific first, deduplicated, capped and clipped", () => {
  assertEquals(
    matchTitlesFor(["Nike Hoodie M", null, "  ", "nike hoodie m", "Nike Hoodie", "a", "b", "c"]),
    ["Nike Hoodie M", "Nike Hoodie", "a", "b"],
  );
  assertEquals(matchTitlesFor(["x".repeat(500)])[0].length, 200);
  assertEquals(matchTitlesFor([]), []);
});

Deno.test("US-3369: only a plain username survives as a seller handle", () => {
  assert(isValidSellerHandle("jane_closet.22"));
  // Anything that could change a URL's shape is refused, not escaped.
  for (const bad of ["jane/../x", "a b", "https://evil.test", "", "x".repeat(41), "jane?x=1", 5]) {
    assertEquals(isValidSellerHandle(bad), false, String(bad));
  }
  assertEquals(
    normalizeSellerHandles({ poshmark: "jane", mercari: "bad/one", grailed: 7 }),
    { poshmark: "jane" },
  );
  assertEquals(normalizeSellerHandles(null), {});
  assertEquals(normalizeSellerHandles(["jane"]), {});
});

Deno.test("projection maps the row shape the UI consumes", () => {
  const out = toPendingDelist({
    id: "listing-1",
    platform: "poshmark",
    listing_url: "https://poshmark.com/listing/abc",
    listing_status: "active",
    listing_title: "Levi's 501 Vintage Jeans",
    inventory_item_id: "item-1",
    delist_requested_at: "2026-07-18T10:00:00.000Z",
    inventory_items: { user_id: "owner-1", item_title: "Vintage Levi's 501" },
  }, { variantTitle: "Levis 501 Posh", sellerHandle: "jane" });
  assertEquals(out, {
    listing_id: "listing-1",
    platform: "poshmark",
    listing_url: "https://poshmark.com/listing/abc",
    listing_status: "active",
    auto_delistable: true,
    item_id: "item-1",
    item_title: "Vintage Levi's 501",
    requested_at: "2026-07-18T10:00:00.000Z",
    match_titles: ["Levi's 501 Vintage Jeans", "Levis 501 Posh", "Vintage Levi's 501"],
    seller_handle: "jane",
  });
});

Deno.test("projection never leaks the owner id to the client", () => {
  // user_id is selected only to SCOPE the query (US-268 ownership-via-parent).
  // It must not ride along into the response — the extension popup renders this
  // straight into the DOM.
  const out = toPendingDelist({
    id: "l", platform: "mercari", listing_url: null, listing_status: "draft",
    inventory_item_id: "i", delist_requested_at: "2026-07-18T10:00:00.000Z",
    inventory_items: { user_id: "owner-secret", item_title: null },
  });
  assert(!("user_id" in out), "projection must not carry user_id");
  assertEquals(JSON.stringify(out).includes("owner-secret"), false);
});

Deno.test("a null item_title survives as null, not the string 'null'", () => {
  // inventory_items.title is nullable; the popup substitutes its own placeholder.
  // Coercing here would ship a literal "null" to every untitled item.
  const out = toPendingDelist({
    id: "l", platform: "grailed", listing_url: null, listing_status: "active",
    inventory_item_id: "i", delist_requested_at: "2026-07-18T10:00:00.000Z",
    inventory_items: { user_id: "o", item_title: null },
  });
  assertEquals(out.item_title, null);
});

Deno.test("only the API-less platforms are in the extension delist set", async () => {
  // eBay/Shopify/Depop/Etsy are ended via their own APIs by autoEndCrossListings
  // (Etsy as of US-2164) — if one leaked into this list the popup would ask the
  // seller to hand-end a listing the server already closed.
  const { API_DELIST_PLATFORMS } = await import("./_fixtures/api-delist.ts")
    .catch(() => ({ API_DELIST_PLATFORMS: ["ebay", "shopify", "depop", "etsy"] }));
  for (const p of API_DELIST_PLATFORMS) {
    assertEquals(
      EXTENSION_DELIST_PLATFORMS.includes(p),
      false,
      `${p} has a server-side delist API; listing it here would ask the seller ` +
        "to hand-end something the server already closed",
    );
  }

  // THE ASSERTION THAT REPLACED A HARD-CODED LIST (2026-08-11). This used to
  // spell out ["grailed", "mercari", "poshmark"], which meant the guard could
  // only ever confirm that a SECOND copy of the list still matched a THIRD copy
  // written into a test. It did not — Vinted and Facebook were added to the
  // real set in US-2479/US-2480 and to neither of the others — and the divergence
  // left a stamped pending delist invisible to the seller, which is a live
  // sibling after a sale.
  //
  // So the guard is now identity: the query's list IS the routing decision's
  // list, and nothing here restates either.
  const { EXTENSION_DELIST_PLATFORMS: routing } = await import(
    "../lib/cross-listing-sale.ts"
  );
  assertEquals(
    [...EXTENSION_DELIST_PLATFORMS].sort(),
    [...routing].sort(),
    "the platforms the pending-delist query returns must be exactly the ones " +
      "delistMethodFor routes to the extension. A platform in one and not the " +
      "other is either a delist nobody is shown, or a prompt for a listing the " +
      "extension cannot end.",
  );
  // And it must be non-empty, or the identity above is satisfied by two bugs.
  assertEquals(EXTENSION_DELIST_PLATFORMS.length > 0, true);
});
