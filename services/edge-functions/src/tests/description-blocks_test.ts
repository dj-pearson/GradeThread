// US-2957: the pure description-block renderer, legacy parser and fact scrubber.
// Pure functions — no Anthropic/Supabase/env.
//   deno test --allow-read src/tests/description-blocks_test.ts
//
// The round-trip tests are the ones that matter. Convert-on-open (US-2960) only
// works if parsing a legacy description and re-rendering it gives back the same
// bytes, because the seller has to be able to open a live listing and see that
// nothing moved before they touch anything.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  type DescriptionBlock,
  defaultBlocks,
  parseLegacyDescription,
  type RenderContext,
  renderDescription,
  scrubRestatedFacts,
} from "../lib/description-blocks.ts";
import {
  MEASUREMENTS_BLOCK_END,
  MEASUREMENTS_BLOCK_START,
} from "../lib/measurements.ts";
import { SELLER_CREDENTIALS_MARKER } from "../lib/seller-credentials.ts";
import {
  FACTS_MARKER_END,
  FACTS_MARKER_START,
} from "../lib/listing-facts-block.ts";
import { DISCLOSURE_MARKER } from "../lib/description-blocks.ts";

// ─── Fixtures ──────────────────────────────────────────────────────

function ctx(over: Partial<RenderContext> = {}): RenderContext {
  return {
    item: {
      brand: "Veronica Beard",
      size: "8",
      color: "Black",
      material: null,
      measurements: {
        waist: 15,
        inseam: 29,
        rise: 10,
        length: 39.5,
        width: 18,
      },
    },
    grade: null,
    credential: null,
    snippets: {},
    unit: "in",
    ...over,
  };
}

const CREDENTIAL = {
  handle: "pearson",
  display_name: "Pearson Mercantile",
  stats: { total_graded: 23, average_grade: 8.3 },
};

/**
 * The 2026-08 listing that started US-2956, verbatim.
 *
 * Three things make it a good fixture and not just a long string: the prose
 * restates measurements the block below contradicts (18in waist vs 30in), the
 * credential block sits BEFORE the measurements block rather than last, and the
 * gap between them is three newlines rather than the two a fresh render would
 * emit. A parser that normalises whitespace fails this test, which is the point.
 */
const VERONICA_BEARD = [
  "Veronica Beard jogger-style pants, new with tags.",
  "",
  "- Brand: Veronica Beard",
  "- Size: 8",
  "- Color: Black",
  "- Style: Pull-on jogger pants with elastic drawstring waist, side pockets, satin side trim, elastic cuffs",
  "- Condition: New with tags",
  '- Measurements (approx, laid flat): Waist 18" across, Length 41.5"',
  "",
  "Condition: Brand new, never worn, with original tags still attached. No flaws noted.",
  "",
  "Please review measurements and photos carefully before purchase. Smoke-free environment.",
  '<!--gradethread-seller-credentials--><div style="border:1px solid #e5e7eb;border-radius:8px;padding:14px 16px;font:14px/1.5 system-ui,sans-serif"><div style="font-weight:700;color:#0F3460;margin-bottom:6px">✓ GradeThread Verified Seller — Pearson Mercantile</div><div style="margin-bottom:8px">23 items independently graded · <strong>8.3 / 10</strong> average condition grade</div><div style="color:#0F3460;font-weight:600">Verify grades at GradeThread — seller &quot;pearson&quot;</div></div>',
  "",
  "",
  MEASUREMENTS_BLOCK_START,
  "Measurements (garment laid flat):",
  "- Waist (flat): 30 in (15 in flat)",
  "- Inseam: 29 in",
  "- Front rise: 10 in",
  "- Length: 39.5 in",
  "- Width: 18 in",
  MEASUREMENTS_BLOCK_END,
].join("\n");

// ─── AC1: the module is pure ───────────────────────────────────────

