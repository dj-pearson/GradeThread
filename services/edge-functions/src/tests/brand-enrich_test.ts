// US-1713: enrichExtractionWithBrandKnowledge — deterministic post-extraction
// enrichment (brand confirmation from a decoder, size override, fingerprint
// fill). ai-extract.ts imports the supabase-backed resolver at load, so set
// dummy env BEFORE the dynamic import (sibling pattern).
import { assert, assertEquals } from "@std/assert";

Deno.env.set(
  "SUPABASE_URL",
  Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321",
);
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);

const { enrichExtractionWithBrandKnowledge } = await import(
  "../lib/ai-extract.ts"
);
import type { DecodedExtraction } from "../lib/ai-extract.ts";
import type {
  BrandKnowledgePack,
  BrandStyleKnowledge,
} from "../lib/brand-knowledge.ts";

// ── fixtures ────────────────────────────────────────────────────────────────
function pack(over: Partial<BrandKnowledgePack> = {}): BrandKnowledgePack {
  return {
    brand: "Lululemon",
    key: "lululemon",
    known: true,
    aliases: [],
    categoryFocus: [],
    authenticationTells: [],
    tagEras: [],
    styles: [],
    decoders: [], // empty → decodeTagCode falls back to in-code DEFAULT specs
    colorways: [],
    sizingCharts: [],
    source: "fallback",
    ...over,
  };
}

function decoded(over: Partial<DecodedExtraction> = {}): DecodedExtraction {
  return {
    suggestions: {},
    attributes: {},
    research: null,
    conditionSummary: null,
    conflicts: [],
    measurements: null,
    ebayCategoryQuery: null,
    visualRulings: [],
    ...over,
  };
}

function styleCodeAttr(code: string) {
  return {
    style_code: { values: [code], confidence: 0.3, source: "photo:tag" },
  };
}

const STYLE = (
  over: Partial<BrandStyleKnowledge> = {},
): BrandStyleKnowledge => ({
  styleName: "ABC Pant",
  aliases: [],
  productLine: "ABC",
  department: "Men",
  category: "pant",
  visualFingerprint: "gusseted crotch + zippered back pocket",
  fabricTech: ["Warpstreme"],
  era: null,
  msrpBand: null,
  keywords: ["abc", "pant"],
  ...over,
});

// ── the killer case: a legible Lululemon style code recovers the brand ──────
Deno.test("brand is confirmed from a Lululemon style code even when AI missed it", () => {
  const input = decoded({ attributes: styleCodeAttr("WA1234B.0322") });
  const { decoded: out, diagnostics } = enrichExtractionWithBrandKnowledge(
    input,
    pack(),
  );
  assertEquals(out.suggestions.brand?.value, "Lululemon");
  assertEquals(out.suggestions.brand?.source, "decoder");
  assert(diagnostics.decoderHits.length === 1);
  assertEquals(diagnostics.overrides[0]?.field, "brand");
});

// ── decoder wins over a wrong AI brand ──────────────────────────────────────
Deno.test("decoder overrides a conflicting AI brand", () => {
  const input = decoded({
    suggestions: {
      brand: { value: "Nike", confidence: 0.6, source: "photo:front" },
    },
    attributes: styleCodeAttr("WA1234B.0322"),
  });
  const { decoded: out } = enrichExtractionWithBrandKnowledge(input, pack());
  assertEquals(out.suggestions.brand?.value, "Lululemon");
  assertEquals(out.suggestions.brand?.source, "decoder");
});

// ── no override when the AI already agrees ──────────────────────────────────
Deno.test("no override when the AI brand already matches", () => {
  const input = decoded({
    suggestions: {
      brand: { value: "Lululemon", confidence: 0.9, source: "photo:tag" },
    },
    attributes: styleCodeAttr("WA1234B.0322"),
  });
  const { decoded: out, diagnostics } = enrichExtractionWithBrandKnowledge(
    input,
    pack(),
  );
  assertEquals(out.suggestions.brand?.source, "photo:tag"); // unchanged
  assertEquals(diagnostics.overrides.length, 0);
});

