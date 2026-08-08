// US-2308 AC2/AC3: the two dynamic-context blocks that had no byte-identical
// regression test, plus the suffix ORDER that had no test at all.
//
// The contract (grading-engine skill): a flag-gated context block must leave the
// prompt BYTE-IDENTICAL when it is off, and must append a distinct suffix to the
// reported prompt_version when it is on. `+baseline` and `+fabric` were guarded.
// `+visual` and `+tag` were not — and `+tag` was not even documented, which is
// how a fourth suffix shipped without the reference noticing.
//
// The order matters for a reason that is easy to miss: prompt_version is what
// accuracy-tracking GROUPS BY. The same four blocks emitted in a different order
// would read as a different era and split one version's history in two.

import { assert, assertEquals } from "@std/assert";

// ai-grading.ts transitively imports the service-role client, which throws at
// module load without these. Same preamble as garment-baselines_test.
Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);

const { buildCompositeUserPrompt, promptVersionSuffix } = await import(
  "../lib/ai-grading.ts"
);

const GARMENT = {
  garment_type: "tops",
  garment_category: "hoodie",
  brand: "Lululemon",
  title: "Scuba Hoodie",
  description: null,
};

Deno.test("US-2210 REGRESSION: composite prompt is byte-identical without a tag block", () => {
  const before = buildCompositeUserPrompt([], GARMENT);
  const withEmpty = buildCompositeUserPrompt([], GARMENT, "", "", "");
  assertEquals(before, withEmpty);
});

Deno.test("US-2210: a tag block is added, and only where a tag block belongs", () => {
  const before = buildCompositeUserPrompt([], GARMENT);
  const withTag = buildCompositeUserPrompt([], GARMENT, "", "", "TAG READS: 100% cotton");
  assert(withTag.includes("100% cotton"));
  assert(withTag.length > before.length);
  // The other two blocks must not have been disturbed by threading a third
  // through the same signature.
  const withBaselineOnly = buildCompositeUserPrompt([], GARMENT, "BASE");
  assert(withBaselineOnly.includes("BASE"));
  assert(!withBaselineOnly.includes("100% cotton"));
});

Deno.test("US-1537 REGRESSION: with no verification images the content is the plain prompt", () => {
  // `+visual` is the one suffix NOT driven by a text block. It fires on
  // verificationImages.length, and those images ride in the MESSAGE payload —
  // so the byte-identical property is a property of `compositeGrade`'s message
  // construction, not of the prompt builder, and the prompt builder has no
  // parameter for them at all.
  //
  // Asserting equality between two prompt-builder calls would therefore be
  // VACUOUS: it cannot fail whatever the visual feature does. What can fail is
  // the empty-list branch quietly gaining an addendum, so that is what is
  // pinned: the zero-image branch must be the bare buildCompositeUserPrompt
  // call, with the same four arguments the non-visual path has always passed.
  const src = Deno.readTextFileSync(new URL("../lib/ai-grading.ts", import.meta.url));
  const branch = src.slice(
    src.indexOf("content: verificationImages.length === 0"),
    src.indexOf("...verificationImages.flatMap("),
  );
  assert(branch.length > 0, "the zero-image branch is gone");
  // US-2438 widened this from a fixed argument list. It used to name all five
  // parameters, so adding a SIXTH (the composite block overrides) reddened a
  // branch that had not changed behaviour at all. The property was never the
  // arity — it is that this branch is a BARE call with nothing concatenated onto
  // it, which is what the addendum assertion below actually enforces. A guard
  // that fails on a new parameter teaches people to edit the guard.
  assert(
    /\?\s*buildCompositeUserPrompt\(\s*perImageResults,\s*garmentInfo,\s*baselineBlock,\s*fabricBlock,\s*tagBlock,/
      .test(branch),
    "the no-verification-images branch must be the plain composite prompt, " +
      "built from the same inputs the visual path uses",
  );
  assert(!/\)\s*\+/.test(branch), "the off path concatenates something onto the prompt");
  assert(!branch.includes("VERIFICATION"), "no addendum may leak into the off path");
});

Deno.test("the suffix order is baseline → fabric → visual → tag", () => {
  assertEquals(
    promptVersionSuffix({ baseline: true, fabric: true, visual: true, tag: true }),
    "+baseline+fabric+visual+tag",
  );
});

Deno.test("no block means no suffix, so the base version name is untouched", () => {
  // The whole point of byte-identical-when-off: a version that ran with every
  // feature disabled must be indistinguishable from one that ran before those
  // features existed, or the accuracy history is not comparable across the
  // boundary.
  assertEquals(
    promptVersionSuffix({ baseline: false, fabric: false, visual: false, tag: false }),
    "",
  );
});

Deno.test("each block contributes exactly its own suffix", () => {
  assertEquals(
    promptVersionSuffix({ baseline: true, fabric: false, visual: false, tag: false }),
    "+baseline",
  );
  assertEquals(
    promptVersionSuffix({ baseline: false, fabric: true, visual: false, tag: false }),
    "+fabric",
  );
  assertEquals(
    promptVersionSuffix({ baseline: false, fabric: false, visual: true, tag: false }),
    "+visual",
  );
  assertEquals(
    promptVersionSuffix({ baseline: false, fabric: false, visual: false, tag: true }),
    "+tag",
  );
});

Deno.test("a partial combination keeps the canonical order, not the call order", () => {
  // The failure this catches: someone appends a new suffix by editing the
  // expression and lands it before an existing one. Every version string
  // recorded until then silently changes meaning.
  assertEquals(
    promptVersionSuffix({ baseline: false, fabric: true, visual: false, tag: true }),
    "+fabric+tag",
  );
  assertEquals(
    promptVersionSuffix({ baseline: true, fabric: false, visual: true, tag: false }),
    "+baseline+visual",
  );
});

Deno.test("compositeGrade builds its version from the shared helper", () => {
  // Otherwise the order above is pinned on a function nothing uses. This is the
  // exact shape US-2308 was filed about: a reference that described the code
  // rather than being checked against it.
  const src = Deno.readTextFileSync(new URL("../lib/ai-grading.ts", import.meta.url));
  assert(src.includes("prompt.versionName + promptVersionSuffix({"));
});
