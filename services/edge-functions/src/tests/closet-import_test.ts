// US-9201: the pure rules of the closet import.
//
//   deno test --allow-read src/tests/closet-import_test.ts

import { assert, assertEquals } from "@std/assert";
import {
  applyFreeTierCap,
  closetFillPatch,
  closetListingPatch,
  isClosetImportPlatform,
  listingIdFromUrl,
  FREE_CLOSET_IMPORT_ROWS,
  MAX_CLOSET_IMPORT_PHOTOS,
  MAX_CLOSET_IMPORT_ROWS,
  normalizeClosetRows,
  photoHostAllowed,
  photoTypeForIndex,
  platformLabel,
} from "../lib/closet-import.ts";

const POSH_ID = "5f1e2d3c4b5a69788796a5b4";

Deno.test("listingIdFromUrl reads the marketplace id and nothing else", () => {
  assertEquals(
    listingIdFromUrl("poshmark", `https://poshmark.com/listing/Lululemon-Align-Tank-${POSH_ID}`),
    POSH_ID,
  );
  assertEquals(
    listingIdFromUrl("poshmark", `https://poshmark.com/listing/${POSH_ID.toUpperCase()}?ref=x`),
    POSH_ID,
  );
  assertEquals(listingIdFromUrl("mercari", "https://www.mercari.com/us/item/m12345678901/"), "m12345678901");
  assertEquals(listingIdFromUrl("mercari", "https://www.mercari.com/item/m98765432109"), "m98765432109");
  // Not listing pages, or not this marketplace's shape.
  assertEquals(listingIdFromUrl("poshmark", "https://poshmark.com/closet/someone"), null);
  assertEquals(listingIdFromUrl("poshmark", "https://poshmark.com/listing/no-id-here"), null);
  assertEquals(listingIdFromUrl("mercari", "https://www.mercari.com/search?keyword=x"), null);
  assertEquals(listingIdFromUrl("mercari", "not a url"), null);
  assertEquals(listingIdFromUrl("poshmark", 42), null);
});

Deno.test("photoHostAllowed admits only the marketplace's own CDN over https", () => {
  assert(photoHostAllowed("poshmark", "https://di2ponv0v5otw.cloudfront.net/posts/x/l_abc.jpg"));
  assert(photoHostAllowed("mercari", "https://u-mercari-images.mercdn.net/photos/m1_1.jpg"));
  assert(!photoHostAllowed("poshmark", "http://di2ponv0v5otw.cloudfront.net/posts/x/l_abc.jpg"), "http refused");
  assert(!photoHostAllowed("poshmark", "https://evil.example/cloudfront.net/x.jpg"), "path lookalike refused");
  assert(!photoHostAllowed("poshmark", "https://mercdn.net/x.jpg"), "the other marketplace's CDN refused");
  assert(!photoHostAllowed("mercari", "https://169.254.169.254/latest"), "metadata host refused");
  assert(!photoHostAllowed("mercari", "garbage"));
});

Deno.test("normalizeClosetRows rebuilds every row and drops what it cannot key", () => {
  const rows = normalizeClosetRows("poshmark", [
    {
      listingUrl: `https://poshmark.com/listing/Nice-Tee-${POSH_ID}`,
      title: "  Nice Tee  ",
      priceCents: 2450,
      size: "M",
      brand: "Madewell",
      condition: "Like new",
      photoUrls: [
        "https://di2ponv0v5otw.cloudfront.net/posts/1/l_a.jpg",
        "https://di2ponv0v5otw.cloudfront.net/posts/1/l_a.jpg", // duplicate
        "https://attacker.example/l_b.jpg", // wrong host
        "javascript:alert(1)",
      ],
      // Keys that must never survive normalisation.
      buyerName: "someone",
      sessionCookie: "abc",
    },
    { listingUrl: "https://poshmark.com/closet/me", title: "No id" },
    { listingUrl: `https://poshmark.com/listing/x-${"a".repeat(24)}` }, // no title
    "not an object",
  ]);
  assertEquals(rows.length, 1);
  const r = rows[0]!;
  assertEquals(r.row, 1);
  assertEquals(r.platform, "poshmark");
  assertEquals(r.platform_listing_id, POSH_ID);
  assertEquals(r.title, "Nice Tee");
  assertEquals(r.price, 24.5);
  assertEquals(r.size, "M");
  assertEquals(r.brand, "Madewell");
  assertEquals(r.condition, "Like new");
  assertEquals(r.description, null);
  assertEquals(r.detail, false);
  assertEquals(r.photo_urls, ["https://di2ponv0v5otw.cloudfront.net/posts/1/l_a.jpg"]);
  assertEquals(
    Object.keys(r).sort(),
    [
      "brand", "condition", "description", "detail", "listing_url", "photo_urls",
      "platform", "platform_listing_id", "price", "row", "size", "title",
    ],
    "a row carries exactly the allowlisted fields",
  );
});

