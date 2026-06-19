// US-1099: relist detection via listing-image hash match. Pure — no DB.
//
// Covers the false-positive guardrails called out in the AC:
//   • SKU-class agreement gate (a different garment type/category never matches).
//   • Per-image similarity floor (a visually different photo doesn't match).
//   • Min-matched-photos guardrail (a single lucky near-collision is filtered
//     when minMatchedPhotos > 1).

import { assert, assertEquals } from "@std/assert";
import {
  normalizePhashes,
  rankRelistCandidates,
  type RelistCandidate,
  type RelistQuery,
  scoreRelistCandidate,
} from "../lib/relist-match.ts";

const SKU = { brand: "Nike", garment_type: "shirt", category: "tops" };

// A pair of hashes 1 bit apart (≈0.984 similarity) and one far away.
const H_A = "0000000000000000";
const H_A1 = "0000000000000001"; // 1 bit different from H_A
const H_FAR = "ffffffffffffffff"; // 64 bits different from H_A

function query(over: Partial<RelistQuery> = {}): RelistQuery {
  return { phashes: [H_A], skuClass: SKU, ...over };
}
function cand(id: string, over: Partial<RelistCandidate> = {}): RelistCandidate {
  return { garmentId: id, slug: `slug-${id}`, phashes: [H_A1], skuClass: SKU, ...over };
}

Deno.test("normalizePhashes: keeps valid 16-hex, dedups, drops junk", () => {
  assertEquals(
    normalizePhashes([H_A, H_A, "nothex", null, undefined, "abc", H_FAR]),
    [H_A, H_FAR],
  );
});

Deno.test("scoreRelistCandidate: near-identical photo of same SKU is a probable match", () => {
  const r = scoreRelistCandidate(query(), cand("A"))!;
  assert(r, "expected a match");
  assertEquals(r.confidence, "probable");
  assertEquals(r.garmentId, "A");
  assertEquals(r.slug, "slug-A");
  assertEquals(r.matchedPhotos, 1);
  assert(r.similarity > 0.98, `similarity ${r.similarity} should be high`);
});

Deno.test("SKU-class gate: different garment_type/category never matches", () => {
  assertEquals(
    scoreRelistCandidate(query(), cand("A", { skuClass: { garment_type: "pants", category: "bottoms" } })),
    null,
  );
  // Different brand when both declare one is also blocked.
  assertEquals(
    scoreRelistCandidate(query(), cand("A", { skuClass: { brand: "Adidas", garment_type: "shirt", category: "tops" } })),
    null,
  );
  // Missing brand on the candidate never blocks.
  assert(scoreRelistCandidate(query(), cand("A", { skuClass: { garment_type: "shirt", category: "tops" } })));
});

Deno.test("similarity floor: a visually different photo is not a relist", () => {
  assertEquals(scoreRelistCandidate(query(), cand("A", { phashes: [H_FAR] })), null);
});

Deno.test("empty hashes on either side → no match", () => {
  assertEquals(scoreRelistCandidate(query({ phashes: [] }), cand("A")), null);
  assertEquals(scoreRelistCandidate(query(), cand("A", { phashes: [] })), null);
});

Deno.test("minMatchedPhotos guardrail filters a lone near-collision", () => {
  // One matching photo + one unrelated photo. With minMatchedPhotos=2 the single
  // match is below the corroboration bar → filtered.
  const q = query({ phashes: [H_A, H_FAR] });
  const c = cand("A", { phashes: [H_A1] });
  assert(scoreRelistCandidate(q, c, { minSimilarity: 0.9, minMatchedPhotos: 1 }));
  assertEquals(scoreRelistCandidate(q, c, { minSimilarity: 0.9, minMatchedPhotos: 2 }), null);
});

Deno.test("more corroborating photos rank higher", () => {
  const q = query({ phashes: [H_A, H_A1] });
  const one = cand("ONE", { phashes: [H_A1] });
  const two = cand("TWO", { phashes: [H_A, H_A1] });
  const ranked = rankRelistCandidates(q, [one, two]);
  assertEquals(ranked.length, 2);
  assertEquals(ranked[0].garmentId, "TWO");
  assert(ranked[0].matchedPhotos >= ranked[1].matchedPhotos);
  assert(ranked[0].score >= ranked[1].score);
});

Deno.test("rankRelistCandidates: only plausible candidates returned, sorted", () => {
  const q = query();
  const good = cand("GOOD");
  const wrongSku = cand("SKU", { skuClass: { garment_type: "hat", category: "accessories" } });
  const tooFar = cand("FAR", { phashes: [H_FAR] });
  const ranked = rankRelistCandidates(q, [wrongSku, good, tooFar]);
  assertEquals(ranked.map((r) => r.garmentId), ["GOOD"]);
});
