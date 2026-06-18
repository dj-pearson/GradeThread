// US-1072: keyword-research parsing + theme classification.
import { assertEquals } from "@std/assert";

// Env BEFORE importing modules that touch the supabase client at import time.
Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key");

const {
  classifyTheme,
  microsToDollars,
  normalizeCompetition,
  parseIdeaResult,
} = await import("../lib/keyword-research.ts");

Deno.test("classifyTheme: most-specific bucket wins", () => {
  assertEquals(classifyTheme("ebay listing tool"), "ebay");
  assertEquals(classifyTheme("thrift store flipping"), "thrift");
  assertEquals(classifyTheme("reseller inventory software"), "reselling");
  assertEquals(classifyTheme("clothing authentication certificate"), "authentication");
  assertEquals(classifyTheme("garment condition grading"), "grading");
  assertEquals(classifyTheme("how to start a small business"), "general");
});

Deno.test("normalizeCompetition: maps Google enums, defaults to unspecified", () => {
  assertEquals(normalizeCompetition("LOW"), "low");
  assertEquals(normalizeCompetition("Medium"), "medium");
  assertEquals(normalizeCompetition("HIGH"), "high");
  assertEquals(normalizeCompetition("UNSPECIFIED"), "unspecified");
  assertEquals(normalizeCompetition(undefined), "unspecified");
  assertEquals(normalizeCompetition("garbage"), "unspecified");
});

Deno.test("microsToDollars: micros → 2dp dollars, null on non-positive", () => {
  assertEquals(microsToDollars(1_500_000), 1.5);
  assertEquals(microsToDollars(2_345_000), 2.35);
  assertEquals(microsToDollars(0), null);
  assertEquals(microsToDollars(undefined), null);
  assertEquals(microsToDollars("not a number"), null);
});

Deno.test("parseIdeaResult: normalizes a Google Ads idea row", () => {
  const idea = parseIdeaResult({
    text: "Used Clothing Grade",
    keywordIdeaMetrics: {
      avgMonthlySearches: "1200",
      competition: "MEDIUM",
      competitionIndex: "47",
      lowTopOfPageBidMicros: "500000",
      highTopOfPageBidMicros: "1800000",
    },
  });
  assertEquals(idea?.keyword, "Used Clothing Grade");
  assertEquals(idea?.avgMonthlySearches, 1200);
  assertEquals(idea?.competition, "medium");
  assertEquals(idea?.competitionIndex, 47);
  assertEquals(idea?.cpcLow, 0.5);
  assertEquals(idea?.cpcHigh, 1.8);
});

Deno.test("parseIdeaResult: drops rows with no text; tolerates missing metrics", () => {
  assertEquals(parseIdeaResult({ text: "   " }), null);
  const idea = parseIdeaResult({ text: "ebay lister" });
  assertEquals(idea?.keyword, "ebay lister");
  assertEquals(idea?.avgMonthlySearches, null);
  assertEquals(idea?.competition, "unspecified");
  assertEquals(idea?.cpcLow, null);
});
