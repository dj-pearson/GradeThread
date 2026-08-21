// US-2767: the model must be able to say NO to eBay.
//
// Most of these assert on prompt TEXT, which is usually a weak thing to test.
// It is not weak here: the entire mechanism is the wording. The existing block
// for outside information says "ground truth - do not contradict", and putting
// a similarity match in it would settle the question before the model looked at
// a single photo. So the block's framing IS the feature, and a well-meaning
// edit that softens it would silently restore the anchoring.

import "./_env.ts";
import { assert, assertEquals } from "@std/assert";
import {
  acceptedValues,
  buildCandidateBlock,
  type CandidateRuling,
  dropUnevidenced,
  EVIDENCE_PRECEDENCE,
  evidenceRank,
  resolveByPrecedence,
} from "../lib/visual-candidates.ts";

const cand = (field: string, value: string, support: number, outOf: number) => ({
  field,
  value,
  support,
  outOf,
});

// ── The block ───────────────────────────────────────────────────────────────

Deno.test("nothing to adjudicate produces no block at all", () => {
  assertEquals(buildCandidateBlock([]), "");
  // A candidate nobody actually declared is not a candidate.
  assertEquals(buildCandidateBlock([cand("brand", "Nike", 0, 5)]), "");
  assertEquals(buildCandidateBlock([cand("brand", "", 3, 5)]), "");
});

Deno.test("the block never calls the guess ground truth", () => {
  const block = buildCandidateBlock([cand("brand", "Lululemon", 4, 5)]);
  // The exact phrase the neighbouring block uses. If it ever appears here, the
  // model has been told to stop thinking.
  assert(!block.includes("ground truth - do not contradict"));
  assert(!block.toLowerCase().includes("do not contradict"));
  assert(block.includes("UNVERIFIED"));
  assert(block.includes("NOT ground truth"));
});

Deno.test("the block states the precedence in order, and says the tag wins", () => {
  const block = buildCandidateBlock([cand("brand", "Lululemon", 4, 5)]);
  const styleCode = block.indexOf("style/model code");
  const wordmark = block.indexOf("brand wordmark");
  const visual = block.indexOf("visual-match candidates");
  const knowledge = block.indexOf("your own knowledge");
  assert(styleCode > -1 && wordmark > styleCode);
  assert(visual > wordmark && knowledge > visual);
  assert(block.includes("The tag wins"));
});

Deno.test("the block licenses rejection explicitly", () => {
  // Without this line the model reads rejection as failing to be useful, which
  // is the whole reason a confident wrong brand survives.
  const block = buildCandidateBlock([cand("brand", "Lululemon", 4, 5)]);
  assert(block.includes("correct and expected outcome"));
});

Deno.test("support is shown as N of M, because 2 of 2 is not 2 of 5", () => {
  const block = buildCandidateBlock([cand("brand", "Faherty", 2, 2)]);
  assert(block.includes("2 of 2"));
});

// ── Rulings ─────────────────────────────────────────────────────────────────

Deno.test("an acceptance with no named evidence is DROPPED server-side", () => {
  // The prompt asks for evidence; a model wanting to be helpful will accept
  // without it. This is the backstop that does not argue back.
  const rulings: CandidateRuling[] = [
    { field: "brand", value: "Lululemon", verdict: "accepted", evidence: null },
    {
      field: "type",
      value: "Leggings",
      verdict: "accepted",
      evidence: "tag_wordmark",
    },
  ];
  const kept = dropUnevidenced(rulings);
  assertEquals(kept.length, 1);
  assertEquals(kept[0]?.field, "type");
});

Deno.test("a REJECTION with no evidence survives, because rejecting needs none", () => {
  const rulings: CandidateRuling[] = [
    { field: "brand", value: "Lululemon", verdict: "rejected", evidence: null },
  ];
  assertEquals(dropUnevidenced(rulings).length, 1);
});

Deno.test("acceptedValues yields only what survived", () => {
  const values = acceptedValues([
    { field: "brand", value: "Faherty", verdict: "accepted", evidence: "tag_wordmark" },
    { field: "type", value: "Polo", verdict: "rejected", evidence: null },
    { field: "material", value: "Linen", verdict: "accepted", evidence: null },
  ]);
  assertEquals(values, { brand: "Faherty" });
});

// ── Precedence ──────────────────────────────────────────────────────────────

Deno.test("a style code outranks everything, including a unanimous visual match", () => {
  assert(evidenceRank("style_code") < evidenceRank("tag_wordmark"));
  assert(evidenceRank("tag_wordmark") < evidenceRank("visual_consensus"));
  assert(evidenceRank("visual_consensus") < evidenceRank("model_knowledge"));
  assertEquals(EVIDENCE_PRECEDENCE.length, 4);
});

Deno.test("a stronger challenger replaces the incumbent", () => {
  const winner = resolveByPrecedence(
    { kind: "visual_consensus" as const, v: "Athleta" },
    { kind: "tag_wordmark" as const, v: "Faherty" },
  );
  assertEquals(winner?.v, "Faherty");
});

Deno.test("a weaker challenger does not, however well supported", () => {
  // Forty listings agreeing still lose to one legible tag. No confidence
  // number can express that, which is why this is an ordering.
  const winner = resolveByPrecedence(
    { kind: "tag_wordmark" as const, v: "Faherty" },
    { kind: "visual_consensus" as const, v: "Athleta" },
  );
  assertEquals(winner?.v, "Faherty");
});

Deno.test("a TIE goes to the incumbent, so nothing changes for no reason", () => {
  const winner = resolveByPrecedence(
    { kind: "visual_consensus" as const, v: "first" },
    { kind: "visual_consensus" as const, v: "second" },
  );
  assertEquals(winner?.v, "first");
});

Deno.test("an absent side is not a winner", () => {
  assertEquals(
    resolveByPrecedence(null, { kind: "model_knowledge" as const, v: "x" })?.v,
    "x",
  );
  assertEquals(
    resolveByPrecedence({ kind: "model_knowledge" as const, v: "y" }, null)?.v,
    "y",
  );
  assertEquals(resolveByPrecedence(null, null), null);
});
