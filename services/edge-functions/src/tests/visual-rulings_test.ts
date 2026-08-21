// US-2767 AC3 + AC5: the model is HELD to the evidence rule, not just given it.
//
// The story's whole claim is that a confident wrong brand gets rejected instead
// of repeated. Before this, the prompt asked the model to confirm or reject each
// visual candidate and to name its evidence - and nothing read the answer.
// dropUnevidenced existed and was never imported. So a model that wrote
// "rejected: Lululemon" and then put Lululemon in the brand field was believed
// on the field and ignored on the verdict, which is precisely backwards: the
// verdict is free to write, the field is what reaches the seller's listing.
//
// These tests exercise the ENFORCEMENT. A test that only asserted the prompt
// says the right words would have passed against the broken version.

import "./_env.ts";
import { assertEquals } from "@std/assert";
import {
  applyRulings,
  type CandidateRuling,
  dropUnevidenced,
  parseRulings,
} from "../lib/visual-candidates.ts";
import { decodeExtraction } from "../lib/ai-extract.ts";

const sugg = (value: string) => ({ value, confidence: 0.9, source: "photo" });

// ── parseRulings: malformed input is dropped, never coerced ─────────────────

Deno.test("a well-formed ruling survives parsing", () => {
  const out = parseRulings([
    { field: "brand", value: "Patagonia", verdict: "accepted", evidence: "tag_wordmark" },
  ]);
  assertEquals(out, [
    { field: "brand", value: "Patagonia", verdict: "accepted", evidence: "tag_wordmark" },
  ]);
});

Deno.test("a verdict that is not one of the two words is dropped", () => {
  // "maybe" must not become an acceptance by falling through a truthiness test.
  assertEquals(
    parseRulings([{ field: "brand", value: "X", verdict: "maybe" }]),
    [],
  );
});

Deno.test("an unrecognised evidence kind becomes null, not a new kind", () => {
  // It then meets dropUnevidenced as an unevidenced acceptance, which is the
  // correct outcome - an invented evidence name is not evidence.
  const out = parseRulings([
    { field: "brand", value: "X", verdict: "accepted", evidence: "vibes" },
  ]);
  assertEquals(out[0]?.evidence, null);
  assertEquals(dropUnevidenced(out), []);
});

Deno.test("junk in the array does not take the good entries down with it", () => {
  const out = parseRulings([
    null,
    "brand: Nike",
    { field: "", value: "X", verdict: "rejected" },
    { field: "brand", value: "", verdict: "rejected" },
    { field: "brand", value: "Nike", verdict: "rejected" },
    42,
  ]);
  assertEquals(out.length, 1);
  assertEquals(out[0]?.value, "Nike");
});

Deno.test("a non-array payload is no rulings, not a throw", () => {
  assertEquals(parseRulings(undefined), []);
  assertEquals(parseRulings(null), []);
  assertEquals(parseRulings({ field: "brand" }), []);
  assertEquals(parseRulings("rejected"), []);
});

// ── applyRulings: a rejection actually removes the value ────────────────────

Deno.test("a rejected brand is removed from the suggestions", () => {
  const out = applyRulings(
    { brand: sugg("Lululemon"), color: sugg("Black") },
    [{ field: "brand", value: "Lululemon", verdict: "rejected", evidence: null }],
  );
  assertEquals(Object.keys(out), ["color"]);
});

Deno.test("the match is case- and whitespace-insensitive", () => {
  // "lululemon" and "Lululemon " are the same rejection. Requiring an exact
  // match would make the enforcement depend on the model's capitalisation.
  const out = applyRulings(
    { brand: sugg("  lululemon ") },
    [{ field: "Brand", value: "Lululemon", verdict: "rejected", evidence: null }],
  );
  assertEquals(Object.keys(out), []);
});

Deno.test("a rejection is VALUE-scoped, so a different brand survives it", () => {
  // The model rejected the candidate AND read a different brand off the tag.
  // Clearing the field here would throw away the better answer, which is the
  // opposite of what the story wants.
  const out = applyRulings(
    { brand: sugg("Patagonia") },
    [{ field: "brand", value: "Lululemon", verdict: "rejected", evidence: null }],
  );
  assertEquals(out.brand?.value, "Patagonia");
});

Deno.test("an ACCEPTED ruling removes nothing", () => {
  const out = applyRulings(
    { brand: sugg("Patagonia") },
    [{ field: "brand", value: "Patagonia", verdict: "accepted", evidence: "tag_wordmark" }],
  );
  assertEquals(out.brand?.value, "Patagonia");
});

Deno.test("no rulings returns the suggestions untouched", () => {
  const input = { brand: sugg("Patagonia"), size: sugg("M") };
  assertEquals(applyRulings(input, []), input);
});

// ── dropUnevidenced ─────────────────────────────────────────────────────────

Deno.test("an acceptance with no evidence is discarded; a rejection is kept", () => {
  const rulings: CandidateRuling[] = [
    { field: "brand", value: "A", verdict: "accepted", evidence: null },
    { field: "type", value: "B", verdict: "accepted", evidence: "visual_consensus" },
    { field: "style", value: "C", verdict: "rejected", evidence: null },
  ];
  assertEquals(dropUnevidenced(rulings).map((r) => r.value), ["B", "C"]);
});

// ── AC5, end to end through the real decoder ────────────────────────────────

Deno.test("AC5: a candidate brand contradicted by the tag does not survive", () => {
  // The exact failure the story names. The model read a Patagonia tag, rejected
  // the visual candidate - and, as models under pressure to be useful do, still
  // filled brand with the candidate. Only the server can settle that.
  const decoded = decodeExtraction(
    {
      brand: { value: "Lululemon", confidence: 0.88, source: "photo" },
      color: { value: "Black", confidence: 0.9, source: "photo" },
      visual_rulings: [
        {
          field: "brand",
          value: "Lululemon",
          verdict: "rejected",
          evidence: "tag_wordmark",
        },
      ],
    },
    true,
  );

  assertEquals(
    decoded.suggestions.brand,
    undefined,
    "a brand the model itself rejected reached the seller's listing",
  );
  assertEquals(decoded.suggestions.color?.value, "Black");
  assertEquals(decoded.visualRulings.length, 1);
  assertEquals(decoded.visualRulings[0]?.verdict, "rejected");
});

Deno.test("an unevidenced acceptance cannot shield a value from nothing", () => {
  // Ordering check. dropUnevidenced runs BEFORE applyRulings, so an acceptance
  // the server is about to discard is not present to argue with anything.
  const decoded = decodeExtraction(
    {
      brand: { value: "Lululemon", confidence: 0.9, source: "photo" },
      visual_rulings: [
        { field: "brand", value: "Lululemon", verdict: "accepted" },
      ],
    },
    true,
  );
  assertEquals(decoded.visualRulings, []);
  // The value stays: nothing rejected it. The point is that the acceptance was
  // not RECORDED as evidence the provider was right.
  assertEquals(decoded.suggestions.brand?.value, "Lululemon");
});

Deno.test("a payload with no rulings decodes exactly as before", () => {
  const decoded = decodeExtraction(
    { brand: { value: "Patagonia", confidence: 0.9, source: "photo" } },
    true,
  );
  assertEquals(decoded.suggestions.brand?.value, "Patagonia");
  assertEquals(decoded.visualRulings, []);
});
