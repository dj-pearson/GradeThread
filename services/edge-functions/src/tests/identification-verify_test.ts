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
  verifyIdentificationAgainstMarket,
  _browse,
  _observe,
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

// ── US-2689: the learning path runs without a proposed identification ────────
// The old gate returned before the search whenever the model could not name the
// style, so the learned index (US-2246) only ever saw items that were ALREADY
// identified. These drive the real function through the two exported seams.

type ObserveArgs = Parameters<typeof _observe.record>[0];
type Research = NonNullable<
  Parameters<typeof verifyIdentificationAgainstMarket>[0]["research"]
>;

/** A research block whose only interesting field is whether it named a style. */
function research(identifiedStyle: string | null, confidence: number): Research {
  return {
    identifiedStyle,
    productLine: null,
    fabricTechnology: null,
    msrpEstimateCents: null,
    rationale: null,
    confidence,
  };
}

/** Run the real function with both seams stubbed; returns what each one saw. */
async function runVerify(args: {
  styleCode: string | null;
  research?: Research | null;
  hits?: { title: string; url: string | null }[];
}): Promise<{ queries: string[]; observed: ObserveArgs[] }> {
  const realSearch = _browse.search;
  const realRecord = _observe.record;
  const queries: string[] = [];
  const observed: ObserveArgs[] = [];
  _browse.search = (q: string) => {
    queries.push(q);
    return Promise.resolve(args.hits ?? []);
  };
  _observe.record = (o: ObserveArgs) => {
    observed.push(o);
    return Promise.resolve(1);
  };
  try {
    await verifyIdentificationAgainstMarket({
      userId: "user-1",
      itemId: "item-1",
      brand: "Lululemon",
      styleCode: args.styleCode,
      research: args.research ?? null,
    });
  } finally {
    _browse.search = realSearch;
    _observe.record = realRecord;
  }
  return { queries, observed };
}

Deno.test("US-2689: a style code with no identification still searches and learns", async () => {
  const { queries, observed } = await runVerify({
    styleCode: "M7A83S",
    research: null,
    hits: [
      { title: "Lululemon Commission Short Relaxed Warpstreme 11\" Black 32", url: "https://ebay.com/1" },
      { title: "Lululemon Commission Short 11 Warpstreme Dark Olive 34", url: "https://ebay.com/2" },
    ],
  });
  // Only the code query — there is no named style to search for.
  assertEquals(queries, ["Lululemon M7A83S"]);
  assertEquals(observed.length, 1);
  assertEquals(observed[0]!.styleCodeRaw, "M7A83S");
  assertEquals(observed[0]!.brandKey, "lululemon");
  assertEquals(observed[0]!.titles.length, 2);
});

Deno.test("US-2689: research that failed to name a style still learns from the code", async () => {
  const { queries, observed } = await runVerify({
    styleCode: "W6AVBS",
    research: research(null, 0.4),
    hits: [{ title: "Lululemon Align Legging 25 Nulu Black Size 6", url: null }],
  });
  assertEquals(queries, ["Lululemon W6AVBS"]);
  assertEquals(observed.length, 1);
});

Deno.test("US-2689: no code and no identification searches nothing", async () => {
  const { queries, observed } = await runVerify({
    styleCode: null,
    research: null,
  });
  assertEquals(queries, []);
  assertEquals(observed, []);
});

Deno.test("US-2689: a code that returns no market hits records nothing", async () => {
  const { queries, observed } = await runVerify({
    styleCode: "M7A83S",
    research: null,
    hits: [],
  });
  assertEquals(queries, ["Lululemon M7A83S"]);
  assertEquals(observed, []);
});

// ── US-2692: the key a code is LEARNED under must be the key it is READ under ─

Deno.test("US-2692: an alias spelling learns under the canonical brand key", async () => {
  const { brandKey, brandKeyForRaw } = await import("../lib/brand-normalize.ts");

  // The read side keys on pack.key = brandKey(canonicalizeBrand(brand)).
  // "Levi" is a curated alias of "Levi's", so the raw key and the canonical key
  // DIFFER — which is exactly the case that used to write into a namespace
  // nothing reads, and the reason this is brandKeyForRaw and not brandKey.
  assertEquals(brandKey("Levi"), "levi");
  assertEquals(brandKeyForRaw("Levi"), brandKeyForRaw("Levi's"));
  assertEquals(brandKeyForRaw("Levi"), "levis");
  assert(
    brandKeyForRaw("Levi") !== brandKey("Levi"),
    "the alias case this guards has stopped being an alias case",
  );

  // A brand whose spelling IS its canonical form is unaffected either way, so
  // the fix cannot have moved the common case.
  assertEquals(brandKeyForRaw("Lululemon"), brandKey("Lululemon"));

  // "Lulu" is the live case this loop is about, and it only became an alias in
  // this commit: it used to canonicalize to the passthrough brand "Lulu" and get
  // its own namespace, so a code learned from a "Lulu" item was never read back
  // for a "Lululemon" one.
  assertEquals(brandKeyForRaw("Lulu"), "lululemon");
  assertEquals(brandKeyForRaw("lulu "), "lululemon");
});

Deno.test("US-2692: a blank brand learns under the empty key, not under null", async () => {
  const { brandKeyForRaw } = await import("../lib/brand-normalize.ts");
  // brandKeyForRaw returns null for nothing-to-canonicalize; the write site
  // coalesces to "", which is what 00503's brand_key column defaults to.
  assertEquals(brandKeyForRaw("") ?? "", "");
  assertEquals(brandKeyForRaw(null) ?? "", "");
});
