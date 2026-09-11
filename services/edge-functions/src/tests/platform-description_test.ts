// The extension marketplaces' dynamic description (platform-description.ts).
// Pure functions — no Supabase, no Anthropic, no env.
//   deno test --allow-read src/tests/platform-description_test.ts
//
// The test that matters is "a fact changes and every channel moves". Everything
// else here exists to stop a fix for one channel from breaking that.

// US-2379: first, before anything that reaches lib/supabase.ts at import time.
import "./_env.ts";

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  capDescription,
  channelDescription,
  platformDescriptionBlocks,
  renderPlatformDescription,
  stripDerivedSections,
} from "../lib/platform-description.ts";
import {
  type DescriptionBlock,
  defaultBlocks,
  type RenderContext,
} from "../lib/description-blocks.ts";

// ─── Fixtures ──────────────────────────────────────────────────────

function ctx(over: Partial<RenderContext> = {}): RenderContext {
  return {
    item: {
      brand: "Veronica Beard",
      size: "8",
      color: "Black",
      material: "Cotton",
      measurements: { waist: 15, inseam: 29, length: 39.5 },
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

/** The prose the AI writes for one platform, with no derived facts in it. */
const PROSE = "Veronica Beard joggers. Satin side trim, elastic cuffs.";

function blocksWithProse(): DescriptionBlock[] {
  const b = defaultBlocks();
  return b.map((x) => (x.key === "intro" ? { ...x, text: "eBay wording" } : x));
}

// ─── The point of the whole module ─────────────────────────────────

Deno.test("a measurement correction changes what every platform sends", () => {
  const blocks = blocksWithProse();
  const before = renderPlatformDescription(blocks, ctx(), { prose: PROSE });
  const after = renderPlatformDescription(
    blocks,
    ctx({
      item: {
        brand: "Veronica Beard",
        size: "8",
        color: "Black",
        material: "Cotton",
        measurements: { waist: 16, inseam: 29, length: 39.5 },
      },
    }),
    { prose: PROSE },
  );

  assertStringIncludes(before, "15 in");
  assertStringIncludes(after, "16 in");
  assert(before !== after, "the render did not follow the measurement");
  // The words the seller (or the AI) wrote are untouched by a fact changing.
  assertStringIncludes(after, PROSE);
});

Deno.test("a newly verified seller reaches every platform with no regeneration", () => {
  const blocks = blocksWithProse();
  const anon = renderPlatformDescription(blocks, ctx(), { prose: PROSE });
  const verified = renderPlatformDescription(
    blocks,
    ctx({ credential: CREDENTIAL }),
    { prose: PROSE },
  );

  assertEquals(anon.includes("GradeThread Verified Seller"), false);
  assertStringIncludes(verified, "GradeThread Verified Seller");
  assertStringIncludes(verified, "Pearson Mercantile");
});

// ─── Plain text, not markup ────────────────────────────────────────

Deno.test("nothing HTML-shaped survives to a marketplace that prints tags", () => {
  const out = renderPlatformDescription(
    blocksWithProse(),
    ctx({ credential: CREDENTIAL }),
    { prose: PROSE },
  );
  assertEquals(/<[a-z/!]/i.test(out), false, `markup leaked: ${out}`);
});

Deno.test("the facts block is dropped rather than flattened", () => {
  const blocks: DescriptionBlock[] = [
    { key: "intro", on: true, src: "ai", text: "" },
    { key: "facts", on: true, src: "system" },
  ];
  const kept = platformDescriptionBlocks(blocks, PROSE);
  assertEquals(kept.some((b) => b.key === "facts"), false);
});

// ─── Prose placement ───────────────────────────────────────────────

Deno.test("the platform's words replace the eBay prose, not sit under it", () => {
  const out = renderPlatformDescription(blocksWithProse(), ctx(), { prose: PROSE });
  assertStringIncludes(out, PROSE);
  assertEquals(out.includes("eBay wording"), false);
});

Deno.test("features and condition switch off so the eBay copy cannot double up", () => {
  const blocks: DescriptionBlock[] = [
    { key: "intro", on: true, src: "ai", text: "eBay intro" },
    { key: "features", on: true, src: "ai", text: "eBay features" },
    { key: "condition", on: true, src: "ai", text: "eBay condition" },
  ];
  const out = renderPlatformDescription(blocks, ctx(), { prose: PROSE });
  assertEquals(out, PROSE);
});

Deno.test("a listing whose intro block was deleted still carries the prose", () => {
  const blocks: DescriptionBlock[] = [
    { key: "attributes", on: true, src: "item" },
  ];
  const out = renderPlatformDescription(blocks, ctx(), { prose: PROSE });
  assert(out.startsWith(PROSE), out);
  assertStringIncludes(out, "- Brand: Veronica Beard");
});

Deno.test("no prose leaves the block array alone", () => {
  const blocks = blocksWithProse();
  const out = platformDescriptionBlocks(blocks, "");
  // Same entries, same objects, minus facts. Nothing rewritten.
  assertEquals(out.length, blocks.length - 1);
  for (const b of out) assert(blocks.includes(b), `${b.key} was copied for nothing`);
});

// ─── The legacy variants already in the wild ───────────────────────

Deno.test("an appended measurements section is removed before the block re-adds it", () => {
  const legacy = [
    PROSE,
    "",
    "Measurements (garment laid flat):",
    "- Waist (flat): 30 in (15 in flat)",
    "- Inseam: 29 in",
  ].join("\n");
  assertEquals(stripDerivedSections(legacy), PROSE);

  // End to end: exactly one measurements heading in the output.
  const out = renderPlatformDescription(blocksWithProse(), ctx(), { prose: legacy });
  const headings = out.split("Measurements (garment laid flat)").length - 1;
  assertEquals(headings, 1, out);
});

Deno.test("an appended credential block is removed before the block re-adds it", () => {
  const legacy = [
    PROSE,
    "",
    "GradeThread Verified Seller",
    "Pearson Mercantile",
    "23 items independently graded • Average condition grade 8.3 / 10",
    'Verify grades at GradeThread — seller "pearson"',
  ].join("\n");
  assertEquals(stripDerivedSections(legacy), PROSE);

  const out = renderPlatformDescription(
    blocksWithProse(),
    ctx({ credential: CREDENTIAL }),
    { prose: legacy },
  );
  assertEquals(out.split("GradeThread Verified Seller").length - 1, 1, out);
});

Deno.test("a seller sentence that merely mentions measurements survives", () => {
  const prose = "Please review the measurements before buying. Measurements are approximate.";
  assertEquals(stripDerivedSections(prose), prose);
});

// ─── The cap ───────────────────────────────────────────────────────

Deno.test("the cap cuts on a boundary and never adds an ellipsis", () => {
  const text = "aaaa bbbb cccc dddd eeee ffff";
  const out = capDescription(text, 20);
  assert(out.length <= 20, out);
  assertEquals(out.endsWith("…"), false);
  assertEquals(out.endsWith("..."), false);
  // Cut on the space, so no half word.
  assertEquals(text.startsWith(out), true);
  assertEquals(out.endsWith(" "), false);
});

Deno.test("a null cap and a short string are both left exactly alone", () => {
  assertEquals(capDescription("short", null), "short");
  assertEquals(capDescription("short", 5000), "short");
  assertEquals(capDescription("short", 5), "short");
});

Deno.test("a hard cut is preferred to throwing away most of the allowance", () => {
  // The only boundary is at index 2, far below 60% of the limit — accepting it
  // would return "aa" for a 100-char allowance.
  const text = "aa " + "b".repeat(200);
  const out = capDescription(text, 100);
  assertEquals(out.length, 100);
});

Deno.test("Poshmark's 1500-character limit is respected end to end", () => {
  const out = renderPlatformDescription(
    blocksWithProse(),
    ctx({ credential: CREDENTIAL }),
    { prose: "word ".repeat(600), maxLength: 1500 },
  );
  assert(out.length <= 1500, `${out.length} > 1500`);
});

// ─── Every channel copies eBay (2026-09-11, channel-copy.ts) ───────

Deno.test("a stale AI description in the kit entry is never sent", () => {
  // The item that found this: drafted "gray", corrected to navy on eBay, and
  // every marketplace kept the AI's "gray set" sentence.
  const entry = { description: "Obsessed with this gray set!" };
  const out = channelDescription(
    blocksWithProse(),
    ctx({ item: { brand: "Cozy Earth", size: "3XL", color: "Navy", material: null, measurements: null } }),
    entry,
    1500,
  );
  assertEquals(out.includes("gray"), false, out);
  assertStringIncludes(out, "eBay wording");
  assertStringIncludes(out, "Navy");
});

Deno.test("a seller's per-channel description is sent exactly as typed", () => {
  const typed = "My own Poshmark words.\n\nNo measurements appended.";
  const out = channelDescription(
    blocksWithProse(),
    ctx({ credential: CREDENTIAL }),
    { description: "stale AI words", description_override: typed },
    1500,
  );
  assertEquals(out, typed);
});

Deno.test("a blank override reads as no override", () => {
  const out = channelDescription(blocksWithProse(), ctx(), { description_override: "   " }, 1500);
  assertStringIncludes(out, "eBay wording");
});