Deno.test("normalizeClosetRows dedupes one listing read twice, keeping the detail read", () => {
  const url = `https://poshmark.com/listing/Tee-${POSH_ID}`;
  const rows = normalizeClosetRows("poshmark", [
    { listingUrl: url, title: "Tee", priceCents: 1000 },
    { listingUrl: url, title: "Tee", priceCents: 1000, description: "Soft cotton", detail: true },
    { listingUrl: url, title: "Tee (tile again)", priceCents: 900 },
  ]);
  assertEquals(rows.length, 1);
  assertEquals(rows[0]!.description, "Soft cotton");
  assertEquals(rows[0]!.detail, true);
  assertEquals(rows[0]!.row, 1);
});

Deno.test("normalizeClosetRows caps rows and photos", () => {
  const many = Array.from({ length: MAX_CLOSET_IMPORT_ROWS + 5 }, (_, i) => ({
    listingUrl: `https://www.mercari.com/item/m${String(100000000 + i)}`,
    title: `Item ${i}`,
    photoUrls: Array.from(
      { length: MAX_CLOSET_IMPORT_PHOTOS + 3 },
      (_, j) => `https://static.mercdn.net/item/detail/orig/photos/m${i}_${j}.jpg`,
    ),
  }));
  const rows = normalizeClosetRows("mercari", many);
  assertEquals(rows.length, MAX_CLOSET_IMPORT_ROWS);
  assertEquals(rows[0]!.photo_urls.length, MAX_CLOSET_IMPORT_PHOTOS);
  assertEquals(normalizeClosetRows("mercari", "nope"), []);
});

Deno.test("closetFillPatch fills blanks and never overwrites", () => {
  const row = normalizeClosetRows("mercari", [{
    listingUrl: "https://www.mercari.com/item/m11111111111",
    title: "Jacket",
    description: "Barely worn",
    brand: "Patagonia",
    size: "L",
    condition: "Good",
  }])[0]!;
  const patch = closetFillPatch(
    { description: "Seller wrote this in FlipDesk", brand: "", size: null, condition_notes: "  " },
    row,
  );
  assertEquals(patch, {
    brand: "Patagonia",
    size: "L",
    condition_notes: "Listed on Mercari as: Good",
  });
  assertEquals(closetFillPatch({ description: "x", brand: "y", size: "z", condition_notes: "w" }, row), {});
});

Deno.test("closetListingPatch follows the marketplace on price and URL, fills title/description", () => {
  const row = normalizeClosetRows("poshmark", [{
    listingUrl: `https://poshmark.com/listing/Tee-${POSH_ID}`,
    title: "Tee",
    priceCents: 1800,
    description: "desc",
  }])[0]!;
  const { patch, previous } = closetListingPatch(
    {
      listing_price: 25,
      listing_url: "https://poshmark.com/listing/old",
      listing_title: "My own title",
      listing_description: null,
    },
    row,
  );
  assertEquals(patch, {
    listing_price: 18,
    listing_url: `https://poshmark.com/listing/Tee-${POSH_ID}`,
    listing_description: "desc",
  });
  assertEquals(previous, {
    listing_price: 25,
    listing_url: "https://poshmark.com/listing/old",
    listing_description: null,
  });
  // Nothing changed: nothing written, nothing recorded.
  const same = closetListingPatch(
    { listing_price: 18, listing_url: row.listing_url, listing_title: "Tee", listing_description: "desc" },
    row,
  );
  assertEquals(same.patch, {});
  assertEquals(same.previous, {});
});

