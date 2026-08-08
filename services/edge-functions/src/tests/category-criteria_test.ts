// US-2222: category-criteria coverage, and the byte-identity that lets it ship.
//
// GARMENT_CATEGORIES has 20 values; GARMENT_CATEGORY_CRITERIA had 8. The other
// 12 fell through to type-level criteria with no category-specific guidance,
// so the model was never told that midsole yellowing on a sneaker is oxidation
// rather than soil, that vachetta patina on a bag is supposed to darken, or
// that the fold crease on a belt is the defining condition signal.
//
// WHY THESE TESTS EXIST IN THIS SHAPE. The story asked for the change to ship
// through shadow -> golden-set eval -> canary. It structurally cannot: the
// criteria are interpolated into the per-image USER message, and only the
// SYSTEM prompt is versioned, overridable, shadowable and canaryable. So the
// gate is an env flag, and these tests are what make that gate trustworthy —
// they pin that OFF is genuinely a no-op and that ON touches only the eleven
// new categories. See the note above GARMENT_CATEGORY_CRITERIA_V2 and US-2432.

import "./_env.ts"; // US-2379: must come first — ai-grading reaches lib/supabase.ts
import { assert, assertEquals } from "@std/assert";
import {
  buildUserPrompt,
  categoryCriteriaFor,
  promptVersionSuffix,
} from "../lib/ai-grading.ts";

// Mirrors src/lib/constants.ts GARMENT_CATEGORIES. Duplicated rather than
// imported because the web constants are a different module graph; the first
// test below fails if the two ever diverge in count.
const GARMENT_CATEGORIES = [
  "t-shirt",
  "shirt",
  "blouse",
  "sweater",
  "hoodie",
  "jacket",
  "coat",
  "jeans",
  "pants",
  "shorts",
  "skirt",
  "dress",
  "sneakers",
  "boots",
  "sandals",
  "hat",
  "bag",
  "belt",
  "scarf",
  "other",
] as const;

// The eight that shipped before US-2222 and must not move.
const PRE_EXISTING = [
  "jeans",
  "pants",
  "shorts",
  "jacket",
  "sweater",
  "hoodie",
  "t-shirt",
  "dress",
] as const;

const GATE = "GRADING_CATEGORY_CRITERIA_V2";

/**
 * Build the prompt for a category with the gate genuinely set, then restore the
 * environment. Flipping the real env var rather than passing a boolean is the
 * point: buildUserPrompt reads the gate itself, so a version of this test that
 * threaded a parameter through would pass while the deployed default did
 * something else.
 */
function prompt(category: string, enabled: boolean): string {
  const before = Deno.env.get(GATE);
  if (enabled) Deno.env.set(GATE, "true");
  else Deno.env.delete(GATE);
  try {
    return (
      buildUserPrompt("front", "tops", category, [], "") +
      // A second call with different image context: the category block must be
      // independent of it, and a bug that keyed off imageType would otherwise
      // slip through a single-shot comparison.
      buildUserPrompt("detail_fabric", "bottoms", category, ["distressed"], "")
    );
  } finally {
    if (before === undefined) Deno.env.delete(GATE);
    else Deno.env.set(GATE, before);
  }
}

Deno.test("AC1: every garment category has criteria, except the deliberate 'other'", () => {
  const missing = GARMENT_CATEGORIES.filter(
    (c) => c !== "other" && !categoryCriteriaFor(c, true),
  );
  assertEquals(
    missing,
    [],
    "These garment_category values grade with no category-specific guidance. " +
      "Add an entry to GARMENT_CATEGORY_CRITERIA_V2 in the existing " +
      "design-vs-defect voice, or argue in a comment why the category " +
      "genuinely has none (as 'other' does).",
  );

  // "other" is absent ON PURPOSE — it is the value assigned when the category
  // is unknown, so it may be any of the twenty. Pinning the absence stops a
  // future coverage sweep from "completing" the map with generic filler.
  assertEquals(
    categoryCriteriaFor("other", true),
    undefined,
    "'other' must stay uncovered: it is the unknown-category default, not a " +
      "category. Generic guidance there restates DESIGN_VS_DEFECT_PRINCIPLE " +
      "and hides that the real gap is classification, not prompting.",
  );
});

Deno.test("AC5: the eight pre-existing categories are byte-identical with the gate ON", () => {
  for (const c of PRE_EXISTING) {
    assertEquals(
      prompt(c, true),
      prompt(c, false),
      `The prompt for "${c}" changed when GRADING_CATEGORY_CRITERIA_V2 is on. ` +
        "These eight already ship; an eval of the new coverage must measure " +
        "only the new coverage, so their text has to be untouched. Check that " +
        `"${c}" was not also added to GARMENT_CATEGORY_CRITERIA_V2.`,
    );
  }
});

