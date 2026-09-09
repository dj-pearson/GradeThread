// US-3197: the cross-channel match decision.
//
// A wrong "link" MERGES two garments and there is no unmerge button, so these
// tests are weighted toward what must NEVER auto-link rather than toward recall.
// A missed link costs a review row; a wrong one costs a seller their inventory.
//
//   deno test --allow-read src/tests/cross-channel-link_test.ts
import { assert, assertEquals } from "@std/assert";
import {
  AMBIGUITY_GAP,
  bestMatch,
  decideLink,
  LINK_THRESHOLD,
  type LinkCandidate,
  MAX_UNANCHORED_SCORE,
  priceSimilarity,
  titleSimilarity,
  titleTokens,
} from "../lib/cross-channel-link.ts";

const ebayJacket: LinkCandidate = {
  platform: "ebay",
  title: "Patagonia Better Sweater Fleece Jacket Mens Medium Navy",
  brand: "Patagonia",
  size: "M",
  color: "Navy",
  price: 68,
};

const poshJacket: LinkCandidate = {
  platform: "poshmark",
  title: "Patagonia Better Sweater fleece jacket navy",
  brand: "Patagonia",
  size: "M",
  color: "Navy",
  price: 78,
};

Deno.test("the same garment on two channels links", () => {
  const d = decideLink(ebayJacket, poshJacket);
  assertEquals(d.verdict, "link");
  assert(d.score >= LINK_THRESHOLD);
  assertEquals(d.refusedBy, null);
});

Deno.test("the decision does not depend on argument order", () => {
  // Otherwise the answer would depend on which channel was imported first.
  const forward = decideLink(ebayJacket, poshJacket);
  const backward = decideLink(poshJacket, ebayJacket);
  assertEquals(forward.verdict, backward.verdict);
  assertEquals(forward.score.toFixed(6), backward.score.toFixed(6));
});

Deno.test("two rows on the SAME platform never link", () => {
  const d = decideLink(ebayJacket, { ...poshJacket, platform: "ebay" });
  assertEquals(d.verdict, "none");
  assertEquals(d.refusedBy, "same_platform");
});

Deno.test("a size conflict refuses outright, however alike the titles", () => {
  // The failure this whole module exists to prevent: a medium and a large of
  // the same shirt are two garments, and their titles are 95% identical.
  const d = decideLink(ebayJacket, { ...poshJacket, size: "L" });
  assertEquals(d.verdict, "none");
  assertEquals(d.refusedBy, "size_conflict");
  assert(d.reasons[0].includes("Different sizes"));
});

Deno.test("a brand conflict refuses outright", () => {
  const d = decideLink(ebayJacket, { ...poshJacket, brand: "The North Face" });
  assertEquals(d.verdict, "none");
  assertEquals(d.refusedBy, "brand_conflict");
});

Deno.test("a brand present on one side only is not a conflict", () => {
  // Poshmark closets routinely omit brand. Silence is not disagreement.
  const d = decideLink(ebayJacket, { ...poshJacket, brand: null });
  assert(d.refusedBy === null);
  assert(d.verdict !== "none");
});

Deno.test("M matches medium, and M does not match L", () => {
  assertEquals(decideLink(ebayJacket, { ...poshJacket, size: "Medium" }).refusedBy, null);
  assertEquals(decideLink(ebayJacket, { ...poshJacket, size: "m" }).refusedBy, null);
  assertEquals(decideLink(ebayJacket, { ...poshJacket, size: "L" }).refusedBy, "size_conflict");
});

Deno.test("a perfect title with nothing else agreeing is held, not linked", () => {
  const a: LinkCandidate = { platform: "ebay", title: "Carhartt Detroit Jacket Duck Canvas" };
  const b: LinkCandidate = { platform: "poshmark", title: "Carhartt Detroit jacket duck canvas" };
  const d = decideLink(a, b);
  assertEquals(d.verdict, "review");
});

Deno.test("no unanchored pair can EVER reach link, whatever its title scores", () => {
  // The invariant, asserted on the arithmetic rather than on one example. If a
  // future weight change raises the ceiling above the threshold, this fails
  // here instead of silently turning "the titles matched" into a merge.
  assert(
    MAX_UNANCHORED_SCORE < LINK_THRESHOLD,
    `an unanchored pair can reach ${MAX_UNANCHORED_SCORE}, at or above LINK_THRESHOLD ${LINK_THRESHOLD}`,
  );

  // And the same claim from the other end: the best possible unanchored pair —
  // identical titles, same colour, identical prices, no brand and no size on
  // either side — is still only a review.
  const best = decideLink(
    { platform: "ebay", title: "Carhartt Detroit Jacket Duck Canvas", color: "Brown", price: 90 },
    { platform: "poshmark", title: "Carhartt Detroit Jacket Duck Canvas", color: "Brown", price: 90 },
  );
  assertEquals(best.verdict, "review");
  assert(best.score <= MAX_UNANCHORED_SCORE + 1e-9);
});

