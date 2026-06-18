// US-1067: few-shot exemplar cache from human-corrected grades.
//
// Covers the PURE curation + rendering logic (selectExemplars, buildExemplarBlock,
// isHighSignalSignal, estimateTokens). few-shot-exemplars.ts transitively imports
// the service-role supabase client (reads env at module load), so set dummy env
// FIRST then dynamic-import — the functions under test touch no DB.
//
//   deno test --allow-env src/tests/few-shot-exemplars_test.ts

import { assert, assertEquals } from "@std/assert";

Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);

const {
  selectExemplars,
  buildExemplarBlock,
  isHighSignalSignal,
  estimateTokens,
  DEFAULT_TOTAL_CAP,
} = await import("../lib/few-shot-exemplars.ts");

type Sig = {
  garment_category: string;
  garment_type: string;
  ai_overall_score: number;
  corrected_overall_score: number;
  intentional_misread: boolean;
  reviewed_at: string;
};

function sig(p: Partial<Sig>): Sig {
  return {
    garment_category: "jeans",
    garment_type: "bottoms",
    ai_overall_score: 5,
    corrected_overall_score: 8,
    intentional_misread: false,
    reviewed_at: "2026-01-01T00:00:00.000Z",
    ...p,
  };
}

Deno.test("isHighSignalSignal: misread is always high-signal even at zero delta", () => {
  assert(
    isHighSignalSignal(
      sig({ ai_overall_score: 7, corrected_overall_score: 7, intentional_misread: true }),
      1.0,
    ),
  );
});

Deno.test("isHighSignalSignal: small correction below min_delta is not high-signal", () => {
  assertEquals(
    isHighSignalSignal(
      sig({ ai_overall_score: 7, corrected_overall_score: 7.5, intentional_misread: false }),
      1.0,
    ),
    false,
  );
});

Deno.test("selectExemplars: drops low-signal + unknown-category rows", () => {
  const out = selectExemplars([
    sig({ ai_overall_score: 7, corrected_overall_score: 7.5 }), // below delta
    sig({ garment_category: "unknown", ai_overall_score: 4, corrected_overall_score: 9 }),
    sig({ garment_category: "", ai_overall_score: 4, corrected_overall_score: 9 }),
    sig({ garment_category: "jeans", ai_overall_score: 4, corrected_overall_score: 9 }),
  ]);
  assertEquals(out.length, 1);
  assertEquals(out[0].garment_category, "jeans");
});

Deno.test("selectExemplars: misreads rank ahead of larger plain deltas within a category", () => {
  const out = selectExemplars([
    sig({ ai_overall_score: 2, corrected_overall_score: 9, intentional_misread: false }), // delta 7
    sig({ ai_overall_score: 6, corrected_overall_score: 8, intentional_misread: true }), // delta 2 misread
  ]);
  assertEquals(out.length, 2);
  assert(out[0].intentional_misread, "misread should sort first");
});

Deno.test("selectExemplars: respects per-category cap", () => {
  const signals = Array.from({ length: 10 }, (_, i) =>
    sig({ ai_overall_score: 3, corrected_overall_score: 9, reviewed_at: `2026-01-${10 + i}T00:00:00Z` }),
  );
  const out = selectExemplars(signals, { perCategoryCap: 3, totalCap: 100 });
  assertEquals(out.length, 3);
});

Deno.test("selectExemplars: respects total cap and balances across categories", () => {
  const signals = [
    ...Array.from({ length: 8 }, () => sig({ garment_category: "jeans" })),
    ...Array.from({ length: 8 }, () => sig({ garment_category: "jacket" })),
  ];
  const out = selectExemplars(signals, { perCategoryCap: 8, totalCap: 4 });
  assertEquals(out.length, 4);
  // Round-robin: both categories represented, not 4 of one.
  const cats = new Set(out.map((e) => e.garment_category));
  assertEquals(cats.size, 2);
});

Deno.test("selectExemplars: default total cap bounds the set", () => {
  const signals = Array.from({ length: 200 }, (_, i) =>
    sig({ garment_category: `cat${i % 30}`, ai_overall_score: 3, corrected_overall_score: 9 }),
  );
  const out = selectExemplars(signals);
  assert(out.length <= DEFAULT_TOTAL_CAP);
});

Deno.test("buildExemplarBlock: empty set renders nothing", () => {
  assertEquals(buildExemplarBlock([]), "");
});

Deno.test("buildExemplarBlock: renders scores, misread tag, and contains no PII fields", () => {
  const out = selectExemplars([
    sig({ ai_overall_score: 4, corrected_overall_score: 8, intentional_misread: true }),
  ]);
  const block = buildExemplarBlock(out);
  assert(block.includes("jeans/bottoms"));
  assert(block.includes("AI 4.0 → corrected 8.0"));
  assert(block.includes("intentional-design misread"));
  // No identity / free-text leakage — the block is built only from numeric +
  // category facts.
  assert(!block.toLowerCase().includes("user"));
  assert(!block.toLowerCase().includes("notes"));
});

Deno.test("estimateTokens: roughly chars/4 and zero for empty", () => {
  assertEquals(estimateTokens(""), 0);
  assertEquals(estimateTokens("abcd"), 1);
  assert(estimateTokens("a".repeat(400)) === 100);
});