Deno.test("AC1: the module exports the four entry points and does no I/O", async () => {
  assertEquals(typeof renderDescription, "function");
  assertEquals(typeof parseLegacyDescription, "function");
  assertEquals(typeof defaultBlocks, "function");
  assertEquals(typeof scrubRestatedFacts, "function");

  const src = await Deno.readTextFile(
    new URL("../lib/description-blocks.ts", import.meta.url),
  );
  assert(!/from\s+"\.\/supabase\.ts"/.test(src), "must not import the db client");
  assert(!/Deno\.env/.test(src), "must not read env");
  assert(!/\bfetch\s*\(/.test(src), "must not make network calls");
});

// ─── AC2: order, and facts last ────────────────────────────────────

Deno.test("AC2: blocks render in array order", () => {
  const blocks: DescriptionBlock[] = [
    { key: "text", on: true, src: "user", text: "second" },
    { key: "intro", on: true, src: "ai", text: "first" },
  ];
  assertEquals(renderDescription(blocks, ctx()), "second\n\nfirst");
});

Deno.test("AC2: the facts block is emitted LAST however it is ordered", () => {
  const blocks: DescriptionBlock[] = [
    { key: "facts", on: true, src: "system" },
    { key: "intro", on: true, src: "ai", text: "Opening line." },
  ];
  const out = renderDescription(blocks, ctx());
  assert(out.startsWith("Opening line."), `facts jumped the queue: ${out}`);
  assert(out.trimEnd().endsWith(FACTS_MARKER_END));
});

// ─── AC3: an off block, and an empty block ─────────────────────────

Deno.test("AC3: an off block contributes nothing, not even a blank line", () => {
  const blocks: DescriptionBlock[] = [
    { key: "intro", on: true, src: "ai", text: "A" },
    { key: "features", on: false, src: "ai", text: "B" },
    { key: "condition", on: true, src: "ai", text: "C" },
  ];
  assertEquals(renderDescription(blocks, ctx()), "A\n\nC");
});

Deno.test("AC3: an attributes block with nothing to show renders empty", () => {
  const blocks: DescriptionBlock[] = [
    { key: "attributes", on: true, src: "item" },
  ];
  const bare = ctx({
    item: { brand: null, size: null, color: null, material: null, measurements: null },
  });
  assertEquals(renderDescription(blocks, bare), "");
});

Deno.test("AC3: an empty derived block leaves no orphan heading between prose", () => {
  const blocks: DescriptionBlock[] = [
    { key: "intro", on: true, src: "ai", text: "A" },
    { key: "measurements", on: true, src: "item" },
    { key: "condition", on: true, src: "ai", text: "C" },
  ];
  const noMeasure = ctx({
    item: { brand: "X", size: null, color: null, material: null, measurements: null },
  });
  assertEquals(renderDescription(blocks, noMeasure), "A\n\nC");
});

// ─── AC4: idempotence ──────────────────────────────────────────────

Deno.test("AC4: rendering twice gives the same string", () => {
  const blocks = defaultBlocks();
  blocks[0].text = "Opening line.";
  const c = ctx({ credential: CREDENTIAL });
  assertEquals(renderDescription(blocks, c), renderDescription(blocks, c));
});

Deno.test("AC4: parse then re-render returns the same string", () => {
  const c = ctx({ credential: CREDENTIAL });
  const once = renderDescription(defaultBlocksWithText(), c);
  const twice = renderDescription(parseLegacyDescription(once, c), c);
  assertEquals(twice, once);
});

function defaultBlocksWithText(): DescriptionBlock[] {
  const blocks = defaultBlocks();
  for (const b of blocks) {
    if (b.key === "intro") b.text = "Veronica Beard jogger pants.";
    if (b.key === "features") b.text = "Pull-on with an elastic drawstring waist.";
    if (b.key === "condition") b.text = "New with tags, never worn.";
  }
  return blocks;
}

// ─── AC5: the existing builders are reused, markers survive ────────

Deno.test("AC5: the four markers appear when their blocks are on", () => {
  const blocks: DescriptionBlock[] = [
    { key: "measurements", on: true, src: "item" },
    { key: "disclosure", on: true, src: "grade" },
    { key: "credentials", on: true, src: "seller" },
    { key: "facts", on: true, src: "system" },
  ];
  const out = renderDescription(
    blocks,
    ctx({
      credential: CREDENTIAL,
      grade: {
        overall_score: 8.3,
        factors: [{ label: "Fabric", score: 8.5 }],
        disclosure: {
          overall_score: 8.3,
          grade_tier: "excellent",
          defects_found: [],
        },
      },
    }),
  );
  assertStringIncludes(out, MEASUREMENTS_BLOCK_START);
  assertStringIncludes(out, MEASUREMENTS_BLOCK_END);
  assertStringIncludes(out, DISCLOSURE_MARKER);
  assertStringIncludes(out, SELLER_CREDENTIALS_MARKER);
  assertStringIncludes(out, FACTS_MARKER_START);
});

// ─── AC6: the real listing round-trips byte for byte ───────────────

Deno.test("AC6: the Veronica Beard description round-trips byte for byte", () => {
  const c = ctx({ credential: CREDENTIAL });
  const blocks = parseLegacyDescription(VERONICA_BEARD, c);
  assertEquals(renderDescription(blocks, c), VERONICA_BEARD);
});

Deno.test("AC6: the parse recognises the real blocks, not one blob", () => {
  const c = ctx({ credential: CREDENTIAL });
  const keys = parseLegacyDescription(VERONICA_BEARD, c).map((b) => b.key);
  assertStringIncludes(keys.join(","), "credentials");
  assertStringIncludes(keys.join(","), "measurements");
  assert(keys.includes("text"), "the prose must survive as a text block");
});

Deno.test("AC6: a derived block that does NOT reproduce is downgraded to text", () => {
  // The stored measurements no longer match what the description says, which is
  // the exact drift this epic exists to fix. Conversion must not silently
  // rewrite a live listing, so the block becomes verbatim text instead.
  const drifted = ctx({
    credential: CREDENTIAL,
    item: {
      brand: "Veronica Beard",
      size: "8",
      color: "Black",
      material: null,
      measurements: { waist: 99, inseam: 1 },
    },
  });
  const blocks = parseLegacyDescription(VERONICA_BEARD, drifted);
  assertEquals(renderDescription(blocks, drifted), VERONICA_BEARD);
});

// ─── AC7: degrade rather than drop characters ──────────────────────

Deno.test("AC7: a description with no marker parses to a single text block", () => {
  const plain = "Just some prose.\n\nAnd a second paragraph.";
  const blocks = parseLegacyDescription(plain);
  assertEquals(blocks.length, 1);
  assertEquals(blocks[0].key, "text");
  assertEquals(renderDescription(blocks, ctx()), plain);
});

Deno.test("AC7: an unterminated marker degrades to a single text block", () => {
  const broken = `Prose here.\n${MEASUREMENTS_BLOCK_START}\n- Waist: 30 in\nno end marker`;
  const blocks = parseLegacyDescription(broken);
  assertEquals(blocks.length, 1);
  assertEquals(blocks[0].key, "text");
  assertEquals(renderDescription(blocks, ctx()), broken);
});

Deno.test("AC7: an empty description parses to no blocks and renders empty", () => {
  assertEquals(parseLegacyDescription("").length, 0);
  assertEquals(renderDescription([], ctx()), "");
});

// ─── AC8: the fact scrubber ────────────────────────────────────────

Deno.test("AC8: scrubRestatedFacts removes labelled fact lines", () => {
  const text = [
    "Veronica Beard jogger-style pants, new with tags.",
    "",
    "- Brand: Veronica Beard",
    "- Size: 8",
    "- Color: Black",
    "- Condition: New with tags",
    '- Measurements (approx, laid flat): Waist 18" across',
    "",
    "Great everyday pants.",
  ].join("\n");
  const out = scrubRestatedFacts(text, ctx());
  assert(!out.includes("- Brand:"), out);
  assert(!out.includes("- Size:"), out);
  assert(!out.includes("- Color:"), out);
  assert(!out.includes("- Condition:"), out);
  assert(!out.includes("- Measurements"), out);
  assertStringIncludes(out, "Veronica Beard jogger-style pants, new with tags.");
  assertStringIncludes(out, "Great everyday pants.");
});

Deno.test("AC8: a prose sentence mentioning size is left alone", () => {
  const text = "Runs true to size and the waist sits high.";
  assertEquals(scrubRestatedFacts(text, ctx()), text);
});

Deno.test("AC8: the scrubber never cuts inside a line", () => {
  const text = "Roomy through the hip: Size up if you are between sizes.";
  assertEquals(scrubRestatedFacts(text, ctx()), text);
});

// ─── AC9: snippets ─────────────────────────────────────────────────

Deno.test("AC9: a snippet renders the referenced body", () => {
  const blocks: DescriptionBlock[] = [
    { key: "snippet", on: true, src: "account", ref: "s1" },
  ];
  const c = ctx({ snippets: { s1: "Smoke-free environment." } });
  assertEquals(renderDescription(blocks, c), "Smoke-free environment.");
});

Deno.test("AC9: a snippet whose ref matches nothing renders empty and does not throw", () => {
  const blocks: DescriptionBlock[] = [
    { key: "intro", on: true, src: "ai", text: "A" },
    { key: "snippet", on: true, src: "account", ref: "gone" },
  ];
  assertEquals(renderDescription(blocks, ctx()), "A");
});

Deno.test("AC9: per-listing text overrides the referenced snippet body", () => {
  const blocks: DescriptionBlock[] = [
    { key: "snippet", on: true, src: "account", ref: "s1", text: "Ships in 24 hours." },
  ];
  const c = ctx({ snippets: { s1: "Smoke-free environment." } });
  assertEquals(renderDescription(blocks, c), "Ships in 24 hours.");
});

// ─── Attributes and grade, the two new derived blocks ──────────────

Deno.test("attributes renders the named fields, in order, skipping blanks", () => {
  const blocks: DescriptionBlock[] = [
    { key: "attributes", on: true, src: "item", fields: ["brand", "size", "color", "material"] },
  ];
  assertEquals(
    renderDescription(blocks, ctx()),
    "- Brand: Veronica Beard\n- Size: 8\n- Color: Black",
  );
});

Deno.test("the grade block matches the phrase publish keys on", () => {
  const blocks: DescriptionBlock[] = [{ key: "grade", on: true, src: "grade" }];
  const c = ctx({
    grade: { overall_score: 8.3, factors: [], disclosure: null },
  });
  assertStringIncludes(renderDescription(blocks, c), "Condition Grade 8.3");
});

Deno.test("the grade block renders empty when the item is not graded", () => {
  const blocks: DescriptionBlock[] = [{ key: "grade", on: true, src: "grade" }];
  assertEquals(renderDescription(blocks, ctx()), "");
});

Deno.test("defaultBlocks is a sane starting order and ends with facts", () => {
  const keys = defaultBlocks().map((b) => b.key);
  assertEquals(keys[0], "intro");
  assertEquals(keys[keys.length - 1], "facts");
  assert(keys.includes("attributes"));
  assert(keys.includes("measurements"));
});
