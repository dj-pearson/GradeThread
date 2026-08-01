// US-1098: candidate-match ranking + wear-monotonicity gate. Pure — no DB.
import "./_env.ts";
import { assert, assertEquals } from "@std/assert";
import {
  type FingerprintRecord,
  rankCandidates,
  sameSkuClass,
  scoreCandidate,
} from "../lib/garment-match.ts";

const SKU = { brand: "Nike", garment_type: "shirt", category: "tops" };
const PHASH = "0123456789abcdef";

function fp(id: string, over: Partial<FingerprintRecord> = {}): FingerprintRecord {
  return { garmentId: id, skuClass: SKU, phashes: { front: PHASH }, wearScore: 5, ...over };
}

const QUERY = fp("Q");

Deno.test("sameSkuClass: type+category must agree; brand only when both set", () => {
  assert(sameSkuClass(SKU, { brand: "Nike", garment_type: "shirt", category: "tops" }));
  assert(!sameSkuClass(SKU, { brand: "Adidas", garment_type: "shirt", category: "tops" }));
  assert(!sameSkuClass(SKU, { garment_type: "pants", category: "tops" }));
  // Missing brand on one side never blocks.
  assert(sameSkuClass(SKU, { garment_type: "shirt", category: "tops" }));
});

Deno.test("scoreCandidate: excludes different SKU class and low similarity", () => {
  assertEquals(scoreCandidate(QUERY, fp("A", { skuClass: { brand: "Adidas", garment_type: "shirt", category: "tops" } })), null);
  assertEquals(scoreCandidate(QUERY, fp("B", { phashes: { front: "ffffffffffffffff" } })), null);
  assertEquals(scoreCandidate(QUERY, fp("Q")), null); // self
});

Deno.test("monotonicity: degraded condition is consistent and scores higher", () => {
  // Query is MORE worn than the older candidate → plausible degradation.
  const degraded = scoreCandidate(QUERY, fp("A", { wearScore: 3 }))!;
  assertEquals(degraded.suspicious, false);
  assertEquals(degraded.monotonic, true);
  assert(degraded.wearDelta > 0);
});

Deno.test("improved condition is flagged suspicious and scored down", () => {
  // Query is LESS worn than the older candidate → physically implausible.
  const improved = scoreCandidate(QUERY, fp("B", { wearScore: 8 }))!;
  assertEquals(improved.suspicious, true);
  assertEquals(improved.monotonic, false);
  // Same visual similarity, but a degraded candidate must outrank it.
  const degraded = scoreCandidate(QUERY, fp("A", { wearScore: 3 }))!;
  assert(degraded.score > improved.score, "degraded outranks improved");
});

Deno.test("confidence is always 'probable' — never asserted certain (AC3)", () => {
  const r = scoreCandidate(QUERY, fp("A", { wearScore: 3 }))!;
  assertEquals(r.confidence, "probable");
});

Deno.test("rankCandidates: best score first, suspicious still listed (flagged)", () => {
  const ranked = rankCandidates(QUERY, [
    fp("improved", { wearScore: 9 }), // suspicious
    fp("degraded", { wearScore: 2 }), // best
    fp("otherSku", { skuClass: { brand: "Adidas", garment_type: "shirt", category: "tops" } }), // excluded
  ]);
  assertEquals(ranked.map((r) => r.garmentId), ["degraded", "improved"]);
  assertEquals(ranked.find((r) => r.garmentId === "improved")!.suspicious, true);
});
