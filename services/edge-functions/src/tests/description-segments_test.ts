// US-3114: the description as SEGMENTS, so the composer preview can be clicked.
// Pure functions — no Anthropic/Supabase/env.
//   deno test --allow-read src/tests/description-segments_test.ts
//
// The test that matters is the first one. `renderDescription` is now
// `renderSegments` glued back together, and every other feature here rests on
// that staying byte-exact: a preview a seller can click must produce the exact
// string eBay receives, or the clicking surface is lying about what publishes.
import { assert, assertEquals } from "@std/assert";
import {
  type DescriptionBlock,
  defaultBlocks,
  parseLegacyDescription,
  type RenderContext,
  renderDescription,
  renderSegments,
} from "../lib/description-blocks.ts";
import {
  MEASUREMENTS_BLOCK_END,
  MEASUREMENTS_BLOCK_START,
} from "../lib/measurements.ts";

// ─── Fixtures ──────────────────────────────────────────────────────

function ctx(over: Partial<RenderContext> = {}): RenderContext {
  return {
    item: {
      brand: "Veronica Beard",
      size: "8",
      color: "Black",
      material: null,
      style: "Jogger",
      measurements: { waist: 15, inseam: 29, rise: 10, length: 39.5, width: 18 },
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

const GRADE: NonNullable<RenderContext["grade"]> = {
  overall_score: 8.5,
  factors: [
    { label: "Fabric", score: 9 },
    { label: "Seams", score: 8.5 },
  ],
  disclosure: {
    overall_score: 8.5,
    grade_tier: "excellent",
    defects_found: [{ defect: "pilling", severity: "minor", location: "cuff" }],
    detected_style_attributes: [],
    per_image_analysis: [],
    certificate_id: "GT-TEST-1",
    legacy_defects_summary: null,
  },
};

function blocksWithText(): DescriptionBlock[] {
  const blocks = defaultBlocks();
  for (const b of blocks) {
    if (b.key === "intro") b.text = "Veronica Beard jogger pants.";
    if (b.key === "features") b.text = "Pull-on with an elastic drawstring waist.";
    if (b.key === "condition") b.text = "New with tags, never worn.";
    if (b.key === "grade") b.on = true;
  }
  return blocks;
}

/** A live 2026-08 description: credential BEFORE measurements, three newlines. */
const LEGACY = [
  "Veronica Beard jogger-style pants, new with tags.",
  "",
  "Condition: Brand new, never worn, with original tags still attached.",
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

/** The cases the glue has to survive, named so a failure says which shape broke. */
function cases(): { name: string; blocks: DescriptionBlock[]; c: RenderContext }[] {
  const full = ctx({ credential: CREDENTIAL, grade: GRADE, calibrated: true });
  const bare = ctx({
    item: { brand: null, size: null, color: null, material: null, measurements: null },
  });
  return [
    { name: "defaults with prose", blocks: blocksWithText(), c: ctx() },
    { name: "everything on", blocks: blocksWithText(), c: full },
    {
      name: "legacy parse",
      blocks: parseLegacyDescription(LEGACY, ctx()),
      c: ctx(),
    },
    {
      name: "blocks switched off",
      blocks: blocksWithText().map((b, i) => (i % 2 === 0 ? { ...b, on: false } : b)),
      c: full,
    },
    { name: "nothing to render", blocks: blocksWithText(), c: bare },
    {
      name: "facts out of order",
      blocks: [
        { key: "facts", on: true, src: "system" },
        { key: "intro", on: true, src: "ai", text: "Opening line." },
      ],
      c: full,
    },
    {
      name: "leading separator survives",
      blocks: [
        { key: "intro", on: true, src: "ai", text: "A", sep: "\n\n\n" },
        { key: "condition", on: true, src: "ai", text: "C", sep: "\n" },
      ],
      c: ctx(),
    },
    { name: "empty array", blocks: [], c: full },
  ];
}

// ─── AC2: the glue is byte-exact ───────────────────────────────────

Deno.test("AC2: gluing the segments reproduces renderDescription byte for byte", () => {
  for (const { name, blocks, c } of cases()) {
    const glued = renderSegments(blocks, c).map((s) => s.sep + s.body).join("");
    assertEquals(glued, renderDescription(blocks, c), `glue broke on: ${name}`);
  }
});

Deno.test("AC2: a legacy description survives parse -> segments -> glue unchanged", () => {
  const c = ctx();
  const glued = renderSegments(parseLegacyDescription(LEGACY, c), c)
    .map((s) => s.sep + s.body)
    .join("");
  assertEquals(glued, LEGACY);
});

// ─── AC1: the shape ────────────────────────────────────────────────

Deno.test("AC1: every text segment's lines join back to its body", () => {
  for (const { name, blocks, c } of cases()) {
    for (const seg of renderSegments(blocks, c)) {
      if (seg.kind !== "text") continue;
      assert(seg.lines, `${name}: text segment ${seg.key} has no lines`);
      assertEquals(
        seg.lines.map((l) => l.text).join("\n"),
        seg.body,
        `${name}: lines do not rebuild ${seg.key}`,
      );
    }
  }
});

Deno.test("AC1: index points back at the caller's array, not the render order", () => {
  const blocks: DescriptionBlock[] = [
    { key: "facts", on: true, src: "system" },
    { key: "intro", on: true, src: "ai", text: "Opening line." },
  ];
  const segs = renderSegments(blocks, ctx({ grade: GRADE }));
  assertEquals(segs.map((s) => s.key), ["intro", "facts"]);
  // facts renders last but still reports the slot it occupies in `blocks`,
  // which is what setBlockTextAt on the client keys on.
  assertEquals(segs.map((s) => s.index), [1, 0]);
});

Deno.test("AC1: an off block and an empty block produce no segment at all", () => {
  const blocks: DescriptionBlock[] = [
    { key: "intro", on: true, src: "ai", text: "A" },
    { key: "features", on: false, src: "ai", text: "B" },
    { key: "measurements", on: true, src: "item" },
  ];
  const noMeasure = ctx({
    item: { brand: "X", size: null, color: null, material: null, measurements: null },
  });
  assertEquals(renderSegments(blocks, noMeasure).map((s) => s.key), ["intro"]);
});

// ─── AC1: the editable lines carry their field ─────────────────────

Deno.test("AC1: attributes lines carry the item column each one renders", () => {
  const segs = renderSegments([{ key: "attributes", on: true, src: "item" }], ctx());
  const [seg] = segs;
  assertEquals(seg.kind, "text");
  assertEquals(seg.lines?.map((l) => l.field), ["brand", "size", "color"]);
  assertEquals(seg.lines?.[0].text, "- Brand: Veronica Beard");
});

Deno.test("AC1: an attributes field with no value contributes no line", () => {
  const segs = renderSegments(
    [{ key: "attributes", on: true, src: "item", fields: ["brand", "material"] }],
    ctx(),
  );
  assertEquals(segs[0].lines?.map((l) => l.field), ["brand"]);
});

Deno.test("AC1: measurements lines carry their key, and the markers are hidden", () => {
  const segs = renderSegments(
    [{ key: "measurements", on: true, src: "item" }],
    ctx({ calibrated: true }),
  );
  const lines = segs[0].lines ?? [];
  assertEquals(lines[0].hidden, true);
  assertEquals(lines[0].text, MEASUREMENTS_BLOCK_START);
  assertEquals(lines.at(-1)?.hidden, true);
  assertEquals(lines.at(-1)?.text, MEASUREMENTS_BLOCK_END);
  // The header and the calibrated note are shown but not editable.
  assertEquals(lines[1].field, undefined);
  assertEquals(
    lines.filter((l) => l.field).map((l) => l.field),
    ["waist", "inseam", "rise", "length", "width"],
  );
});

Deno.test("AC1: prose is ONE line even when it contains newlines", () => {
  const segs = renderSegments(
    [{ key: "intro", on: true, src: "ai", text: "First line.\nSecond line." }],
    ctx(),
  );
  assertEquals(segs[0].lines?.length, 1);
  assertEquals(segs[0].lines?.[0].field, undefined);
});

// ─── AC5: the markup segments ──────────────────────────────────────

Deno.test("AC5: disclosure, credentials and facts come back as html with no markers", () => {
  const blocks: DescriptionBlock[] = [
    { key: "disclosure", on: true, src: "grade" },
    { key: "credentials", on: true, src: "seller" },
    { key: "facts", on: true, src: "system" },
  ];
  const segs = renderSegments(
    blocks,
    ctx({ credential: CREDENTIAL, grade: GRADE }),
  );
  assertEquals(segs.map((s) => s.key), ["disclosure", "credentials", "facts"]);
  for (const seg of segs) {
    assertEquals(seg.kind, "html");
    assertEquals(seg.lines, undefined);
    assert(seg.html && seg.html.length > 0, `${seg.key} rendered no markup`);
    assert(!seg.html.includes("<!--"), `${seg.key} leaked a marker into html`);
    // The bytes are untouched: only the display copy loses the comments.
    assert(seg.body.includes("<!--"), `${seg.key} lost its marker from body`);
  }
});

Deno.test("AC5: prose is never marked html, however it is written", () => {
  const segs = renderSegments(
    [{ key: "intro", on: true, src: "ai", text: "<b>bold claim</b>" }],
    ctx(),
  );
  assertEquals(segs[0].kind, "text");
  assertEquals(segs[0].html, undefined);
});
