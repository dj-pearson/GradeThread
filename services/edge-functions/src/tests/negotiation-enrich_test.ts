// US-1062: the "send offers to interested buyers" chooser must show each
// eligible listing's real title, price, currency, thumbnail and condition. These
// tests pin the pure mapping that merges eBay's bare { listingId, title } with a
// local-listing join and an eBay Browse fallback.
import { assertEquals } from "@std/assert";
import {
  type EligibleEnrichment,
  enrichEligibleItems,
} from "../lib/negotiation-enrich.ts";

const local = new Map<string, EligibleEnrichment>();
const browse = new Map<string, EligibleEnrichment>();

Deno.test("local listing enrichment wins and carries every display field", () => {
  const localMap = new Map<string, EligibleEnrichment>([
    ["327175130089", {
      title: "Patagonia Better Sweater — Men's M",
      price: 64.99,
      currency: "USD",
      imageUrl: "https://img/123.jpg",
      condition: "Pre-owned",
    }],
  ]);
  const out = enrichEligibleItems(
    [{ listingId: "327175130089", title: "327175130089" }],
    localMap,
    browse,
  );
  assertEquals(out, [{
    listingId: "327175130089",
    title: "Patagonia Better Sweater — Men's M",
    price: 64.99,
    currency: "USD",
    imageUrl: "https://img/123.jpg",
    condition: "Pre-owned",
    source: "local",
  }]);
});

Deno.test("Browse fallback fills items with no local row", () => {
  const browseMap = new Map<string, EligibleEnrichment>([
    ["999", {
      title: "Nike Tee",
      price: 18,
      currency: "GBP",
      imageUrl: "https://img/n.jpg",
      condition: "New",
    }],
  ]);
  const out = enrichEligibleItems(
    [{ listingId: "999", title: null }],
    local,
    browseMap,
  );
  assertEquals(out[0].source, "browse");
  assertEquals(out[0].title, "Nike Tee");
  assertEquals(out[0].price, 18);
  assertEquals(out[0].currency, "GBP");
  assertEquals(out[0].imageUrl, "https://img/n.jpg");
  assertEquals(out[0].condition, "New");
});

Deno.test("local takes precedence over Browse for the same listing", () => {
  const id = "555";
  const localMap = new Map<string, EligibleEnrichment>([
    [id, { title: "Local", price: 10, currency: "USD", imageUrl: null, condition: null }],
  ]);
  const browseMap = new Map<string, EligibleEnrichment>([
    [id, { title: "Browse", price: 99, currency: "USD", imageUrl: "x", condition: "New" }],
  ]);
  const out = enrichEligibleItems([{ listingId: id, title: null }], localMap, browseMap);
  assertEquals(out[0].source, "local");
  assertEquals(out[0].title, "Local");
  assertEquals(out[0].price, 10);
});

Deno.test("falls back to eBay title, then bare id, when nothing else resolves", () => {
  const out = enrichEligibleItems(
    [
      { listingId: "111", title: "eBay-supplied title" },
      { listingId: "222", title: null },
    ],
    local,
    browse,
  );
  assertEquals(out[0], {
    listingId: "111",
    title: "eBay-supplied title",
    price: null,
    currency: "USD",
    imageUrl: null,
    condition: null,
    source: "ebay",
  });
  // id-only: title is null so the UI shows the listing id.
  assertEquals(out[1].title, null);
  assertEquals(out[1].source, "ebay");
});

Deno.test("eBay title backstops a local row missing its title", () => {
  const localMap = new Map<string, EligibleEnrichment>([
    ["333", { title: null, price: 5, currency: "USD", imageUrl: null, condition: null }],
  ]);
  const out = enrichEligibleItems(
    [{ listingId: "333", title: "From eBay" }],
    localMap,
    browse,
  );
  assertEquals(out[0].title, "From eBay");
  assertEquals(out[0].source, "local");
});

Deno.test("preserves order and length of the eligible list", () => {
  const items = ["a", "b", "c"].map((id) => ({ listingId: id, title: null }));
  const out = enrichEligibleItems(items, local, browse);
  assertEquals(out.map((o) => o.listingId), ["a", "b", "c"]);
});
