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

const { isAutoDelistable, toPendingDelist, EXTENSION_DELIST_PLATFORMS } = await import(
  "../lib/pending-delists.ts"
);

Deno.test("auto-delistable requires BOTH a confirmed-active status and a URL", () => {
  assert(isAutoDelistable("active", "https://poshmark.com/listing/x"));

  // A draft was never confirmed live — there is nothing on the marketplace to
  // end, and offering to end it would report success for a no-op.
  assertEquals(isAutoDelistable("draft", "https://poshmark.com/listing/x"), false);
  // Confirmed active but we hold no link: the extension navigates to the listing
  // URL to end it, so with no URL there is no automated path.
  assertEquals(isAutoDelistable("active", null), false);
  assertEquals(isAutoDelistable("active", ""), false);
  // Already ended/sold rows are not actionable either.
  assertEquals(isAutoDelistable("ended", "https://poshmark.com/listing/x"), false);
  assertEquals(isAutoDelistable("sold", "https://poshmark.com/listing/x"), false);
});

Deno.test("projection maps the row shape the UI consumes", () => {
  const out = toPendingDelist({
    id: "listing-1",
    platform: "poshmark",
    listing_url: "https://poshmark.com/listing/abc",
    listing_status: "active",
    inventory_item_id: "item-1",
    delist_requested_at: "2026-07-18T10:00:00.000Z",
    inventory_items: { user_id: "owner-1", item_title: "Vintage Levi's 501" },
  });
  assertEquals(out, {
    listing_id: "listing-1",
    platform: "poshmark",
    listing_url: "https://poshmark.com/listing/abc",
    listing_status: "active",
    auto_delistable: true,
    item_id: "item-1",
    item_title: "Vintage Levi's 501",
    requested_at: "2026-07-18T10:00:00.000Z",
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
