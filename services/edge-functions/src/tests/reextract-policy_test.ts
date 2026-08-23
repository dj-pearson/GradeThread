// US-2817: the re-identify policy. These are the rules that decide whether a
// second AI pass over an old draft is allowed to change anything, so each test
// below is one way the feature could quietly become a no-op or, worse, quietly
// overwrite something the seller typed.

import { assertEquals } from "@std/assert";
import {
  buildExtractText,
  buildKnownFields,
  decideField,
  isAiOwned,
  isEmptyValue,
} from "../lib/reextract-policy.ts";

const COLUMNS = ["brand", "style", "size", "color", "material"] as const;

const AI_SOURCE = { source: "photo:tag", confidence: 0.9, accepted: true };

Deno.test("isAiOwned: only a recorded provenance entry counts", () => {
  assertEquals(isAiOwned({ brand: AI_SOURCE }, "brand"), true);
  assertEquals(isAiOwned({ brand: AI_SOURCE }, "size"), false);
  assertEquals(isAiOwned(null, "brand"), false);
  assertEquals(isAiOwned({}, "brand"), false);
  // A non-object entry is not a provenance record — treat it as seller-owned
  // rather than guessing, since guessing wrong overwrites the seller.
  assertEquals(isAiOwned({ brand: "photo" }, "brand"), false);
});

Deno.test("isAiOwned: the untracked opt-in flips fields with NO entry, not ones with one", () => {
  // Why this exists: per-column provenance was only ever written by the server,
  // and brand/style/size/color/material are applied CLIENT-side after review —
  // so on drafts from before US-2817 they carry no entry at all and read as
  // seller-typed. Without the opt-in the feature is a no-op on exactly the
  // stock it was built for.
  assertEquals(isAiOwned({}, "brand", "treat_as_ai"), true);
  assertEquals(isAiOwned(null, "brand", "treat_as_ai"), true);
  assertEquals(isAiOwned({ brand: AI_SOURCE }, "brand", "treat_as_ai"), true);
  // The opt-in must not change anything for a field that HAS a record.
  assertEquals(isAiOwned({ brand: AI_SOURCE }, "size", "respect"), false);
  assertEquals(isAiOwned({}, "brand", "respect"), false);
});

Deno.test("buildKnownFields: the untracked opt-in withholds everything on a legacy item", () => {
  // A legacy draft has values and no provenance. Under the opt-in the whole
  // identification is re-derived; under `respect` it is all sent back as
  // ground truth and the pass can only confirm what is there.
  const item = { brand: "Nike", size: "M" };
  assertEquals(
    buildKnownFields(item, COLUMNS, {}, "reidentify", "treat_as_ai"),
    {},
  );
  assertEquals(
    buildKnownFields(item, COLUMNS, {}, "reidentify", "respect"),
    { brand: "Nike", size: "M" },
  );
});

Deno.test("the untracked opt-in never leaks into gap-fill", () => {
  // gap_fill must behave identically no matter what the flag says — an
  // overwrite there would be a silent regression on the original feature.
  const item = { brand: "Nike", size: "M" };
  assertEquals(
    buildKnownFields(item, COLUMNS, {}, "gap_fill", "treat_as_ai"),
    { brand: "Nike", size: "M" },
  );
  assertEquals(
    decideField({
      current: "Nike",
      suggested: "Patagonia",
      confidence: 0.95,
      autoApplyConfidence: 0.85,
      conflicted: false,
      aiOwned: true,
      mode: "gap_fill",
    }),
    "pending",
  );
});

Deno.test("isEmptyValue handles strings, blanks, arrays and nullish", () => {
  assertEquals(isEmptyValue(null), true);
  assertEquals(isEmptyValue(undefined), true);
  assertEquals(isEmptyValue("   "), true);
  assertEquals(isEmptyValue([]), true);
  assertEquals(isEmptyValue("Nike"), false);
  assertEquals(isEmptyValue(["Pockets"]), false);
});

