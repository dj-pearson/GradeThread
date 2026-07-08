// US-1716: brand-knowledge GOLDEN harness.
//
// A fixture-driven regression gate for the deterministic identification path
// (US-1712 decoders + US-1713 enrichment). Each case is a realistic garment —
// including the CUT-TAG cases the whole epic exists for — asserting that the
// resolver recovers brand/style/size better than the pre-KB baseline. Mirrors
// the grading golden set: adding a decoder/fingerprint must not regress any case
// here, and new brands (US-1718+) append fixtures. A per-brand recovery summary
// is printed so the KB's effect is measurable (AC3).
//
//   deno test --allow-env --allow-net --allow-read \
//     src/tests/brand-knowledge-golden_test.ts
//
// ai-extract.ts imports the supabase-backed resolver at load → dummy env first.
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
import type {
  AttributeSuggestion,
  DecodedExtraction,
  FieldSuggestion,
} from "../lib/ai-extract.ts";
import type {
  BrandKnowledgePack,
  BrandStyleKnowledge,
} from "../lib/brand-knowledge.ts";

// ── fixture builders ────────────────────────────────────────────────────────
function pack(
  brand: string,
  key: string,
  styles: BrandStyleKnowledge[] = [],
): BrandKnowledgePack {
  return {
    brand,
    key,
    known: true,
    aliases: [],
    categoryFocus: [],
    authenticationTells: [],
    tagEras: [],
    styles,
    decoders: [], // empty → decodeTagCode uses the in-code DEFAULT specs
    colorways: [],
    sizingCharts: [],
    source: "fallback",
  };
}

function style(styleName: string): BrandStyleKnowledge {
  return {
    styleName,
    aliases: [],
    productLine: null,
    department: null,
    category: null,
    visualFingerprint: null,
    fabricTech: [],
    era: null,
    msrpBand: null,
    keywords: [],
  };
}

function decodedFrom(
  opts: {
    brand?: string;
    styleName?: string;
    styleCode?: string;
  },
): DecodedExtraction {
  const suggestions: Record<string, FieldSuggestion> = {};
  if (opts.brand) {
    suggestions.brand = {
      value: opts.brand,
      confidence: 0.6,
      source: "photo:front",
    };
  }
  if (opts.styleName) {
    suggestions.style = {
      value: opts.styleName,
      confidence: 0.7,
      source: "photo:tag",
    };
  }
  const attributes: Record<string, AttributeSuggestion> = opts.styleCode
    ? {
      style_code: {
        values: [opts.styleCode],
        confidence: 0.3,
        source: "photo:tag",
      },
    }
    : {};
  return {
    suggestions,
    attributes,
    research: null,
    conditionSummary: null,
    conflicts: [],
    measurements: null,
    ebayCategoryQuery: null,
  };
}

// ── golden cases ────────────────────────────────────────────────────────────
interface GoldenCase {
  name: string;
  brand: string; // for the per-brand recovery summary
  pack: BrandKnowledgePack;
  input: DecodedExtraction;
  expect: {
    brand?: string;
    noBrand?: boolean;
    style?: string;
    noStyle?: boolean;
    conflictOn?: string;
    recovery?: boolean; // counts toward the per-brand recovery rate
  };
}

