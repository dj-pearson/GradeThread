// US-2945: keywords for Promoted Listings Advanced.
//
// The half worth testing hardest is the NEGATIVE keyword recommendation,
// because it is the one that tells a seller to block a search term — and a
// wrongly-blocked term is invisible: the sales that would have come through it
// simply never appear, with nothing to trace them to.
import { assertEquals } from "@std/assert";

Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);

const {
  MIN_WASTED_CLICKS,
  negativeKeywordCandidates,
  normalizeKeyword,
  normalizeNegativeKeyword,
} = await import("../lib/ebay-keywords.ts");

Deno.test("normalizeKeyword reads both spellings eBay has used", () => {
  assertEquals(
    normalizeKeyword({
      keywordId: "k1",
      keywordText: "carhartt jacket",
      matchType: "PHRASE",
      keywordStatus: "ACTIVE",
      bid: { value: "0.35", currency: "USD" },
    }),
    {
      keywordId: "k1",
      text: "carhartt jacket",
      matchType: "PHRASE",
      status: "ACTIVE",
      bidCents: 35,
    },
  );
  // The other spelling, and a keyword with no bid of its own.
  const inherited = normalizeKeyword({ keywordId: "k2", keyword: "vintage tee", status: "PAUSED" });
  assertEquals(inherited.text, "vintage tee");
  assertEquals(inherited.status, "PAUSED");
  assertEquals(inherited.bidCents, null, "no bid means it inherits, not zero");
});

Deno.test("normalizeNegativeKeyword never throws on an empty payload", () => {
  assertEquals(normalizeNegativeKeyword({}).negativeKeywordId, "");
  assertEquals(normalizeNegativeKeyword({}).text, "");
});

const term = (t: string, clicks: number, sales: number, impressions = 500) => ({
  term: t,
  clicks,
  attributedSales: sales,
  impressions,
});

Deno.test("a term with clicks and NO sales is a candidate", () => {
  const out = negativeKeywordCandidates([term("carhartt womens", 12, 0)]);
  assertEquals(out.length, 1);
  assertEquals(out[0]!.term, "carhartt womens");
  assertEquals(out[0]!.reason, "12 clicks and no sales.");
});

Deno.test("a term with ANY sales is never a candidate", () => {
  assertEquals(negativeKeywordCandidates([term("carhartt jacket", 40, 1)]).length, 0);
});

Deno.test("a term under the click minimum is not evidence", () => {
  // Three clicks and no sale is not a wasted term — plenty of items sell on the
  // fourth click. This is what stops the panel telling a seller to block their
  // own best future search term on a slow week.
  assertEquals(
    negativeKeywordCandidates([term("rare denim", MIN_WASTED_CLICKS - 1, 0)]).length,
    0,
  );
  assertEquals(
    negativeKeywordCandidates([term("rare denim", MIN_WASTED_CLICKS, 0)]).length,
    1,
  );
});

Deno.test("a term already blocked is not offered again", () => {
  // Case- and whitespace-insensitive: eBay stores what the seller typed, and
  // re-recommending "Carhartt Womens" over "carhartt womens" is a list that
  // never gets shorter.
  const out = negativeKeywordCandidates(
    [term("carhartt womens", 30, 0)],
    ["  Carhartt Womens "],
  );
  assertEquals(out.length, 0);
});

Deno.test("the most expensive waste is first", () => {
  // A seller is going to block three of these and stop reading.
  const out = negativeKeywordCandidates([
    term("cheap", 9, 0),
    term("expensive", 44, 0),
    term("middling", 20, 0),
  ]);
  assertEquals(out.map((c) => c.term), ["expensive", "middling", "cheap"]);
});
