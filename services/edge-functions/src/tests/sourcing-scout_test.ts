// Sourcing sites on the scout: what the server will and will not do (US-3067 AC3).
//
// The extension on a ShopGoodwill lot sends the lot's own image URLs and the
// asking price. It does NOT send the page for the server to fetch, and the
// server does not fetch it either. That is the anti-crawl contract
// lib/listing-ingest.ts states, and this file holds the server to it.

// ⚠ _env.ts FIRST. Importing the scout route pulls in modules that read the
// environment at import time, and test-env-isolation_test.ts fails any test file
// that reaches one without loading the fixture env ahead of it.
import "./_env.ts";
import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  INGEST_MARKETPLACE_HOSTS,
  normalizeScoutMarketplace,
  resolveIngestMarketplace,
  resolveSourcingMarketplace,
  SOURCING_MARKETPLACE_HOSTS,
} from "../lib/listing-ingest.ts";
import { parseAppraiseUrls } from "../routes/flipdesk-scout.ts";

Deno.test("a sourcing host resolves, and lookalikes do not", () => {
  assertEquals(resolveSourcingMarketplace("shopgoodwill.com"), "shopgoodwill");
  assertEquals(resolveSourcingMarketplace("www.shopgoodwill.com"), "shopgoodwill");
  assertEquals(resolveSourcingMarketplace("SHOPGOODWILL.COM."), "shopgoodwill");
  // The label-boundary walk, not a bare endsWith.
  assertEquals(resolveSourcingMarketplace("shopgoodwill.com.evil.example"), null);
  assertEquals(resolveSourcingMarketplace("notshopgoodwill.com"), null);
  assertEquals(resolveSourcingMarketplace(""), null);
});

Deno.test("⚠ a sourcing site is NOT ingestible as a resale listing", () => {
  // THE ONE THAT MATTERS. INGEST_MARKETPLACE_HOSTS feeds condition-alerts, so a
  // host in it can put a listing in front of a BUYER. A ShopGoodwill lot is a
  // charity's photograph of a donation with no seller making a condition claim;
  // surfacing one in a buyer's alert feed would present a thrift bin as a graded
  // resale listing. The two maps must stay disjoint.
  const ingest = new Set(Object.keys(INGEST_MARKETPLACE_HOSTS));
  for (const host of Object.keys(SOURCING_MARKETPLACE_HOSTS)) {
    assertEquals(ingest.has(host), false, `${host} is in BOTH maps`);
    assertEquals(
      resolveIngestMarketplace(host),
      null,
      `${host} resolves as an ingestible resale marketplace`,
    );
  }
  // And the reverse: no resale marketplace has quietly become a sourcing site.
  const sourcing = new Set(Object.keys(SOURCING_MARKETPLACE_HOSTS));
  for (const host of Object.keys(INGEST_MARKETPLACE_HOSTS)) {
    assertEquals(sourcing.has(host), false, `${host} is in BOTH maps`);
  }
});

Deno.test("the metric label is bounded, and shopgoodwill is one of its values", () => {
  assertEquals(normalizeScoutMarketplace("shopgoodwill"), "shopgoodwill");
  assertEquals(normalizeScoutMarketplace("SHOPGOODWILL"), "shopgoodwill");
  assertEquals(normalizeScoutMarketplace(" ebay "), "ebay");
  // Anything not in either map is "unknown". A caller-supplied string sliced to
  // 24 characters, which is what this used to be, is unbounded cardinality on a
  // metric label.
  for (
    const raw of [
      "goodwillfinds",
      "a".repeat(200),
      "ebay; DROP",
      "",
      "   ",
      null,
      undefined,
      42,
      {},
    ]
  ) {
    assertEquals(normalizeScoutMarketplace(raw), "unknown", String(raw));
  }
});