const CASES: GoldenCase[] = [
  {
    name: "Lululemon cut brand tag — style number recovers the brand",
    brand: "Lululemon",
    pack: pack("Lululemon", "lululemon"),
    input: decodedFrom({ styleCode: "WU1ABC.0119" }), // no AI brand
    expect: { brand: "Lululemon", recovery: true },
  },
  {
    name: "Lululemon style number overrides a wrong AI brand + surfaces conflict",
    brand: "Lululemon",
    pack: pack("Lululemon", "lululemon"),
    input: decodedFrom({ brand: "Nike", styleCode: "WU1ABC.0119" }),
    expect: { brand: "Lululemon", conflictOn: "brand", recovery: true },
  },
  {
    name: "Lululemon AI+decoder agree — no conflict",
    brand: "Lululemon",
    pack: pack("Lululemon", "lululemon"),
    input: decodedFrom({ brand: "Lululemon", styleCode: "MABCR.0322" }),
    expect: { brand: "Lululemon", recovery: true },
  },
  {
    name: "Single known style fills when the AI produced none",
    brand: "Lululemon",
    pack: pack("Lululemon", "lululemon", [style("ABC Pant")]),
    input: decodedFrom({ styleCode: "WU1ABC.0119" }),
    expect: { brand: "Lululemon", style: "ABC Pant", recovery: true },
  },
  {
    name: "Ambiguous styles — never guess a style",
    brand: "Lululemon",
    pack: pack("Lululemon", "lululemon", [
      style("ABC Pant"),
      style("Commission Pant"),
    ]),
    input: decodedFrom({ styleCode: "WU1ABC.0119" }),
    expect: { brand: "Lululemon", noStyle: true, recovery: true },
  },
  {
    name: "Malformed code — no false-positive recovery",
    brand: "Lululemon",
    pack: pack("Lululemon", "lululemon"),
    input: decodedFrom({ styleCode: "NOT-A-CODE" }),
    expect: { noBrand: true },
  },
  {
    name: "Brand with no decoder + no code — clean no-op",
    brand: "Gap",
    pack: pack("Gap", "gap"),
    input: decodedFrom({ brand: "Gap" }),
    expect: { brand: "Gap" },
  },
];

// ── the gate ────────────────────────────────────────────────────────────────
Deno.test("brand-knowledge golden set — all cases recover as expected", () => {
  // per-brand tally: recovered / expected
  const tally = new Map<string, { recovered: number; expected: number }>();
  let confDeltaSum = 0;
  let confDeltaN = 0;

  for (const c of CASES) {
    const before = c.input.suggestions.brand?.confidence ?? 0;
    const { decoded: out } = enrichExtractionWithBrandKnowledge(c.input, c.pack);

    if (c.expect.brand !== undefined) {
      assertEquals(
        out.suggestions.brand?.value,
        c.expect.brand,
        `${c.name}: brand`,
      );
    }
    if (c.expect.noBrand) {
      assertEquals(out.suggestions.brand, undefined, `${c.name}: no brand`);
    }
    if (c.expect.style !== undefined) {
      assertEquals(
        out.suggestions.style?.value,
        c.expect.style,
        `${c.name}: style`,
      );
    }
    if (c.expect.noStyle) {
      assertEquals(out.suggestions.style, undefined, `${c.name}: no style`);
    }
    if (c.expect.conflictOn) {
      assert(
        out.conflicts.some((cf) => cf.field === c.expect.conflictOn),
        `${c.name}: expected a ${c.expect.conflictOn} conflict`,
      );
    }

    if (c.expect.recovery) {
      const t = tally.get(c.brand) ?? { recovered: 0, expected: 0 };
      t.expected += 1;
      if (out.suggestions.brand?.value === c.expect.brand) t.recovered += 1;
      tally.set(c.brand, t);
      const after = out.suggestions.brand?.confidence ?? 0;
      confDeltaSum += after - before;
      confDeltaN += 1;
    }
  }

  // AC3 — measurable per-brand recovery + mean confidence delta.
  const summary = [...tally.entries()]
    .map(([b, t]) =>
      `${b}: ${t.recovered}/${t.expected} (${
        Math.round((t.recovered / t.expected) * 100)
      }%)`
    )
    .join("  ");
  const meanDelta = confDeltaN > 0 ? (confDeltaSum / confDeltaN).toFixed(2) : "0";
  console.log(
    `[brand-golden] recovery — ${summary}  | mean brand-confidence Δ vs pre-KB: +${meanDelta}`,
  );

  // Gate: every recovery-expected case must recover.
  for (const [b, t] of tally) {
    assertEquals(t.recovered, t.expected, `${b} had unrecovered golden cases`);
  }
});
