// US-2959: generation writes description BLOCKS, not one prose string.
//
//   deno test --allow-env --allow-net --allow-read src/tests/listing-gen-blocks_test.ts
//
// The defect this replaces: the model was told to write "a clean opening line,
// then attribute bullets, then the condition statement, then measurements", and
// those attribute bullets were then frozen into a string that nothing could
// update. A seller who corrected a measurement was left with prose advertising
// the old one. The prompt now forbids labelled facts, the tool takes three
// prose fields instead of one, and everything factual is rendered from a block.
import "./_env.ts";
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  defaultBlocks,
  renderDescription,
  type RenderContext,
  scrubRestatedFacts,
} from "../lib/description-blocks.ts";
import { FACTS_MARKER_START } from "../lib/listing-facts-block.ts";

const {
  LISTING_GEN_SYSTEM_PROMPT,
  LISTING_GEN_SYSTEM_PROMPT_V2,
  LISTING_GEN_TOOL,
} = await import("../lib/ai-listing.ts");

const aiListingSrc = Deno.readTextFileSync(
  new URL("../lib/ai-listing.ts", import.meta.url),
);

function schema(): {
  properties: Record<string, unknown>;
  required: string[];
} {
  return LISTING_GEN_TOOL.input_schema as unknown as {
    properties: Record<string, unknown>;
    required: string[];
  };
}

// ─── AC1: the tool schema ──────────────────────────────────────────

Deno.test("AC1: the tool takes three prose fields", () => {
  const { properties } = schema();
  for (const f of ["description_intro", "description_features", "description_condition"]) {
    assert(properties[f], `${f} missing from create_ebay_listing`);
  }
});

Deno.test("AC1: description survives as an OPTIONAL fallback", () => {
  const { properties, required } = schema();
  assert(properties.description, "description must stay in the schema for one release");
  assert(
    !required.includes("description"),
    "description must no longer be required — the three prose fields replace it",
  );
});

Deno.test("AC1: description_intro is required, features and condition are not", () => {
  // Intro is required so a generation always has an opening line. The other two
  // are optional because a plain item legitimately has little to say about
  // either, and an empty block renders to nothing rather than a heading over
  // blank space.
  const { required } = schema();
  assert(required.includes("description_intro"));
  assert(!required.includes("description_features"));
  assert(!required.includes("description_condition"));
});

Deno.test("AC1: the legacy description maps to the intro when the three are empty", () => {
  // The fallback exists because an ACTIVE DB prompt version can still be
  // written against the old contract; without it, that generation would produce
  // an empty listing rather than a slightly old-fashioned one.
  assertStringIncludes(aiListingSrc, "const intro = introField || legacyDescription;");
  assertStringIncludes(aiListingSrc, "description_intro: intro,");
});

// ─── AC2: both prompts forbid restating facts ──────────────────────

Deno.test("AC2: both prompts forbid labelled facts in the prose fields", () => {
  for (const [name, p] of [
    ["v1", LISTING_GEN_SYSTEM_PROMPT],
    ["v2", LISTING_GEN_SYSTEM_PROMPT_V2],
  ] as const) {
    assertStringIncludes(p, "THE DESCRIPTION IS THREE SEPARATE PROSE FIELDS");
    assertStringIncludes(p, "Describe the garment; do not list it.");
    // Named individually, because "do not restate facts" is advice and a list
    // of the six fields is an instruction.
    for (const field of ["Brand", "size", "color", "material", "measurement"]) {
      assert(
        p.includes(field),
        `${name} prompt does not name ${field} among the fields it bans`,
      );
    }
  }
});

Deno.test("AC2: both prompts describe all three fields", () => {
  for (const p of [LISTING_GEN_SYSTEM_PROMPT, LISTING_GEN_SYSTEM_PROMPT_V2]) {
    assertStringIncludes(p, "description_intro:");
    assertStringIncludes(p, "description_features:");
    assertStringIncludes(p, "description_condition:");
  }
});

Deno.test("AC2: v2 keeps its own earlier guidance", () => {
  // The v2 rules US-1900 verified are still in force; this story narrowed what
  // the description fields may contain, it did not drop the policy work.
  const p = LISTING_GEN_SYSTEM_PROMPT_V2;
  assertStringIncludes(p, "AI-SUMMARIZES");
  assertStringIncludes(p, "MEASUREMENTS");
  assertStringIncludes(p, "never dump a");
});

Deno.test("AC2: v2 tells the model NOT to write measurements into the prose", () => {
  // The old v2 rule said to PRESERVE measurements in the description. That is
  // now exactly backwards: they are rendered into their own block, and writing
  // them in prose as well is the one thing that breaks a later correction.
  const p = LISTING_GEN_SYSTEM_PROMPT_V2;
  assertStringIncludes(p, "do NOT write them into any description field");
  assert(
    !p.includes("PRESERVE them as a clearly"),
    "the old preserve-in-description instruction must be gone",
  );
});

// ─── AC3: one call, three fields ───────────────────────────────────

Deno.test("AC3: the three fields come from ONE tool call, so cost is unchanged", () => {
  // All three live on the same tool as the title and the price, and generation
  // makes one forced tool call. A second call would double the cost of every
  // listing to buy nothing.
  const { properties } = schema();
  for (const f of ["title", "description_intro", "description_features", "description_condition"]) {
    assert(properties[f], `${f} must be on the same tool`);
  }
  const calls = aiListingSrc.match(/tool_choice: \{ type: "tool", name: "create_ebay_listing" \}/g) ?? [];
  assertEquals(calls.length, 1, "generation must make exactly one listing tool call");
});

