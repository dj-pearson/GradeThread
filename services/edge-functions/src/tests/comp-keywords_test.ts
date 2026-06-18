// US-1059: pure comp keyword builder. ebay-client.ts imports supabase.ts (which
// throws at init without env), so dummy-env first then dynamic-import. The
// function under test is pure — no eBay or DB I/O.
import { assertEquals } from "@std/assert";

Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);

const { buildCompKeywords } = await import("../lib/ebay-client.ts");

Deno.test("buildCompKeywords: brand leads the keyword query", () => {
  assertEquals(
    buildCompKeywords({ q: "Slim Fit Chinos", brand: "Bonobos" }),
    "bonobos slim fit chinos",
  );
});

Deno.test("buildCompKeywords: brand is not duplicated when already in title", () => {
  assertEquals(
    buildCompKeywords({ q: "Nike Dri-Fit Tee", brand: "Nike" }),
    "nike dri-fit tee",
  );
});

Deno.test("buildCompKeywords: multi-word brand kept in order, deduped", () => {
  assertEquals(
    buildCompKeywords({ q: "Klein logo hoodie", brand: "Calvin Klein" }),
    "calvin klein logo hoodie",
  );
});

Deno.test("buildCompKeywords: strips stopwords", () => {
  assertEquals(
    buildCompKeywords({ q: "The Jacket for Men with a Hood" }),
    "jacket men hood",
  );
});

Deno.test("buildCompKeywords: strips color tokens", () => {
  assertEquals(
    buildCompKeywords({ q: "Black Leather Jacket Navy Trim" }),
    "leather jacket trim",
  );
});

Deno.test("buildCompKeywords: strips letter + spelled-out size tokens", () => {
  assertEquals(
    buildCompKeywords({ q: "Wool Sweater XL Large" }),
    "wool sweater",
  );
});

Deno.test("buildCompKeywords: strips waist x inseam and w/l sizes", () => {
  assertEquals(
    buildCompKeywords({ q: "Levi's Jeans 32x34 W30 34L" }),
    "levi's jeans",
  );
});

Deno.test("buildCompKeywords: keeps bare numbers (model identifiers)", () => {
  // 501 / 90 are product identifiers, not sizes — must survive.
  assertEquals(
    buildCompKeywords({ q: "Levi's 501 Original" }),
    "levi's 501 original",
  );
});

Deno.test("buildCompKeywords: strips the explicit size value tokens", () => {
  assertEquals(
    buildCompKeywords({ q: "Patagonia Fleece X-Large", size: "X-Large" }),
    "patagonia fleece",
  );
});

Deno.test("buildCompKeywords: normalizes casing", () => {
  assertEquals(
    buildCompKeywords({ q: "VINTAGE Denim JACKET" }),
    "vintage denim jacket",
  );
});

Deno.test("buildCompKeywords: dedupes repeated tokens", () => {
  assertEquals(
    buildCompKeywords({ q: "shirt SHIRT shirt cotton" }),
    "shirt cotton",
  );
});

Deno.test("buildCompKeywords: falls back to raw query when all tokens stripped", () => {
  // Every token is a size/color/stopword — don't return empty, keep searching.
  assertEquals(
    buildCompKeywords({ q: "Black XL Large" }),
    "black xl large",
  );
});

Deno.test("buildCompKeywords: falls back to brand when query empty", () => {
  assertEquals(buildCompKeywords({ brand: "Patagonia" }), "patagonia");
});

Deno.test("buildCompKeywords: empty input yields empty string", () => {
  assertEquals(buildCompKeywords({}), "");
  assertEquals(buildCompKeywords({ q: "   ", brand: "  " }), "");
});

Deno.test("buildCompKeywords: brand-only rung produces brand keyword", () => {
  // Mirrors the ladder's brand_category rung (brand, no q).
  assertEquals(buildCompKeywords({ brand: "The North Face" }), "north face");
});
