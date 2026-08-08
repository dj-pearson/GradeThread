// US-2438: the per-block versioned seam for the grading USER message.
//
// The seam only earns its keep if two things hold, and they pull against each
// other. It has to be able to change a live prompt — that is the point — and it
// has to be provably incapable of changing one until somebody activates a row.
// The second is what these tests spend most of their effort on, because it is
// the property that lets the seam ship at all: an additive change to the
// grading prompt needs no eval run, and a non-additive one needs a whole
// lifecycle.
//
// The resolution itself is deliberately NOT re-tested here. It is
// canary-rollout.ts's resolveSlotFromRows/pickPromptForBucket, already covered
// by canary-rollout_test.ts, and reusing it is the design (AC1: "the SAME path,
// not a parallel resolver"). What IS tested is that this module hands those
// functions the right rows and the right slot keys — which is where a per-block
// seam can go wrong in ways a whole-prompt one cannot.

import "./_env.ts"; // must come first — ai-grading reaches lib/supabase.ts
import { assert, assertEquals } from "@std/assert";
import {
  type BlockSlotRow,
  blockVersionSuffix,
  CODE_DEFAULT_BLOCK_VERSION,
  codeDefaultBlock,
  COVERED_BLOCK_KEYS,
  PROMPT_BLOCK_KEYS,
  type PromptBlockOverrides,
  resolveBlocksFromRows,
} from "../lib/prompt-blocks.ts";
import { buildUserPrompt, categoryCriteriaFor } from "../lib/ai-grading.ts";

const row = (over: Partial<BlockSlotRow> = {}): BlockSlotRow => ({
  version_name: "v2",
  block_key: "category_criteria",
  prompt_text: "OVERRIDDEN CATEGORY TEXT",
  garment_scope: null,
  is_active: true,
  is_canary: false,
  rollout_percentage: null,
  ...over,
});

const categoryReq = (scope: string | null, text = "CODE CATEGORY") => ({
  key: "category_criteria" as const,
  scope,
  codeDefault: codeDefaultBlock(text),
});

// ── The additive guarantee ─────────────────────────────────────────────────
//
// An empty registry must leave every prompt exactly as it shipped. Not "close
// enough to pass an eval" — identical, so that shipping this seam is not itself
// a prompt change requiring the lifecycle it exists to provide.

Deno.test("US-2438: no rows resolves to no overrides", () => {
  assertEquals(
    resolveBlocksFromRows("per_image", [categoryReq("jeans")], []),
    {},
  );
});

Deno.test("US-2438: no requests resolves to no overrides even with rows", () => {
  assertEquals(resolveBlocksFromRows("per_image", [], [row()]), {});
});

Deno.test("US-2438: an empty override map leaves the per-image prompt byte-identical", () => {
  // Every garment_type and every category, not one sample: the two blocks this
  // registry covers are exactly the two that vary by those dimensions, so a
  // single probe would miss a default that only some scope reaches.
  const types = [
    "tops",
    "bottoms",
    "outerwear",
    "dresses",
    "footwear",
    "accessories",
    "unknown",
  ];
  const categories = ["jeans", "t-shirt", "sneakers", "not-a-category", ""];
  for (const t of types) {
    for (const c of categories) {
      assertEquals(
        buildUserPrompt("front", t, c, [], "", {}),
        buildUserPrompt("front", t, c, [], ""),
        `prompt moved for garment_type=${t} category=${c} with an empty registry`,
      );
      // And with a hint + a baseline block, since those interleave with the
      // criteria blocks in the same template literal.
      assertEquals(
        buildUserPrompt("detail_1", t, c, ["distressed"], "BASELINE", {}),
        buildUserPrompt("detail_1", t, c, ["distressed"], "BASELINE"),
        `prompt moved for garment_type=${t} category=${c} with hints + baseline`,
      );
    }
  }
});

Deno.test("US-2438: a resolved block reaches the prompt in the block's own slot", () => {
  const overrides: PromptBlockOverrides = {
    category_criteria: {
      text: "CHECK THE RIVETS",
      versionName: "cat_jeans_v3",
    },
  };
  const out = buildUserPrompt("front", "bottoms", "jeans", [], "", overrides);
  assert(out.includes("CATEGORY CRITERIA: CHECK THE RIVETS"));
  // The code criteria it replaced is GONE, not appended beside it. Rendering
  // both would double the block and quietly contradict the override.
  const codeText = categoryCriteriaFor("jeans");
  if (codeText) {
    assert(!out.includes(codeText), "the code criteria is still in the prompt");
  }
});

