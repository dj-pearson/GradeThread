// US-1808: extension-fed marketplace listing ingestion — the pure half.
//
// What is worth asserting here is exactly what the story's ToS acceptance
// criterion rests on: the marketplace allowlist really is a boundary (a lookalike
// host does NOT get through), the marketplace is derived from the URL and never
// from the body, and one request can only ever express ONE listing. Plus the
// canonicalization that makes re-checking an item idempotent instead of
// accumulating a row per visit.
//
// Imports lib/listing-ingest.ts, NOT the route: the route pulls in hono, supabase
// and the AI client, and none of this logic needs any of them. node:assert rather
// than @std/assert so the file resolves with no network.
import assert from "node:assert/strict";

import {
  buildIngestAlertBody,
  INGEST_MARKETPLACE_HOSTS,
  MAX_LISTING_URL_LENGTH,
  normalizeListingUrl,
  parseIngestBody,
  priceWithinCeiling,
  resolveIngestMarketplace,
} from "../lib/listing-ingest.ts";

const IMG = ["https://i.ebayimg.com/a.jpg", "https://i.ebayimg.com/b.jpg"];

function body(over: Record<string, unknown> = {}) {
  return {
    url: "https://www.poshmark.com/listing/Nike-Fleece-Hoodie-abc123",
    imageUrls: IMG,
    title: "Nike Fleece Hoodie",
    brand: "Nike",
    condition: "Pre-owned",
    price: "$48.00",
    ...over,
  };
}

// ── the allowlist IS the anti-crawl boundary ─────────────────────────────────

Deno.test("resolveIngestMarketplace: supported hosts resolve, with or without www", () => {
  assert.equal(resolveIngestMarketplace("www.ebay.com"), "ebay");
  assert.equal(resolveIngestMarketplace("EBAY.CO.UK"), "ebay");
  assert.equal(resolveIngestMarketplace("m.poshmark.com"), "poshmark");
  assert.equal(resolveIngestMarketplace("www.grailed.com"), "grailed");
  assert.equal(resolveIngestMarketplace("vinted.co.uk"), "vinted");
});

Deno.test("resolveIngestMarketplace: a lookalike host is NOT a marketplace", () => {
  // The check walks label boundaries. A bare endsWith would have matched every
  // one of these, which is the whole reason it doesn't use one.
  assert.equal(resolveIngestMarketplace("ebay.com.evil.example"), null);
  assert.equal(resolveIngestMarketplace("notebay.com"), null);
  assert.equal(resolveIngestMarketplace("poshmark.com.attacker.net"), null);
  assert.equal(resolveIngestMarketplace("example.com"), null);
  assert.equal(resolveIngestMarketplace(""), null);
});

Deno.test("parseIngestBody: refuses a listing URL that is not on a supported marketplace", () => {
  const res = parseIngestBody(body({ url: "https://example.com/some/item" }), 4);
  assert.equal(res.ok, false);
  if (!res.ok) assert.match(res.error, /marketplace it supports/i);
});

Deno.test("parseIngestBody: the marketplace comes from the URL, never from the body", () => {
  // A caller claiming "poshmark" over an unsupported host is still refused...
  const forged = parseIngestBody(
    body({ url: "https://evil.example/item", marketplace: "poshmark" }),
    4,
  );
  assert.equal(forged.ok, false);

  // ...and a caller mislabelling a real marketplace is corrected, not believed.
  const mislabelled = parseIngestBody(
    body({ url: "https://www.grailed.com/listings/123", marketplace: "ebay" }),
    4,
  );
  assert.equal(mislabelled.ok, true);
  if (mislabelled.ok) assert.equal(mislabelled.listing.marketplace, "grailed");
});

Deno.test("parseIngestBody: non-http(s) listing schemes are refused", () => {
  for (const url of ["file:///etc/passwd", "javascript:alert(1)", "ftp://ebay.com/x"]) {
    const res = parseIngestBody(body({ url }), 4);
    assert.equal(res.ok, false, `${url} must not parse`);
  }
});

Deno.test("parseIngestBody: only ONE listing per request — an array body is refused", () => {
  // There is no batch form, and there must never be one: a request that could
  // carry a list is a request that can express a crawl.
  assert.equal(parseIngestBody([body(), body()], 4).ok, false);
  assert.equal(parseIngestBody(null, 4).ok, false);
  assert.equal(parseIngestBody("https://poshmark.com/listing/x", 4).ok, false);
});

// ── canonicalization / dedupe ────────────────────────────────────────────────

Deno.test("normalizeListingUrl: strips tracking query, fragment, www and trailing slash", () => {
  const a = normalizeListingUrl(
    "https://WWW.Poshmark.com/listing/Nike-Hoodie-abc123/?utm_source=x&sid=99#photos",
  );
  const b = normalizeListingUrl("http://poshmark.com/listing/Nike-Hoodie-abc123");
  assert.equal(a, "https://poshmark.com/listing/Nike-Hoodie-abc123");
  // Scheme is preserved (it is part of the canonical form), so these differ —
  // but the tracking noise that changes per visit is gone from both.
  assert.equal(b, "http://poshmark.com/listing/Nike-Hoodie-abc123");
});