Deno.test("unrelated garments score none", () => {
  const d = decideLink(ebayJacket, {
    platform: "mercari",
    title: "Lululemon Align Leggings 25 inch",
    brand: null,
    size: null,
    price: 44,
  });
  assertEquals(d.verdict, "none");
});

Deno.test("a wildly different price does not by itself stop a link", () => {
  // Sellers pad Poshmark prices for the fee. Price is the weakest signal and
  // must not veto brand + size + title agreement.
  const d = decideLink(ebayJacket, { ...poshJacket, price: 145 });
  assertEquals(d.verdict, "link");
});

Deno.test("every decision carries a reason, including refusals", () => {
  for (
    const d of [
      decideLink(ebayJacket, poshJacket),
      decideLink(ebayJacket, { ...poshJacket, size: "XL" }),
      decideLink(ebayJacket, { ...poshJacket, platform: "ebay" }),
    ]
  ) {
    assert(d.reasons.length > 0, "a decision with no reason cannot be reviewed");
  }
});

Deno.test("titleTokens drops the words every reseller title carries", () => {
  const tokens = titleTokens("NWT Womens Size M Free Shipping Patagonia Fleece");
  assert(!tokens.has("nwt"));
  assert(!tokens.has("womens"));
  assert(!tokens.has("size"));
  assert(!tokens.has("shipping"));
  assert(tokens.has("patagonia"));
  assert(tokens.has("fleece"));
});

Deno.test("titleTokens keeps a style code and drops a bare small number", () => {
  const tokens = titleTokens("Nike Air Max 90 style 302519");
  assert(tokens.has("302519"), "a style code is identity");
  assert(!tokens.has("90"), "a bare 2-digit number is a size or a year");
});

Deno.test("titleSimilarity is Jaccard, so a short title does not match everything", () => {
  // Containment would score this as perfect and merge a whole closet into one
  // row. Jaccard punishes the length gap, which is the intended behaviour.
  const sim = titleSimilarity(
    "Nike Tee",
    "Nike Dri-FIT Vapor Golf Tee Navy Striped Performance Polo",
  );
  assert(sim < 0.5, `expected a low score, got ${sim}`);
  assertEquals(titleSimilarity("", "Nike Tee"), 0);
});

Deno.test("priceSimilarity is neutral, not zero, when a price is missing", () => {
  // Absent data must not be evidence AGAINST a match.
  assertEquals(priceSimilarity(null, 40), 0.5);
  assertEquals(priceSimilarity(40, null), 0.5);
  assertEquals(priceSimilarity(40, 40), 1);
  assert(priceSimilarity(40, 80) === 0.5);
});

Deno.test("bestMatch demotes to review when two candidates are equally good", () => {
  // The bulk-seller case: six identical black tees. Picking the highest of six
  // near-identical scores is picking at random, so nothing auto-merges.
  const row: LinkCandidate = {
    platform: "poshmark",
    title: "Hanes Beefy T Black Tee",
    brand: "Hanes",
    size: "L",
    price: 12,
  };
  const twins: LinkCandidate[] = [
    { platform: "ebay", title: "Hanes Beefy T black tee", brand: "Hanes", size: "L", price: 12 },
    { platform: "ebay", title: "Hanes Beefy T black tee", brand: "Hanes", size: "L", price: 13 },
  ];
  const m = bestMatch(row, twins);
  assert(m);
  assertEquals(m.verdict, "review");
  assert(m.reasons.some((r) => /pick the right one/i.test(r)));
});

Deno.test("bestMatch still links when the winner is clear of the field", () => {
  const row: LinkCandidate = {
    platform: "poshmark",
    title: "Patagonia Better Sweater fleece jacket navy",
    brand: "Patagonia",
    size: "M",
    color: "Navy",
    price: 78,
  };
  const field: LinkCandidate[] = [
    ebayJacket,
    { platform: "ebay", title: "Patagonia Nano Puff Vest", brand: "Patagonia", size: "M", price: 60 },
  ];
  const m = bestMatch(row, field);
  assert(m);
  assertEquals(m.verdict, "link");
  assertEquals(m.index, 0);
  const second = decideLink(row, field[1]);
  assert(m.score - second.score >= AMBIGUITY_GAP, "the winner must be clear of the runner-up");
});

Deno.test("bestMatch returns null rather than a bad guess when nothing matches", () => {
  const m = bestMatch(ebayJacket, [
    { platform: "poshmark", title: "Lululemon Align Leggings", brand: "Lululemon", size: "6" },
  ]);
  assertEquals(m, null);
});

Deno.test("bestMatch on an empty field is null, not a throw", () => {
  assertEquals(bestMatch(ebayJacket, []), null);
});