Deno.test("⚠ a request with no photos is refused before anything is reserved", () => {
  // AC3's own case: the extension sends the lot's IMAGE URLs, and a request that
  // names only the page has nothing the server is allowed to read. This refusal
  // happens in the shape parser, BEFORE the AI action is reserved, so a caller
  // sending an empty body is never billed for it.
  for (const body of [undefined, null, [], {}, { url: "https://shopgoodwill.com/item/1" }, ""]) {
    const res = parseAppraiseUrls(body);
    assertEquals(res.ok, false, JSON.stringify(body));
    if (!res.ok) assertStringIncludes(res.error, "listing photo");
  }

  // Photos on the lot's own CDN are what it accepts.
  const ok = parseAppraiseUrls([
    "https://shopgoodwillimages.azureedge.net/production/32/Items/2026-07-16/abc_07161.png",
    "https://shopgoodwillimages.azureedge.net/production/32/Items/2026-07-16/abc_07162.png",
  ]);
  assertEquals(ok.ok, true);
  if (ok.ok) assertEquals(ok.urls.length, 2);
});

Deno.test("⚠ a PAGE url smuggled into imageUrls is refused by content type, not by shape", () => {
  // WORTH BEING PRECISE ABOUT, because the shape parser does NOT catch this and
  // a test asserting it did would be describing a defence that is not there.
  // parseListingImageUrls accepts a bare string as a one-element list, so
  // `imageUrls: "https://shopgoodwill.com/item/1"` passes the shape check.
  //
  // What stops it is one layer down: quick-grade.ts fetches through safeFetch
  // and DISCARDS anything whose content-type is not image/*. An HTML page comes
  // back as text/html and never reaches the model, so the page is never read as
  // a page — which is the anti-crawl property, arrived at from the other side.
  const shape = parseAppraiseUrls("https://shopgoodwill.com/item/276278053");
  assertEquals(shape.ok, true, "shape parser behaviour changed — re-check this note");

  const qg = Deno.readTextFileSync(
    new URL("../lib/quick-grade.ts", import.meta.url),
  );
  assertStringIncludes(
    qg,
    'contentType.startsWith("image/")',
    "quick-grade no longer refuses non-image content — a page URL would now be read",
  );
});

Deno.test("⚠ the scout never fetches the listing page", () => {
  // Asserted against the SOURCE, because a route that fetched the page and one
  // that did not would return the same JSON on a lot whose photos are also on
  // the page. The only URLs that reach a socket are the ones in `imageUrls`,
  // through quickGrade's safeFetch.
  //
  // The ONE exception is eBay, and it is the opposite of scraping: US-3042
  // replaced the extension's page-scrape with a read of eBay's own Browse API,
  // which is what their license requires. hydrateEbayListingBody is that call.
  const src = Deno.readTextFileSync(
    new URL("../routes/flipdesk-scout.ts", import.meta.url),
  );
  const start = src.indexOf('flipdeskScoutRoutes.post("/appraise-url"');
  const end = src.indexOf("flipdeskScoutRoutes.post", start + 10);
  const route = src.slice(start, end === -1 ? undefined : end);
  assertEquals(route.length > 500, true, "the appraise-url handler moved");

  for (const call of ["fetch(body.url", "safeFetch(body.url", "fetch(url)"]) {
    assertEquals(
      route.includes(call),
      false,
      `the appraise-url handler contains ${call} — it must never fetch the listing page`,
    );
  }
  // The only outbound reads named in the handler are the eBay Browse hydration
  // and the graded image URLs.
  assertStringIncludes(route, "hydrateEbayListingBody(body");
  assertStringIncludes(route, "parseAppraiseUrls(body.imageUrls)");

  // ⚠ AND THE ROUTE ACTUALLY CALLS THE NORMALIZER. Testing
  // normalizeScoutMarketplace on its own passes happily while the handler goes
  // on slicing the caller's string to 24 characters onto a metric label, which
  // is the unbounded cardinality this replaced.
  assertStringIncludes(route, "normalizeScoutMarketplace(body.marketplace)");
  assertEquals(
    route.includes("body.marketplace.slice("),
    false,
    "the handler still puts a raw caller string on the metric label",
  );
});
