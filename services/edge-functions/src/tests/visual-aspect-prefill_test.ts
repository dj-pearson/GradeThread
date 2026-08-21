// US-2770 AC5, plus the rules the AC list implies but does not enumerate.
//
// The thing worth guarding is not "does it fill a field" - it is every case
// where it must REFUSE. A prefill that offers an aspect the category does not
// expose, or a value outside a SELECTION_ONLY list, produces a listing eBay
// rejects at PUBLISH, which surfaces as the unrelated "already has active
// offer" error described in vault/30-platform/ebay-aspect-value-limit.md. The
// seller then has a stuck offer and no idea why.

import "./_env.ts";
import { assertEquals } from "@std/assert";
import type { EbayAspectSpec } from "../lib/ai-extract.ts";
import type { VisualAspectEvidence } from "../lib/visual-aspect-consensus.ts";
import {
  MIN_ASPECT_SUPPORT,
  VISUAL_ASPECT_CONFIDENCE_CAP,
  VISUAL_CONSENSUS_SOURCE,
  visualAspectPrefill,
} from "../lib/visual-aspect-prefill.ts";

const spec = (
  name: string,
  over: Partial<EbayAspectSpec> = {},
): EbayAspectSpec => ({
  name,
  required: false,
  cardinality: "SINGLE",
  mode: "FREE_TEXT",
  ...over,
});

function evidence(
  aspects: Record<string, { value: string | null; support: number; declared: number }>,
): VisualAspectEvidence {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(aspects)) {
    out[k] = { ...v, candidates: v.value ? [{ value: v.value, count: v.support }] : [] };
  }
  return {
    aspects: out as VisualAspectEvidence["aspects"],
    listingsRead: 5,
    ownListingsExcluded: 0,
    readFailures: 0,
  };
}

const reasons = (r: ReturnType<typeof visualAspectPrefill>) =>
  Object.fromEntries(r.skipped.map((s) => [s.aspect, s.reason]));

// ── AC5 case 1: fills an empty aspect ───────────────────────────────────────

Deno.test("fills an aspect the category exposes and nobody has set", () => {
  const r = visualAspectPrefill({
    evidence: evidence({ Material: { value: "Nylon", support: 4, declared: 5 } }),
    specs: [spec("Material")],
    existing: {},
  });
  assertEquals(r.suggestions.Material?.values, ["Nylon"]);
  assertEquals(r.suggestions.Material?.source, VISUAL_CONSENSUS_SOURCE);
});

Deno.test("AC2: it is a SUGGESTION, and its confidence is capped", () => {
  // 5 of 5 agreeing is still 5 listings that could not see the tag. If this
  // could reach 1.0 it would outrank something read off the garment, which is
  // the inversion US-2767 exists to prevent.
  const r = visualAspectPrefill({
    evidence: evidence({ Material: { value: "Nylon", support: 5, declared: 5 } }),
    specs: [spec("Material")],
    existing: {},
  });
  assertEquals(r.suggestions.Material?.confidence, VISUAL_ASPECT_CONFIDENCE_CAP);
});

Deno.test("the CATEGORY's spelling of the aspect name is the key", () => {
  // eBay treats "Product Line" and "product line" as different aspects, so the
  // match's casing must never decide the key that gets published.
  const r = visualAspectPrefill({
    evidence: evidence({ "product line": { value: "Nano Puff", support: 3, declared: 3 } }),
    specs: [spec("Product Line")],
    existing: {},
  });
  assertEquals(Object.keys(r.suggestions), ["Product Line"]);
});

// ── AC5 case 2: skips a seller-set aspect ───────────────────────────────────

Deno.test("AC3: an aspect the seller already set is never touched", () => {
  const r = visualAspectPrefill({
    evidence: evidence({ Material: { value: "Nylon", support: 5, declared: 5 } }),
    specs: [spec("Material")],
    existing: { Material: ["Cotton"] },
  });
  assertEquals(r.suggestions, {});
  assertEquals(reasons(r).Material, "already_set");
});

Deno.test("an EMPTY existing array is not 'set', so the gap still fills", () => {
  const r = visualAspectPrefill({
    evidence: evidence({ Material: { value: "Nylon", support: 5, declared: 5 } }),
    specs: [spec("Material")],
    existing: { Material: [] },
  });
  assertEquals(r.suggestions.Material?.values, ["Nylon"]);
});

Deno.test("the model's own answer wins; this only fills gaps", () => {
  const r = visualAspectPrefill({
    evidence: evidence({ Material: { value: "Nylon", support: 5, declared: 5 } }),
    specs: [spec("Material")],
    existing: {},
    modelSuggestions: {
      Material: { values: ["Merino Wool"], confidence: 0.8, source: "photo" },
    },
  });
  assertEquals(r.suggestions, {});
  assertEquals(reasons(r).Material, "model_answered");
});

// ── AC5 case 3: skips an aspect the category does not expose ────────────────