Deno.test("normalizeListingUrl: the same item arrived at two ways dedupes to one key", () => {
  const fromSearch = normalizeListingUrl(
    "https://www.grailed.com/listings/123-carhartt-jacket?g_aidx=Listing_production&ref=abc",
  );
  const fromShare = normalizeListingUrl("https://grailed.com/listings/123-carhartt-jacket/");
  assert.equal(fromSearch, fromShare);
});

Deno.test("normalizeListingUrl: rejects an over-long URL rather than truncating it", () => {
  const long = `https://poshmark.com/listing/${"x".repeat(MAX_LISTING_URL_LENGTH)}`;
  assert.equal(normalizeListingUrl(long), null);
  assert.equal(normalizeListingUrl(123), null);
  assert.equal(normalizeListingUrl("   "), null);
});

// ── field validation ─────────────────────────────────────────────────────────

Deno.test("parseIngestBody: caps photos at the caller's tier and keeps the claimed fields", () => {
  const res = parseIngestBody(
    body({ imageUrls: [...IMG, "https://i.ebayimg.com/c.jpg", "https://i.ebayimg.com/d.jpg"] }),
    2,
  );
  assert.equal(res.ok, true);
  if (!res.ok) return;
  // maxImages is clamped to the anon floor (4) by clampImageCap, so a caller
  // asking for 2 still gets up to 4 — the floor is deliberate, not a bug.
  assert.equal(res.listing.imageUrls.length, 4);
  assert.equal(res.listing.title, "Nike Fleece Hoodie");
  assert.equal(res.listing.brand, "Nike");
  assert.equal(res.listing.claimedCondition, "Pre-owned");
  assert.equal(res.listing.priceCents, 4800);
  assert.equal(res.listing.watch, false);
});

Deno.test("parseIngestBody: a listing with no readable photos is refused", () => {
  const res = parseIngestBody(body({ imageUrls: [] }), 4);
  assert.equal(res.ok, false);
  if (!res.ok) assert.match(res.error, /no photos/i);
});

Deno.test("parseIngestBody: an eBay numeric conditionId survives as the claimed condition", () => {
  const res = parseIngestBody(
    body({ url: "https://www.ebay.com/itm/123456", condition: 3000 }),
    4,
  );
  assert.equal(res.ok, true);
  if (res.ok) assert.equal(res.listing.claimedCondition, "3000");
});

Deno.test("parseIngestBody: watch is opt-in and strictly boolean true", () => {
  for (const watch of [true, "true", 1, undefined]) {
    const res = parseIngestBody(body({ watch }), 4);
    assert.equal(res.ok, true);
    if (res.ok) assert.equal(res.listing.watch, watch === true);
  }
});

// ── price gate + alert copy ──────────────────────────────────────────────────

Deno.test("priceWithinCeiling: a real asking price is compared, an unknown one never suppresses", () => {
  assert.equal(priceWithinCeiling(4800, 6000), true);
  assert.equal(priceWithinCeiling(6000, 6000), true, "at the ceiling is within it");
  assert.equal(priceWithinCeiling(6001, 6000), false);
  assert.equal(priceWithinCeiling(null, 6000), true, "unreadable price must not suppress");
  assert.equal(priceWithinCeiling(99_999, null), true, "no ceiling = no gate");
});

Deno.test("buildIngestAlertBody: names the marketplace so the alert can't read as ours", () => {
  const copy = buildIngestAlertBody(
    { marketplace: "grailed", title: "Detroit Jacket", brand: "Carhartt", priceCents: 12_000 },
    8.5,
  );
  assert.match(copy, /Carhartt Detroit Jacket/);
  assert.match(copy, /on Grailed/);
  assert.match(copy, /\$120/);
  assert.match(copy, /8\.5\/10/);
});

Deno.test("buildIngestAlertBody: degrades cleanly with no brand and no price", () => {
  const copy = buildIngestAlertBody(
    { marketplace: "depop", title: null, brand: null, priceCents: null },
    6,
  );
  assert.match(copy, /Listing on Depop/);
  assert.equal(copy.includes("$"), false);
});

Deno.test("INGEST_MARKETPLACE_HOSTS: every entry maps to a lowercase adapter key", () => {
  // The keys are matched against a lowercased hostname, and the values are
  // compared to the extension's adapter keys — a stray capital in either would
  // silently stop matching without failing anything else.
  for (const [host, key] of Object.entries(INGEST_MARKETPLACE_HOSTS)) {
    assert.equal(host, host.toLowerCase(), `${host} must be lowercase`);
    assert.equal(key, key.toLowerCase(), `${key} must be lowercase`);
  }
});