// ── conservative style fingerprint fill (only when unambiguous) ─────────────
Deno.test("fills style from a single pack style when the AI produced none", () => {
  const input = decoded();
  const { decoded: out } = enrichExtractionWithBrandKnowledge(
    input,
    pack({ styles: [STYLE()] }),
  );
  assertEquals(out.suggestions.style?.value, "ABC Pant");
  assertEquals(out.suggestions.style?.source, "pack-fingerprint");
});

Deno.test("does NOT guess a style when the pack has multiple", () => {
  const input = decoded();
  const { decoded: out } = enrichExtractionWithBrandKnowledge(
    input,
    pack({ styles: [STYLE(), STYLE({ styleName: "Commission Pant" })] }),
  );
  assertEquals(out.suggestions.style, undefined);
});

Deno.test("never overwrites an observed style", () => {
  const input = decoded({
    suggestions: {
      style: { value: "Observed Style", confidence: 0.8, source: "photo:tag" },
    },
  });
  const { decoded: out } = enrichExtractionWithBrandKnowledge(
    input,
    pack({ styles: [STYLE()] }),
  );
  assertEquals(out.suggestions.style?.value, "Observed Style");
});

// ── no-op safety: empty pack + no code → unchanged, no overrides ────────────
Deno.test("no-op when there is no code and no pack knowledge", () => {
  const input = decoded({
    suggestions: {
      brand: { value: "Gap", confidence: 0.7, source: "photo:tag" },
    },
  });
  const { decoded: out, diagnostics } = enrichExtractionWithBrandKnowledge(
    input,
    pack({ brand: "Gap", key: "gap" }),
  );
  assertEquals(out.suggestions.brand?.value, "Gap");
  assertEquals(diagnostics.overrides.length, 0);
  assertEquals(diagnostics.decoderHits.length, 0);
});

// ── US-1714: a decoder override of a DIFFERENT AI value surfaces a conflict ──
Deno.test("decoder-vs-AI disagreement is surfaced as a conflict", () => {
  const input = decoded({
    suggestions: {
      brand: { value: "Nike", confidence: 0.6, source: "photo:front" },
    },
    attributes: styleCodeAttr("WA1234B.0322"),
  });
  const { decoded: out } = enrichExtractionWithBrandKnowledge(input, pack());
  const conflict = out.conflicts.find((c) => c.field === "brand");
  assert(conflict, "expected a brand conflict");
  assertEquals(conflict!.text_value, "Lululemon"); // the tag-code decode
  assertEquals(conflict!.photo_value, "Nike"); // the AI's visual read
});

Deno.test("no conflict is surfaced when the AI had no brand to disagree with", () => {
  const input = decoded({ attributes: styleCodeAttr("WA1234B.0322") });
  const { decoded: out } = enrichExtractionWithBrandKnowledge(input, pack());
  assertEquals(out.conflicts.length, 0);
  assertEquals(out.suggestions.brand?.value, "Lululemon");
});

// ── US-1714: grounded confidence composes as max, capped at 1 ────────────────
Deno.test("grounded confidence takes the max and never exceeds 1", () => {
  // AI already very confident; decoder (0.9) must not lower it, cap holds.
  const input = decoded({
    suggestions: {
      brand: { value: "Nike", confidence: 0.99, source: "photo:tag" },
    },
    attributes: styleCodeAttr("WA1234B.0322"),
  });
  const { decoded: out } = enrichExtractionWithBrandKnowledge(input, pack());
  assertEquals(out.suggestions.brand?.value, "Lululemon");
  assert((out.suggestions.brand?.confidence ?? 0) <= 1);
  assertEquals(out.suggestions.brand?.confidence, 0.99); // max(0.99, 0.9)
});