Deno.test("US-2438: an override can give category criteria to a category that has none", () => {
  // categoryCriteriaFor returns undefined here, so the CATEGORY CRITERIA line is
  // absent by default. An override turning it on is a capability, not a bug —
  // it is how a new category gets criteria without a deploy.
  assertEquals(categoryCriteriaFor("not-a-category"), undefined);
  const withNone = buildUserPrompt("front", "tops", "not-a-category", [], "");
  assert(!withNone.includes("CATEGORY CRITERIA:"));

  const withOverride = buildUserPrompt(
    "front",
    "tops",
    "not-a-category",
    [],
    "",
    {
      category_criteria: {
        text: "NEW CATEGORY RULES",
        versionName: "cat_new_v1",
      },
    },
  );
  assert(withOverride.includes("CATEGORY CRITERIA: NEW CATEGORY RULES"));
});

// ── Scope precedence: scoped row beats global row beats code ───────────────

Deno.test("US-2438: a scoped row beats the global row for its own scope", () => {
  const rows = [
    row({
      version_name: "global_v1",
      prompt_text: "GLOBAL",
      garment_scope: null,
    }),
    row({
      version_name: "jeans_v1",
      prompt_text: "JEANS",
      garment_scope: "jeans",
    }),
  ];
  const out = resolveBlocksFromRows("per_image", [categoryReq("jeans")], rows);
  assertEquals(out.category_criteria?.text, "JEANS");
  assertEquals(out.category_criteria?.versionName, "jeans_v1");
});

Deno.test("US-2438: a scope with no row of its own falls back to the global row", () => {
  const rows = [
    row({
      version_name: "global_v1",
      prompt_text: "GLOBAL",
      garment_scope: null,
    }),
    row({
      version_name: "jeans_v1",
      prompt_text: "JEANS",
      garment_scope: "jeans",
    }),
  ];
  const out = resolveBlocksFromRows(
    "per_image",
    [categoryReq("t-shirt")],
    rows,
  );
  assertEquals(out.category_criteria?.text, "GLOBAL");
});

Deno.test("US-2438: a row for another block does not resolve this one", () => {
  // The failure this catches is the one a whole-prompt seam cannot have: rows
  // for different blocks share a table, so forgetting to filter by block_key
  // would let a garment-type override serve as category criteria.
  const rows = [
    row({ block_key: "garment_type_criteria", prompt_text: "TYPE TEXT" }),
  ];
  assertEquals(
    resolveBlocksFromRows("per_image", [categoryReq("jeans")], rows),
    {},
  );
});

Deno.test("US-2438: two blocks resolve independently from the same row set", () => {
  const rows = [
    row({
      block_key: "category_criteria",
      version_name: "cat_v1",
      prompt_text: "CAT",
    }),
    row({
      block_key: "garment_type_criteria",
      version_name: "type_v1",
      prompt_text: "TYPE",
    }),
  ];
  const out = resolveBlocksFromRows("per_image", [
    categoryReq("jeans"),
    {
      key: "garment_type_criteria" as const,
      scope: "bottoms",
      codeDefault: codeDefaultBlock("CODE TYPE"),
    },
  ], rows);
  assertEquals(out.category_criteria?.text, "CAT");
  assertEquals(out.garment_type_criteria?.text, "TYPE");
});

// ── The closed vocabulary ──────────────────────────────────────────────────

Deno.test("US-2438: a row naming an unknown block is inert, not an error", () => {
  // Inert is the safe direction. Failing would turn an admin typo into a
  // grading outage; matching loosely would let a typo replace another block.
  const rows = [row({ block_key: "categry_criteria" })];
  assertEquals(
    resolveBlocksFromRows("per_image", [categoryReq("jeans")], rows),
    {},
  );
});

Deno.test("US-2438: a block requested against the wrong stage is inert", () => {
  const rows = [row()];
  assertEquals(
    resolveBlocksFromRows("composite", [categoryReq("jeans")], rows),
    {},
  );
});

Deno.test("US-2438: every declared key names the stage its scope dimension belongs to", () => {
  for (const key of COVERED_BLOCK_KEYS) {
    const spec = PROMPT_BLOCK_KEYS[key];
    assert(
      spec.stage === "per_image" || spec.stage === "composite",
      `${key} declares an unknown stage`,
    );
    assert(
      spec.scopeDimension === "garment_type" ||
        spec.scopeDimension === "garment_category",
      `${key} declares an unknown scope dimension`,
    );
  }
  assert(COVERED_BLOCK_KEYS.length > 0, "the registry covers no blocks at all");
  // Sorted and complete, so the coverage a caller reports is stable across runs.
  assertEquals([...COVERED_BLOCK_KEYS].sort(), [...COVERED_BLOCK_KEYS]);
  assertEquals(
    COVERED_BLOCK_KEYS.length,
    Object.keys(PROMPT_BLOCK_KEYS).length,
  );
});

