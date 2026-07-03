// US-1528: eBay Browse cross-reference for the research identification.
// Pure-core tests (tokenize / agreement scoring / verification decision) with
// fixture titles standing in for mocked Browse responses — confirm boosts,
// zero-hit demotes, disagreement leaves unverified, keyword harvest.
import { assert, assertEquals } from "@std/assert";

// identification-verify.ts transitively imports the service-role supabase
// client at load — set dummy env BEFORE the dynamic import (standard pattern).
Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);

const {
  decideVerification,
  scoreTitleAgreement,
  tokenizeTitle,
  VERIFY_CONFIDENCE_DELTA,
  VERIFY_MIN_AGREEMENT,
} = await import("../lib/identification-verify.ts");

// Realistic Browse titles for a correctly-identified Lululemon ABC Pant.
const ABC_TITLES = [
  "Lululemon ABC Pant Classic 32x30 Warpstreme Black EUC",
  "Lululemon ABC Pant Classic Fit Warpstreme Navy Men's 34",
  "LULULEMON ABC Classic Pant 30 Obsidian Warpstreme",
  "Lululemon Men's ABC Pant Classic Warpstreme Gray 36x32",
  "Lululemon ABC Pant Slim 32 Black", // slim, still an ABC pant title
];

// Titles that came back for the SAME query but describe something else — the
// identification should NOT verify off these.
const UNRELATED_TITLES = [
  "Lululemon Surge Jogger 29\" Black Men's Medium",
  "Lululemon Pace Breaker Short 7\" Lined",
  "Lululemon Metal Vent Tech Long Sleeve 2.0",
  "Nike Dri-FIT Challenger Running Pants",
];

Deno.test("US-1528: tokenizeTitle keeps codes and style numbers, drops punctuation", () => {
  assertEquals(tokenizeTitle("Levi's 501 Original-Fit (W32/L30)"), [
    "levi", "501", "original", "fit", "w32", "l30",
  ]);
});

Deno.test("US-1528: agreeing market titles score high and harvest keywords", () => {
  const { score, keywords } = scoreTitleAgreement({
    brand: "Lululemon",
    identifiedStyle: "ABC Pant Classic",
    titles: ABC_TITLES,
  });
  assert(score >= VERIFY_MIN_AGREEMENT, `score ${score} should clear the bar`);
  // The market's recurring extra token — the fabric tech — is harvested;
  // brand/style/size/color tokens are excluded by design.
  assert(keywords.includes("warpstreme"), `keywords ${keywords} missing fabric tech`);
  assert(!keywords.includes("lululemon"), "brand must not be harvested");
  assert(!keywords.includes("abc"), "style tokens must not be harvested");
  assert(!keywords.includes("black"), "colors are stopworded");
});

Deno.test("US-1528: unrelated results score low (no false verification)", () => {
  const { score } = scoreTitleAgreement({
    brand: "Lululemon",
    identifiedStyle: "ABC Pant Classic",
    titles: UNRELATED_TITLES,
  });
  assert(score < VERIFY_MIN_AGREEMENT, `score ${score} must stay under the bar`);
});

Deno.test("US-1528: no titles → zero score, no keywords", () => {
  assertEquals(scoreTitleAgreement({
    brand: "Lululemon",
    identifiedStyle: "ABC Pant Classic",
    titles: [],
  }), { score: 0, keywords: [] });
});

Deno.test("US-1528: confirm boosts confidence and flags verified", () => {
  const agreement = scoreTitleAgreement({
    brand: "Lululemon",
    identifiedStyle: "ABC Pant Classic",
    titles: ABC_TITLES,
  });
  const decision = decideVerification({
    research: { confidence: 0.7 },
    titlesSearched: ABC_TITLES.length,
    agreement,
  });
  assertEquals(decision.verified, true);
  assertEquals(decision.adjustedConfidence, 0.7 + VERIFY_CONFIDENCE_DELTA);
  assert(decision.keywords.length > 0);
});

Deno.test("US-1528: boost is capped at 0.95", () => {
  const decision = decideVerification({
    research: { confidence: 0.9 },
    titlesSearched: 5,
    agreement: { score: 1, keywords: [] },
  });
  assertEquals(decision.adjustedConfidence, 0.95);
});

Deno.test("US-1528: zero market hits demote and stay unverified", () => {
  const decision = decideVerification({
    research: { confidence: 0.7 },
    titlesSearched: 0,
    agreement: { score: 0, keywords: [] },
  });
  assertEquals(decision.verified, false);
  assertEquals(decision.adjustedConfidence, 0.7 - VERIFY_CONFIDENCE_DELTA);
  assertEquals(decision.keywords, []);
});

Deno.test("US-1528: demotion never goes below the 0.05 floor", () => {
  const decision = decideVerification({
    research: { confidence: 0.1 },
    titlesSearched: 0,
    agreement: { score: 0, keywords: [] },
  });
  assertEquals(decision.adjustedConfidence, 0.05);
});

Deno.test("US-1528: hits that disagree leave confidence untouched, unverified", () => {
  const agreement = scoreTitleAgreement({
    brand: "Lululemon",
    identifiedStyle: "ABC Pant Classic",
    titles: UNRELATED_TITLES,
  });
  const decision = decideVerification({
    research: { confidence: 0.7 },
    titlesSearched: UNRELATED_TITLES.length,
    agreement,
  });
  assertEquals(decision.verified, false);
  // Noisy search ≠ refutation: absence of agreement doesn't demote.
  assertEquals(decision.adjustedConfidence, 0.7);
});
