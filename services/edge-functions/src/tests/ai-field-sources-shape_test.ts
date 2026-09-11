// US-3358: `ai_field_sources` holds TWO entry shapes, and the reader must see
// both.
//
// The edge, the web composer and iOS write an object
// (`{ source, confidence, accepted }`). Android writes a bare JSON string --
// `AiFieldWriter.kt:73` builds the map with `.mapValues { JsonPrimitive(...) }`,
// so the value is the source string on its own. `isAiOwned` tested the entry
// with `typeof entry === "object"`, so every Android-written entry read as
// absent and the re-identify pass treated an AI-written value as seller-typed.
//
// WHY THESE ARE CALLS AND NOT A SOURCE SCAN. The bug WAS a `typeof` check, so a
// scan for the function name, for the string "isAiOwned", or for the word
// "provenance" passes against it unchanged -- mode 0 in
// memory/guards-that-do-not-guard.md. Every case below drives the real function
// with a real stored value and asserts the answer.
//
// No "./_env.ts" import: reextract-policy.ts has no imports at all, so this
// file's static graph cannot reach lib/supabase.ts. Verified by running this
// file on its own.

import { assert, assertEquals } from "@std/assert";
import {
  buildKnownFields,
  decideAttribute,
  decideField,
  isAiOwned,
  type UntrackedPolicy,
} from "../lib/reextract-policy.ts";

/** Exactly what each client stores for one AI-written field. */
const OBJECT_ENTRY = { source: "photo:tag", confidence: 0.9, accepted: null };
const ANDROID_ENTRY = "photo:tag";

/** Both policies, so a fix that only works under the opt-in cannot pass. */
const POLICIES: readonly UntrackedPolicy[] = ["respect", "treat_as_ai"];

const COLUMNS = ["brand", "style", "size", "color", "material"] as const;

Deno.test("isAiOwned: an Android bare-string entry is a provenance record", () => {
  for (const untracked of POLICIES) {
    assertEquals(
      isAiOwned({ brand: ANDROID_ENTRY }, "brand", untracked),
      true,
      `bare string must count as AI-owned under ${untracked}`,
    );
  }
});

Deno.test("isAiOwned: the two client shapes give the SAME answer", () => {
  // The property, asserted as an equality rather than as two literals: whoever
  // wrote the entry, the question "did an AI pass put this value here" has one
  // answer. Two separate literal assertions would let one shape be inverted
  // while the other still read correctly.
  for (const untracked of POLICIES) {
    for (const field of COLUMNS) {
      const fromObject = isAiOwned({ [field]: OBJECT_ENTRY }, field, untracked);
      const fromString = isAiOwned({ [field]: ANDROID_ENTRY }, field, untracked);
      assertEquals(
        fromString,
        fromObject,
        `${field} under ${untracked}: Android entry answered ${fromString}, ` +
          `object entry answered ${fromObject}`,
      );
      assert(fromObject, `${field} under ${untracked}: an entry is an entry`);
    }
  }
});

Deno.test("isAiOwned: what is NOT a provenance entry", () => {
  // Only a missing key and a value carrying no information fall through to the
  // untracked policy. Reading anything else as AI's would license overwriting a
  // value the seller may have typed by hand.
  const nonEntries: Record<string, unknown> = {
    missing: undefined,
    blank: "",
    whitespace: "   ",
    zero: 0,
    no: false,
    nothing: null,
  };
  for (const [label, value] of Object.entries(nonEntries)) {
    assertEquals(
      isAiOwned({ brand: value }, "brand", "respect"),
      false,
      `${label} must not read as a provenance record under respect`,
    );
    assertEquals(
      isAiOwned({ brand: value }, "brand", "treat_as_ai"),
      true,
      `${label} must fall through to the untracked opt-in`,
    );
  }
});

Deno.test("isAiOwned: the string form survives an Android writer change (AC3)", () => {
  // Android may eventually write the object. Rows written before that day do
  // not rewrite themselves, so the reader must keep accepting the string
  // FOREVER. This case exists to fail if someone "cleans up" the string branch
  // after the writer is fixed.
  assertEquals(isAiOwned({ brand: "learned" }, "brand"), true);
  assertEquals(isAiOwned({ brand: "photo:front" }, "brand"), true);
  assertEquals(isAiOwned({ brand: "research" }, "brand"), true);
  // Mixed on one item: iOS wrote brand, Android later wrote size.
  const mixed = { brand: OBJECT_ENTRY, size: ANDROID_ENTRY };
  assertEquals(isAiOwned(mixed, "brand"), true);
  assertEquals(isAiOwned(mixed, "size"), true);
  assertEquals(isAiOwned(mixed, "color"), false);
});