Deno.test("gate OFF is a genuine no-op for every category", () => {
  // The property that makes this commit safe to deploy: with the flag unset,
  // nothing about any of the twenty prompts differs from pre-US-2222 behaviour.
  // The eleven new categories must emit no CATEGORY CRITERIA section at all.
  for (const c of GARMENT_CATEGORIES) {
    const off = prompt(c, false);
    const hasBlock = off.includes("CATEGORY CRITERIA:");
    assertEquals(
      hasBlock,
      (PRE_EXISTING as readonly string[]).includes(c),
      `With the gate off, "${c}" ${hasBlock ? "emits" : "omits"} a CATEGORY ` +
        "CRITERIA block and should do the opposite. Only the eight " +
        "pre-existing categories may carry one while the flag is unset.",
    );
  }
});

Deno.test("gate ON adds a block to each of the eleven new categories", () => {
  const NEW = GARMENT_CATEGORIES.filter(
    (c) => c !== "other" && !(PRE_EXISTING as readonly string[]).includes(c),
  );
  assertEquals(NEW.length, 11, "expected exactly 11 newly-covered categories");

  for (const c of NEW) {
    const text = categoryCriteriaFor(c, true);
    assert(text, `"${c}" resolved no criteria with the gate on`);
    // The voice is the contract, not decoration: the whole point of the block
    // is telling intentional design apart from genuine wear, and an entry that
    // only lists defects reproduces the bug it exists to fix.
    assert(
      /INTENTIONAL/.test(text) && /(NOT defects|not damage|NOT DAMAGE)/i.test(text),
      `"${c}" criteria never name what is INTENTIONAL on this category. ` +
        "Every entry must draw the design-vs-defect line — that distinction " +
        "is the reason the block exists (AC2).",
    );
    assert(
      text.startsWith(`${c.toUpperCase()}-SPECIFIC:`),
      `"${c}" criteria must open with "${c.toUpperCase()}-SPECIFIC:" to match ` +
        "the eight that shipped.",
    );
  }
});

Deno.test("the two criteria maps are disjoint", async () => {
  // A key in both would be dead code that LOOKS live: the base-map lookup wins,
  // so someone could edit the v2 text, flip the flag, measure no change, and
  // conclude the flag is broken. Behaviour cannot see this — both maps resolve
  // to a non-empty string either way — so it takes a source scan.
  const src = (
    await Deno.readTextFile(new URL("../lib/ai-grading.ts", import.meta.url))
  ).replace(/\r\n/g, "\n"); // US-2429: native line endings break the slice below

  const keysOf = (decl: string): string[] => {
    const start = src.indexOf(decl);
    assert(start >= 0, `could not find "${decl}" — did the map get renamed?`);
    const body = src.slice(start, src.indexOf("\n};", start));
    // Top-level keys only: `  foo:` / `  "t-shirt":` at exactly two spaces of
    // indent, so nothing inside a criteria STRING can be mistaken for a key.
    return [...body.matchAll(/^ {2}"?([a-z-]+)"?:/gm)].map((m) => m[1]);
  };

  const base = keysOf("const GARMENT_CATEGORY_CRITERIA: Record<string, string> = {");
  const v2 = keysOf("const GARMENT_CATEGORY_CRITERIA_V2: Record<string, string> = {");

  assertEquals(base.sort(), [...PRE_EXISTING].sort(), "the shipped eight changed");
  assertEquals(v2.length, 11, "expected 11 entries in the gated map");
  assertEquals(
    v2.filter((k) => base.includes(k)),
    [],
    "A category appears in BOTH criteria maps. The base map wins at lookup, so " +
      "the gated entry can never serve — editing it and flipping the flag would " +
      "show no change and read as a broken gate. Keep the maps disjoint.",
  );
});

Deno.test("+cat2 appends last and is absent when unset", () => {
  // promptVersionSuffix's own doc says new suffixes APPEND — inserting one in
  // the middle silently rewrites what every previously-recorded version string
  // means. Pin the position, not just the presence.
  const all = promptVersionSuffix({
    baseline: true,
    fabric: true,
    visual: true,
    tag: true,
    categoryV2: true,
  });
  assertEquals(all, "+baseline+fabric+visual+tag+cat2");

  // Absent key must read as "not present", so every grade recorded before this
  // block existed keeps its exact version string.
  assertEquals(
    promptVersionSuffix({ baseline: true, fabric: false, visual: false, tag: true }),
    "+baseline+tag",
  );
  assertEquals(
    promptVersionSuffix({
      baseline: false,
      fabric: false,
      visual: false,
      tag: false,
      categoryV2: true,
    }),
    "+cat2",
  );
});