Deno.test("the first copied photo is the cover, the rest are details", () => {
  assertEquals(photoTypeForIndex(0), "front");
  assertEquals(photoTypeForIndex(1), "detail");
  assertEquals(photoTypeForIndex(7), "detail");
});

// US-3155: Grailed. Read off the live site 2026-09-08.
Deno.test("grailed listing ids lead the slug, and only Grailed's own CDN serves its photos", () => {
  assertEquals(
    listingIdFromUrl("grailed", "https://www.grailed.com/listings/100703624-ann-demeulemeester-jean-boots"),
    "100703624",
  );
  // Poshmark's 24-hex id TRAILS the slug; Grailed's numeric one LEADS it. The
  // two parsers are not interchangeable and this is what says so.
  assertEquals(listingIdFromUrl("grailed", "https://www.grailed.com/listings/ann-demeulemeester"), null);
  assertEquals(listingIdFromUrl("grailed", "https://www.grailed.com/users/someone"), null);
  assertEquals(listingIdFromUrl("grailed", "https://www.grailed.com/shop/mens"), null);

  assert(photoHostAllowed("grailed", "https://media-assets.grailed.com/prd/listing/abc123?w=1400"));
  assert(photoHostAllowed("grailed", "https://grailed.com/x.jpg"));
  // A batch names the photo URLs, so the edge would otherwise download from
  // anywhere the extension said. These are the look-alikes that a naive
  // `includes` or a dotless suffix check would let through.
  assert(!photoHostAllowed("grailed", "https://evilgrailed.com/x.jpg"));
  assert(!photoHostAllowed("grailed", "https://grailed.com.attacker.test/x.jpg"));
  assert(!photoHostAllowed("grailed", "https://media-photos.depop.com/x.jpg"));
  // http is refused for every platform, Grailed included.
  assert(!photoHostAllowed("grailed", "http://media-assets.grailed.com/x.jpg"));
});

Deno.test("grailed is a known platform with a label, and an unknown one still is not", () => {
  assert(isClosetImportPlatform("grailed"));
  assertEquals(platformLabel("grailed"), "Grailed");
  assert(!isClosetImportPlatform("depop"), "depop lands in US-3154, not here");
  assert(!isClosetImportPlatform("etsy"));
});

// ── US-3263: the free-plan bound ──────────────────────────────────────────
//
// This replaced an outright 402. The two things that must stay true: an
// entitled account is affected in NO way, and an unentitled one is bounded by
// this function rather than by whatever the browser sent.

Deno.test("applyFreeTierCap leaves an entitled account's batch alone", () => {
  const rows = Array.from({ length: 200 }, (_, i) => i);
  const out = applyFreeTierCap(rows, true);
  assertEquals(out.rows.length, 200);
  assertEquals(out.leftBehind, 0);
  assertEquals(out.capped, false);
});

Deno.test("applyFreeTierCap trims an unentitled batch and says what it left", () => {
  const rows = Array.from({ length: 200 }, (_, i) => i);
  const out = applyFreeTierCap(rows, false);
  assertEquals(out.rows.length, FREE_CLOSET_IMPORT_ROWS);
  assertEquals(out.leftBehind, 200 - FREE_CLOSET_IMPORT_ROWS);
  assertEquals(out.capped, true);
  // The rows kept are the FIRST ones read, so a second read of the same closet
  // brings the same listings and updates rather than duplicating them.
  assertEquals(out.rows[0], 0);
});

Deno.test("a small unentitled batch is not reported as capped", () => {
  const out = applyFreeTierCap([1, 2, 3], false);
  assertEquals(out.rows.length, 3);
  assertEquals(out.capped, false);
  assertEquals(out.leftBehind, 0);
});

Deno.test("an unentitled batch exactly at the bound is not capped", () => {
  const rows = Array.from({ length: FREE_CLOSET_IMPORT_ROWS }, (_, i) => i);
  const out = applyFreeTierCap(rows, false);
  assertEquals(out.capped, false);
  assertEquals(out.rows.length, FREE_CLOSET_IMPORT_ROWS);
});