Deno.test("buildKnownFields: gap-fill sends every filled column", () => {
  const item = { brand: "Nike", style: "", size: "M", color: null };
  const known = buildKnownFields(
    item,
    COLUMNS,
    { brand: AI_SOURCE },
    "gap_fill",
  );
  assertEquals(known, { brand: "Nike", size: "M" });
});

Deno.test("buildKnownFields: re-identify withholds the AI's own answers", () => {
  // brand came from an earlier extraction; size was typed by the seller. Only
  // the seller's value is evidence the new pass may lean on.
  const item = { brand: "Nike", size: "M", material: "Cotton" };
  const known = buildKnownFields(
    item,
    COLUMNS,
    { brand: AI_SOURCE, material: AI_SOURCE },
    "reidentify",
  );
  assertEquals(known, { size: "M" });
});

Deno.test("buildExtractText: re-identify drops generated copy when photos exist", () => {
  const parts = {
    title: "Nike Windrunner Jacket Mens L",
    description: "Classic Nike windbreaker.",
    conditionNotes: "Small mark on left cuff.",
  };
  // Gap-fill: everything, unchanged from the pre-US-2817 behaviour.
  assertEquals(
    buildExtractText(parts, true, "gap_fill"),
    "Nike Windrunner Jacket Mens L\nClassic Nike windbreaker.\nSmall mark on left cuff.",
  );
  // Re-identify with photos: the title names the brand under review, so it goes.
  assertEquals(
    buildExtractText(parts, true, "reidentify"),
    "Small mark on left cuff.",
  );
  // Re-identify with NO photos: the text is all there is; withholding it would
  // send an empty prompt and burn an AI action for nothing.
  assertEquals(
    buildExtractText(parts, false, "reidentify"),
    "Nike Windrunner Jacket Mens L\nClassic Nike windbreaker.\nSmall mark on left cuff.",
  );
});

function decide(over: Partial<Parameters<typeof decideField>[0]>) {
  return decideField({
    current: "",
    suggested: "Patagonia",
    confidence: 0.95,
    autoApplyConfidence: 0.85,
    conflicted: false,
    aiOwned: false,
    mode: "gap_fill",
    ...over,
  });
}

Deno.test("decideField: an empty column takes a confident value in both modes", () => {
  assertEquals(decide({}), "apply");
  assertEquals(decide({ mode: "reidentify" }), "apply");
});

Deno.test("decideField: gap-fill never overwrites, AI-written or not", () => {
  assertEquals(decide({ current: "Nike", aiOwned: true }), "pending");
  assertEquals(decide({ current: "Nike", aiOwned: false }), "pending");
});

Deno.test("decideField: re-identify overwrites the AI, never the seller", () => {
  assertEquals(
    decide({ current: "Nike", aiOwned: true, mode: "reidentify" }),
    "replace",
  );
  assertEquals(
    decide({ current: "Nike", aiOwned: false, mode: "reidentify" }),
    "pending",
  );
});

Deno.test("decideField: low confidence or a conflict stays pending", () => {
  assertEquals(
    decide({ current: "Nike", aiOwned: true, mode: "reidentify", confidence: 0.6 }),
    "pending",
  );
  assertEquals(
    decide({ current: "Nike", aiOwned: true, mode: "reidentify", conflicted: true }),
    "pending",
  );
});

Deno.test("decideField: the same answer again is not a change and not a review", () => {
  // This is the difference between "we re-ran 40 drafts and 3 changed" and
  // "40 drafts need review", which is the same run described uselessly.
  assertEquals(
    decide({ current: "Patagonia", aiOwned: true, mode: "reidentify" }),
    "skip",
  );
  assertEquals(
    decide({ current: "patagonia ", aiOwned: true, mode: "reidentify" }),
    "skip",
  );
  assertEquals(decide({ suggested: "   " }), "skip");
});
