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

// ── The eval report ────────────────────────────────────────────────────────

Deno.test("US-2438: the eval names the covered blocks as a list, never a boolean", () => {
  // `covered` was a literal `false` and is now COVERED_BLOCK_KEYS. It must stay
  // a LIST: coverage is partial — the response schema, the Rules block and the
  // factor-weights line are still compiled in with no identity of their own — so
  // a `true` would tell an operator the gate measures a surface it does not.
  const src = Deno.readTextFileSync(
    new URL("../lib/grading-eval.ts", import.meta.url),
  );
  assert(
    src.includes("covered: COVERED_BLOCK_KEYS"),
    "the eval no longer names which blocks are covered",
  );
  assert(
    !/covered:\s*true/.test(src),
    "coverage is partial and must not read as complete",
  );
  // And the list it reports is the one the resolver actually consults, not a
  // restatement that could drift from it.
  assertEquals([...COVERED_BLOCK_KEYS], Object.keys(PROMPT_BLOCK_KEYS).sort());
});

Deno.test("US-2438: an active block override is reported beside the surface hash", () => {
  // THE HOLE THE SEAM OPENED, pinned at the source. unversionedPromptSurfaceHash()
  // digests the CODE DEFAULTS. The moment a row can replace one at runtime, two
  // eval runs under different block versions carry the SAME hash and read as
  // comparable — and the hash's only job is to say when two runs must NOT be
  // compared. A fingerprint that fails to move is worse than none: it converts
  // "we do not know" into "we checked".
  const src = Deno.readTextFileSync(
    new URL("../lib/grading-eval.ts", import.meta.url),
  );
  assert(
    /const activeBlocks = await activeBlockVersions\(/.test(src),
    "the eval no longer reads the active block overrides",
  );
  assert(
    src.includes("blocks: activeBlocks"),
    "the overrides are read but not reported",
  );
  // Logged as well as returned: the reader most likely to be misled is someone
  // tailing a failing run against the passing one before it, who never sees the
  // returned object at all.
  const code = src.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
  assert(
    code.includes("Active block overrides"),
    "the overrides are returned but never logged beside the verdict they qualify",
  );
});

Deno.test("US-2438: listing-eval reports its own surface as genuinely uncovered", () => {
  // The grading registry does not reach the listing gate — LISTING_GEN_TOOL is a
  // tool schema, not a prompt block. The two `covered` fields now share a name,
  // and borrowing the grading gate's coverage here would be the easiest possible
  // way to overstate it.
  const src = Deno.readTextFileSync(
    new URL("../lib/listing-eval.ts", import.meta.url),
  );
  assert(
    /covered:\s*\[\]/.test(src),
    "listing-eval claims coverage it does not have",
  );
  assert(
    !src.includes("COVERED_BLOCK_KEYS"),
    "listing-eval is reporting the GRADING registry's coverage for a surface the " +
      "registry cannot reach",
  );
});

// ── The eval can hold ONE block variable (AC3) ─────────────────────────────
//
// Source scans: reaching the real runEval needs a database and vision calls, and
// every property below is about what the code DECIDES, not what it computed.

Deno.test("US-2438 AC3: a block candidate pins one block and leaves the rest alone", () => {
  const src = Deno.readTextFileSync(
    new URL("../lib/grading-eval.ts", import.meta.url),
  );
  assert(
    /blockCandidate\?:\s*\{\s*blockVersionId:\s*string\s*\}/.test(src),
    "runEval can no longer take a block candidate — AC3's 'hold ONE block variable'",
  );
  // The candidate merges OVER the resolved set in analyzeImage rather than
  // replacing it. An eval that also reverted the other blocks to code defaults
  // would score the candidate against a prompt no customer gets.
  const grading = Deno.readTextFileSync(
    new URL("../lib/ai-grading.ts", import.meta.url),
  );
  assert(
    /\{\s*\.\.\.resolvedBlocks,\s*\.\.\.blockOverride\s*\}/.test(grading),
    "the candidate no longer merges over the resolved blocks, so an eval run " +
      "measures a prompt production would never serve",
  );
});

Deno.test("US-2438 AC3: the system prompt is NOT overridden by a block eval", () => {
  // The whole point of holding one variable. If a block eval also pinned a
  // system-prompt candidate, a pass would not say which of the two earned it.
  const src = Deno.readTextFileSync(
    new URL("../lib/grading-eval.ts", import.meta.url),
  );
  // v.prompt_text is forced null on the block path, and the overrides derive
  // from it, so both stage overrides stay undefined.
  const at = src.indexOf("if (blockCandidate) {");
  assert(at > -1, "the block-candidate branch is gone");
  const branch = src.slice(at, src.indexOf("} else {", at));
  assert(
    /prompt_text:\s*null/.test(branch),
    "a block eval is carrying a system-prompt override, so a pass cannot say " +
      "which change earned it",
  );
});

Deno.test("US-2438 AC3: an empty candidate is refused rather than scored", () => {
  // Empty block_text means "the code default under this name" — the prompt
  // already in production. Running anyway would stamp a pass on a row that
  // changes nothing, which later reads as a qualified change.
  const src = Deno.readTextFileSync(
    new URL("../lib/grading-eval.ts", import.meta.url),
  );
  assert(
    /has empty block_text/.test(src),
    "an empty block candidate is scored instead of refused",
  );
});

Deno.test("US-2438 AC3: the case filter follows the block's own scope dimension", () => {
  // ai_prompt_versions.garment_scope has always been a garment_category, but
  // garment_type_criteria is scoped by garment_TYPE. Filtering that by category
  // selects zero cases, and "no active eval cases" reads as a missing golden
  // set rather than as this bug — a wrong answer wearing a plausible costume.
  const src = Deno.readTextFileSync(
    new URL("../lib/grading-eval.ts", import.meta.url),
  );
  // Whitespace-flattened: the property is the comparison, not where deno fmt
  // chose to wrap it. A line-shaped regex here already broke once.
  const flat = src.replace(/\s+/g, " ");
  assert(
    flat.includes('scopeDimension === "garment_type"') &&
      flat.includes("casesQuery.eq(column, v.garment_scope)"),
    "the eval filters cases by a hardcoded column, so a garment_type-scoped " +
      "block silently matches nothing",
  );
});

Deno.test("US-2438 AC3: the verdict is written back to the block row, not the prompt row", () => {
  const src = Deno.readTextFileSync(
    new URL("../lib/grading-eval.ts", import.meta.url),
  );
  // Whitespace-flattened so the assertion survives deno fmt rewrapping the
  // chain — the property is the call, not its line breaks.
  const flat = src.replace(/\s+/g, " ");
  assert(
    flat.includes(
      '.from("ai_prompt_block_versions") .update({ eval_passed: passed, eval_run_id: runId })',
    ),
    "a block eval no longer records its verdict on the block row, so the gate " +
      "has nothing to check at activation",
  );
  // And the run row must NOT claim a prompt-version id it does not have: v.id is
  // a block id, and that column is an FK to a different table.
  assert(
    /prompt_version_id:\s*blockRow \? null : v\.id/.test(src),
    "a block eval is writing its own id into prompt_version_id, which points at " +
      "ai_prompt_versions",
  );
});

Deno.test("US-2438 AC3: a candidate naming an unknown block is refused", () => {
  // Inert is right for SERVING — a typo must not take down grading. It is wrong
  // for the GATE: scoring a row the resolver would never serve records a pass
  // for a change that cannot take effect.
  const src = Deno.readTextFileSync(
    new URL("../lib/prompt-blocks.ts", import.meta.url),
  );
  const at = src.indexOf("export async function loadBlockVersion");
  assert(at > -1, "loadBlockVersion is gone");
  const body = src.slice(at, src.indexOf("\n}", at));
  assert(
    /if \(!\(row\.block_key in PROMPT_BLOCK_KEYS\)\) return null/.test(body),
    "loadBlockVersion accepts an unknown block_key, so the gate can qualify a " +
      "row that will never serve",
  );
  // It must also not filter by is_active: the gate exists to score a row BEFORE
  // it serves, so reading only live rows would blind it to its own subject.
  assert(
    !/is_active/.test(body),
    "loadBlockVersion filters on is_active, so the gate cannot see the candidate " +
      "it exists to qualify",
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