Deno.test("AC1: an aspect this category does not expose is refused", () => {
  // eBay rejects an unknown aspect name at publish, and a suggestion the seller
  // cannot accept is worse than no suggestion.
  const r = visualAspectPrefill({
    evidence: evidence({ Inseam: { value: "32", support: 4, declared: 4 } }),
    specs: [spec("Material"), spec("Pattern")],
    existing: {},
  });
  assertEquals(r.suggestions, {});
  assertEquals(reasons(r).Inseam, "not_exposed_by_category");
});

// ── AC5 case 4: refuses an over-length value ────────────────────────────────

Deno.test("AC4: a value over 65 characters is REFUSED, not truncated", () => {
  // Truncating produces a value the seller never chose, off a garment that is
  // not theirs. 66 chars - one past the limit, so the test fails if the
  // comparison is ever written as >=.
  const long = "x".repeat(66);
  const r = visualAspectPrefill({
    evidence: evidence({ Style: { value: long, support: 5, declared: 5 } }),
    specs: [spec("Style")],
    existing: {},
  });
  assertEquals(r.suggestions, {});
  assertEquals(reasons(r).Style, "too_long");
});

Deno.test("exactly 65 characters is allowed - the boundary is not off by one", () => {
  const at = "y".repeat(65);
  const r = visualAspectPrefill({
    evidence: evidence({ Style: { value: at, support: 5, declared: 5 } }),
    specs: [spec("Style")],
    existing: {},
  });
  assertEquals(r.suggestions.Style?.values, [at]);
});

// ── SELECTION_ONLY, the other publish-time rejection ────────────────────────

Deno.test("a SELECTION_ONLY value outside the allowed list is refused", () => {
  const r = visualAspectPrefill({
    evidence: evidence({ Department: { value: "Ladies", support: 5, declared: 5 } }),
    specs: [
      spec("Department", { mode: "SELECTION_ONLY", allowedValues: ["Women", "Men"] }),
    ],
    existing: {},
  });
  assertEquals(r.suggestions, {});
  assertEquals(reasons(r).Department, "not_an_allowed_value");
});

Deno.test("a SELECTION_ONLY value IN the list is accepted, case-insensitively", () => {
  const r = visualAspectPrefill({
    evidence: evidence({ Department: { value: "women", support: 5, declared: 5 } }),
    specs: [
      spec("Department", { mode: "SELECTION_ONLY", allowedValues: ["Women", "Men"] }),
    ],
    existing: {},
  });
  assertEquals(r.suggestions.Department?.values, ["women"]);
});

Deno.test("a FREE_TEXT aspect is not checked against allowedValues", () => {
  // SUGGESTED/FREE_TEXT aspects carry allowedValues as a hint, not a rule.
  const r = visualAspectPrefill({
    evidence: evidence({ Pattern: { value: "Herringbone", support: 3, declared: 3 } }),
    specs: [spec("Pattern", { mode: "SUGGESTED", allowedValues: ["Solid", "Striped"] })],
    existing: {},
  });
  assertEquals(r.suggestions.Pattern?.values, ["Herringbone"]);
});

// ── Consensus quality ───────────────────────────────────────────────────────

Deno.test("a disagreed aspect offers nothing", () => {
  const r = visualAspectPrefill({
    evidence: evidence({ Material: { value: null, support: 0, declared: 4 } }),
    specs: [spec("Material")],
    existing: {},
  });
  assertEquals(r.suggestions, {});
  assertEquals(reasons(r).Material, "no_consensus");
});

Deno.test("one lone listing is not a consensus", () => {
  assertEquals(MIN_ASPECT_SUPPORT, 2);
  const r = visualAspectPrefill({
    evidence: evidence({ Material: { value: "Nylon", support: 1, declared: 1 } }),
    specs: [spec("Material")],
    existing: {},
  });
  assertEquals(r.suggestions, {});
  assertEquals(reasons(r).Material, "below_min_support");
});

Deno.test("no evidence at all is an empty result, not a throw", () => {
  const r = visualAspectPrefill({ evidence: null, specs: [spec("Material")], existing: {} });
  assertEquals(r.suggestions, {});
  assertEquals(r.skipped, []);
});

Deno.test("every refusal is RECORDED, so a silent zero is distinguishable", () => {
  // "no suggestions" and "four suggestions we threw away" look identical
  // afterwards, and only one of them means this feature is not working.
  const r = visualAspectPrefill({
    evidence: evidence({
      Material: { value: "Nylon", support: 5, declared: 5 },
      Inseam: { value: "32", support: 4, declared: 4 },
      Style: { value: "z".repeat(80), support: 4, declared: 4 },
      Pattern: { value: null, support: 0, declared: 3 },
    }),
    specs: [spec("Material"), spec("Style"), spec("Pattern")],
    existing: { Material: ["Cotton"] },
  });
  assertEquals(r.suggestions, {});
  assertEquals(r.skipped.length, 4);
  assertEquals(reasons(r), {
    Material: "already_set",
    Inseam: "not_exposed_by_category",
    Style: "too_long",
    Pattern: "no_consensus",
  });
});