// ── The empty-text row: an era without a copy of the text ──────────────────

Deno.test("US-2438: an empty block_text names an era without duplicating the text", () => {
  // The same contract ai_prompt_versions.prompt_text already has. It IS an
  // override — the grade is attributed to this version — while the text served
  // stays the code default, so a baseline era can be recorded without pasting
  // the constant into a row where it would then drift.
  const rows = [row({ version_name: "cat_baseline_v1", prompt_text: "" })];
  const out = resolveBlocksFromRows("per_image", [
    categoryReq("jeans", "CODE CATEGORY"),
  ], rows);
  assertEquals(out.category_criteria?.text, "CODE CATEGORY");
  assertEquals(out.category_criteria?.versionName, "cat_baseline_v1");
});

Deno.test("US-2438: a block that resolved to the code default is dropped, not reported", () => {
  // Only inactive rows exist, so resolveSlotFromRows returns the code default.
  // Reporting it would put the sentinel version on a grade record and make an
  // untouched block look overridden.
  const rows = [row({ is_active: false, is_canary: false })];
  const out = resolveBlocksFromRows("per_image", [categoryReq("jeans")], rows);
  assertEquals(out, {});
  assertEquals(blockVersionSuffix(out), "");
});

// ── Canary ─────────────────────────────────────────────────────────────────

Deno.test("US-2438: a 100% canary serves only when there is a bucket key", () => {
  const rows = [
    row({ version_name: "champ", prompt_text: "CHAMP" }),
    row({
      version_name: "chal",
      prompt_text: "CHAL",
      is_active: false,
      is_canary: true,
      rollout_percentage: 100,
    }),
  ];
  assertEquals(
    resolveBlocksFromRows("per_image", [categoryReq("jeans")], rows, "sub-1")
      .category_criteria?.text,
    "CHAL",
  );
  // No bucket key = eval, dry-run, quick-grade. Those must measure the champion,
  // or an eval run scores a prompt no customer got.
  assertEquals(
    resolveBlocksFromRows("per_image", [categoryReq("jeans")], rows)
      .category_criteria?.text,
    "CHAMP",
  );
});

Deno.test("US-2438: a 0% canary never serves", () => {
  const rows = [
    row({ version_name: "champ", prompt_text: "CHAMP" }),
    row({
      version_name: "chal",
      prompt_text: "CHAL",
      is_active: false,
      is_canary: true,
      rollout_percentage: 0,
    }),
  ];
  assertEquals(
    resolveBlocksFromRows("per_image", [categoryReq("jeans")], rows, "sub-1")
      .category_criteria?.text,
    "CHAMP",
  );
});

Deno.test("US-2438: canary bucketing is namespaced per block, not per submission", () => {
  // One submission must be able to land in the canary for one block and the
  // champion for another. Sharing a bucket across blocks would correlate the
  // slices, so a 10% canary on two blocks would test the PAIR on 10% of traffic
  // rather than each on its own 10% — and the eval would attribute the result
  // to whichever block was being watched.
  const partial = (key: string) => [
    row({ block_key: key, version_name: `${key}_champ`, prompt_text: "CHAMP" }),
    row({
      block_key: key,
      version_name: `${key}_chal`,
      prompt_text: "CHAL",
      is_active: false,
      is_canary: true,
      rollout_percentage: 50,
    }),
  ];
  const rows = [
    ...partial("category_criteria"),
    ...partial("garment_type_criteria"),
  ];
  const reqs = [
    categoryReq("jeans"),
    {
      key: "garment_type_criteria" as const,
      scope: "bottoms",
      codeDefault: codeDefaultBlock("CODE TYPE"),
    },
  ];

  let split = false;
  for (let i = 0; i < 200 && !split; i++) {
    const out = resolveBlocksFromRows("per_image", reqs, rows, `sub-${i}`);
    const a = out.category_criteria?.versionName ?? "";
    const b = out.garment_type_criteria?.versionName ?? "";
    split = a.endsWith("chal") !== b.endsWith("chal");
  }
  assert(
    split,
    "the two blocks always bucketed together — the slot key is not per block",
  );
});