// ─── AC4: the concatenation chain is gone ──────────────────────────

Deno.test("AC4: generation builds blocks and no longer concatenates a description", () => {
  assertStringIncludes(aiListingSrc, "const descriptionBlocks = defaultBlocks().map(");
  // US-2967 put a second array between the AI blocks and the render, so this
  // pins the INVARIANT rather than the name: exactly one renderDescription
  // call, and whatever array it renders is the array the upsert stores. That is
  // what "the description is derived from its blocks" means, and unlike a
  // hardcoded identifier it survives the next rename.
  const renders = aiListingSrc.match(/renderDescription\((\w+), descriptionCtx\)/g) ?? [];
  assertEquals(renders.length, 1, "generation must render the description exactly once");
  const rendered = /const listingDescription = renderDescription\((\w+), descriptionCtx\);/
    .exec(aiListingSrc);
  assert(rendered, "listingDescription is not rendered from a block array");
  assertStringIncludes(aiListingSrc, `description_blocks: ${rendered[1]},`);
});

Deno.test("AC4: the old assembly calls are gone from the generation path", () => {
  for (const gone of [
    "applyMeasurementsBlock(",
    "upsertListingFactsBlock(",
    "<!--gradethread-disclosure-->",
    "<!--gradethread-seller-credentials-->",
  ]) {
    assert(
      !aiListingSrc.includes(gone),
      `${gone} still appears in ai-listing.ts — the string chain is not gone`,
    );
  }
});

// ─── AC5: both columns, one upsert ─────────────────────────────────

Deno.test("AC5: the draft upsert writes description_blocks beside the string", () => {
  const at = aiListingSrc.indexOf("const draftFields = {");
  assert(at > 0, "draftFields not found");
  const fields = aiListingSrc.slice(at, at + 900);
  assertStringIncludes(fields, "listing_description: listingDescription,");
  // The NAME of the array moved in US-2967 (the template footer is spliced in
  // before the render); that both columns leave in one upsert did not.
  assert(
    /description_blocks: \w+,/.test(fields),
    "the upsert does not write description_blocks beside the string",
  );
});

// ─── AC6: the scrubber runs on all three, and says so ──────────────

Deno.test("AC6: every AI field is scrubbed before it is stored", () => {
  assertStringIncludes(aiListingSrc, "const cleaned = scrubRestatedFacts(raw, descriptionCtx);");
  // Applied by mapping the block array, so all three go through it rather than
  // whichever one someone remembered.
  assertStringIncludes(aiListingSrc, "intro: listing.description_intro,");
  assertStringIncludes(aiListingSrc, "features: listing.description_features,");
  assertStringIncludes(aiListingSrc, "condition: listing.description_condition,");
});

Deno.test("AC6: what the scrubber removed is logged", () => {
  assertStringIncludes(aiListingSrc, "scrubbed restated facts from description_");
});

// ─── AC7: a measurement appears once, outside the facts block ──────

function ctx(): RenderContext {
  return {
    item: {
      brand: "Veronica Beard",
      size: "8",
      color: "Black",
      material: null,
      measurements: { inseam: 29, length: 39.5 },
    },
    grade: null,
    credential: null,
    snippets: {},
    unit: "in",
  };
}

Deno.test("AC7: a measurement value appears exactly ONCE outside the facts block", () => {
  // The model is told not to write measurements, and the scrubber removes them
  // if it does anyway. What is left is the measurements block, once.
  const blocks = defaultBlocks().map((b) =>
    b.key === "intro"
      ? { ...b, text: "Veronica Beard jogger-style pants." }
      : b.key === "features"
      ? { ...b, text: "Pull-on with an elastic drawstring waist and satin side trim." }
      : b
  );
  const out = renderDescription(blocks, ctx());

  const factsAt = out.indexOf(FACTS_MARKER_START);
  const body = factsAt >= 0 ? out.slice(0, factsAt) : out;

  for (const value of ["29 in", "39.5 in"]) {
    const hits = body.split(value).length - 1;
    assertEquals(hits, 1, `"${value}" appears ${hits} times outside the facts block`);
  }
});

Deno.test("AC7: a model that restates a measurement anyway is scrubbed back to once", () => {
  const c = ctx();
  const blocks = defaultBlocks().map((b) =>
    b.key === "intro"
      ? {
        ...b,
        text: scrubRestatedFacts(
          "Veronica Beard jogger pants.\n- Measurements (approx, laid flat): Inseam 29 in\n- Size: 8",
          c,
        ),
      }
      : b
  );
  const out = renderDescription(blocks, c);
  const body = out.slice(0, out.indexOf(FACTS_MARKER_START) >= 0 ? out.indexOf(FACTS_MARKER_START) : undefined);

  assertEquals(body.split("29 in").length - 1, 1);
  assert(!body.includes("- Size: 8\n- Brand"), "the scrubbed bullet must not survive");
  assertStringIncludes(body, "Veronica Beard jogger pants.");
});

Deno.test("AC7: the attributes block carries the facts the prose no longer does", () => {
  // The point is not that the facts disappear, it is that they live in ONE
  // place that a later edit can reach.
  const out = renderDescription(defaultBlocks(), ctx());
  assertStringIncludes(out, "- Brand: Veronica Beard");
  assertStringIncludes(out, "- Size: 8");
  assertStringIncludes(out, "- Color: Black");
});