Deno.test("re-identify withholds an Android-provenanced column from the prompt", () => {
  // The first half of the consequence. Under `respect` the old Android answer
  // used to go back into `known_fields` as ground truth, which is the model
  // grading its own homework -- the exact thing re-identify mode exists to
  // stop.
  const item = {
    brand: "Levis",
    style: "Trucker Jacket",
    size: "M",
    color: "Blue",
    material: "Cotton",
  };
  const androidSources = Object.fromEntries(
    COLUMNS.map((c) => [c, ANDROID_ENTRY]),
  );
  const objectSources = Object.fromEntries(
    COLUMNS.map((c) => [c, OBJECT_ENTRY]),
  );

  for (const untracked of POLICIES) {
    const fromAndroid = buildKnownFields(
      item,
      COLUMNS,
      androidSources,
      "reidentify",
      untracked,
    );
    const fromObject = buildKnownFields(
      item,
      COLUMNS,
      objectSources,
      "reidentify",
      untracked,
    );
    assertEquals(
      Object.keys(fromAndroid),
      [],
      `${untracked}: no AI-written column may be fed back to the model`,
    );
    assertEquals(Object.keys(fromAndroid), Object.keys(fromObject));
  }

  // Gap-fill is unchanged either way: it sends everything non-empty.
  assertEquals(
    Object.keys(buildKnownFields(item, COLUMNS, androidSources, "gap_fill")),
    [...COLUMNS],
  );
});

Deno.test("re-identify may CORRECT an Android-written value, not just flag it", () => {
  // The second half. `pending` is not a milder version of `replace`: it leaves
  // the wrong brand on the item and on the listing title, and asks the seller
  // to do the work the pass was paid for.
  for (const untracked of POLICIES) {
    for (const [label, entry] of [
      ["Android string", ANDROID_ENTRY],
      ["object", OBJECT_ENTRY],
    ] as const) {
      const decision = decideField({
        current: "Levis",
        suggested: "Lee",
        confidence: 0.93,
        autoApplyConfidence: 0.85,
        conflicted: false,
        aiOwned: isAiOwned({ brand: entry }, "brand", untracked),
        mode: "reidentify",
      });
      assertEquals(
        decision,
        "replace",
        `${label} under ${untracked}: expected replace, got ${decision}`,
      );
    }
  }
});

Deno.test("a SELLER-typed field stays protected whatever the entry shape", () => {
  // The safe direction still has to hold. A field with no entry at all is the
  // seller's under `respect`, and a confident new answer goes to review.
  const sources = { brand: ANDROID_ENTRY };
  assertEquals(
    decideField({
      current: "Carhartt",
      suggested: "Dickies",
      confidence: 0.99,
      autoApplyConfidence: 0.85,
      conflicted: false,
      aiOwned: isAiOwned(sources, "style", "respect"),
      mode: "reidentify",
    }),
    "pending",
  );
  // And gap-fill never overwrites an occupied column, entry or no entry.
  assertEquals(
    decideField({
      current: "Levis",
      suggested: "Lee",
      confidence: 0.99,
      autoApplyConfidence: 0.85,
      conflicted: false,
      aiOwned: isAiOwned(sources, "brand", "respect"),
      mode: "gap_fill",
    }),
    "pending",
  );
});

Deno.test("canonical attributes follow the same rule as columns", () => {
  // decideAttribute takes `aiOwned` from the same reader, so an attribute
  // Android stamped must be refreshable too.
  for (const untracked of POLICIES) {
    assertEquals(
      decideAttribute({
        current: "Cotton",
        suggested: "Cotton Twill",
        aiOwned: isAiOwned({ fabric: ANDROID_ENTRY }, "fabric", untracked),
        mode: "reidentify",
      }),
      "replace",
    );
  }
  // Untouched attribute, no entry, default policy: left alone.
  assertEquals(
    decideAttribute({
      current: "Cotton",
      suggested: "Cotton Twill",
      aiOwned: isAiOwned({ fabric: ANDROID_ENTRY }, "fit"),
      mode: "reidentify",
    }),
    "skip",
  );
});