Deno.test("US-2438: canary bucketing is namespaced per scope too", () => {
  // Same reasoning one level down: a 50% canary scoped to jeans and another
  // scoped to t-shirts are separate experiments, and a shared bucket would make
  // the same submissions the guinea pigs for both.
  const forScope = (scope: string) => [
    row({
      version_name: `${scope}_champ`,
      prompt_text: "CHAMP",
      garment_scope: scope,
    }),
    row({
      version_name: `${scope}_chal`,
      prompt_text: "CHAL",
      garment_scope: scope,
      is_active: false,
      is_canary: true,
      rollout_percentage: 50,
    }),
  ];
  const rows = [...forScope("jeans"), ...forScope("t-shirt")];

  let split = false;
  for (let i = 0; i < 200 && !split; i++) {
    const a =
      resolveBlocksFromRows("per_image", [categoryReq("jeans")], rows, `s-${i}`)
        .category_criteria?.versionName ?? "";
    const b = resolveBlocksFromRows(
      "per_image",
      [categoryReq("t-shirt")],
      rows,
      `s-${i}`,
    )
      .category_criteria?.versionName ?? "";
    split = a.endsWith("chal") !== b.endsWith("chal");
  }
  assert(
    split,
    "two scopes always bucketed together — the slot key ignores scope",
  );
});

Deno.test("US-2438: the same submission resolves the same way every time", () => {
  const rows = [
    row({ version_name: "champ", prompt_text: "CHAMP" }),
    row({
      version_name: "chal",
      prompt_text: "CHAL",
      is_active: false,
      is_canary: true,
      rollout_percentage: 50,
    }),
  ];
  const first = resolveBlocksFromRows(
    "per_image",
    [categoryReq("jeans")],
    rows,
    "sub-42",
  );
  for (let i = 0; i < 20; i++) {
    assertEquals(
      resolveBlocksFromRows(
        "per_image",
        [categoryReq("jeans")],
        rows,
        "sub-42",
      ),
      first,
      "a submission flickered between champion and canary across calls",
    );
  }
});

// ── Attribution ────────────────────────────────────────────────────────────

Deno.test("US-2438: the version suffix is empty when nothing overrode", () => {
  // This is what keeps prompt_version byte-identical on every grade run against
  // an empty registry. A suffix that rendered "+blocks()" would change every
  // recorded version string on a deploy that changed no prompt.
  assertEquals(blockVersionSuffix({}), "");
});

Deno.test("US-2438: the version suffix names each block and is order-stable", () => {
  const a = blockVersionSuffix({
    category_criteria: { text: "x", versionName: "cat_v3" },
    garment_type_criteria: { text: "y", versionName: "type_v2" },
  });
  const b = blockVersionSuffix({
    garment_type_criteria: { text: "y", versionName: "type_v2" },
    category_criteria: { text: "x", versionName: "cat_v3" },
  });
  assertEquals(
    a,
    b,
    "the suffix depends on insertion order — two identical runs would differ",
  );
  assertEquals(
    a,
    "+blocks(category_criteria=cat_v3,garment_type_criteria=type_v2)",
  );
});

Deno.test("US-2438: the code-default sentinel never appears in a suffix", () => {
  const rows = [row({ is_active: false })];
  const out = resolveBlocksFromRows("per_image", [categoryReq("jeans")], rows);
  assert(
    !blockVersionSuffix(out).includes(CODE_DEFAULT_BLOCK_VERSION),
    "the sentinel reached a grade record — the code-default drop failed",
  );
});

// ── The route still goes through the seam ──────────────────────────────────

Deno.test("US-2438: analyzeImage resolves blocks and passes them to the builder", () => {
  // The tests above drive the resolver. That proves nothing if the grading call
  // stopped consulting it, so this reads ai-grading.ts as text — the same shape
  // as the money-path guards, for the same reason.
  const src = Deno.readTextFileSync(
    new URL("../lib/ai-grading.ts", import.meta.url),
  );
  const at = src.indexOf("export async function analyzeImage(");
  assert(at > -1, "analyzeImage is gone or was renamed");
  const body = src.slice(at, src.indexOf("\nexport ", at + 10));

  assert(
    /resolvePromptBlocks\(\s*"per_image"/.test(body),
    "analyzeImage no longer resolves the user-message blocks",
  );
  assert(
    /buildUserPrompt\([^)]*\bblocks,?\s*\)/s.test(body),
    "the resolved blocks are no longer passed to buildUserPrompt — the seam is dead code",
  );
  assert(
    /prompt_version:\s*`\$\{prompt\.versionName\}\$\{blockVersionSuffix\(blocks\)\}`/
      .test(body),
    "the per-image entry no longer records which blocks served",
  );
});
