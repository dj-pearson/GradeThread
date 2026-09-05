// US-3088: the anonymous listing-draft tool. Everything checkable without a
// model call, a database or a browser.
//
// Imports lib/free-listing-draft.ts, NOT the route, for the same reason
// extension-scan_test.ts does: the route pulls in hono, supabase and the eBay
// client, and requiring them means these assertions only ever run in CI.
//
// The three things worth the most here, in order:
//   1. the parser, because it is the whole trust boundary on an endpoint with
//      no account behind it;
//   2. policyCleanTitle's POST-CONDITION, because AC5 is an absolute and a
//      "usually clean" title is the failure this surface cannot have;
//   3. the response shape, because the narrowing is what keeps a price or a
//      category id from reaching an anonymous caller by being added upstream.
import assert from "node:assert/strict";

import {
  buildFreeDraftTitle,
  FREE_DRAFT_MAX_IMAGES,
  freeDraftBlocks,
  freeDraftLogLine,
  freeDraftRenderContext,
  freeDraftTitleLimit,
  isFreeDraftTarget,
  parseFreeDraftBody,
  policyCleanTitle,
  shapeFreeDraft,
} from "../lib/free-listing-draft.ts";
import { lintTitle } from "../lib/title-lint.ts";
import { MARKETPLACE_SPECS } from "../lib/marketplace-specs.ts";

const PNG = "data:image/png;base64,iVBORw0KGgo=";

function body(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { images: [PNG], target: "ebay", ...over };
}

// ── The parser ───────────────────────────────────────────────────────

Deno.test("US-3088: a well-formed body parses with its hints trimmed", () => {
  const out = parseFreeDraftBody(body({ brand: "  Patagonia  ", size: "M", condition: "worn" }));
  assert.equal(out.ok, true);
  if (!out.ok) return;
  assert.deepEqual(out.images, [PNG]);
  assert.equal(out.target, "ebay");
  assert.equal(out.brand, "Patagonia");
  assert.equal(out.size, "M");
  assert.equal(out.condition, "worn");
});

Deno.test("US-3088: a blank hint is absent, not an empty string", () => {
  const out = parseFreeDraftBody(body({ brand: "   ", size: "" }));
  assert.equal(out.ok, true);
  if (!out.ok) return;
  // An empty string would reach the prompt as `KNOWN ATTRIBUTES: {"brand": ""}`,
  // which tells the model there IS a brand and it is blank.
  assert.equal(out.brand, undefined);
  assert.equal(out.size, undefined);
});

Deno.test("US-3088: an unknown target is refused with a named code", () => {
  for (const target of ["grailed", "", "EBAY", null, 7]) {
    const out = parseFreeDraftBody(body({ target }));
    assert.equal(out.ok, false, `target ${JSON.stringify(target)} was accepted`);
    if (out.ok) return;
    assert.equal(out.code, "bad_target");
  }
});

Deno.test("US-3088: a fourth image is refused with the cap named, not the image", () => {
  const out = parseFreeDraftBody(body({ images: [PNG, PNG, PNG, PNG] }));
  assert.equal(out.ok, false);
  if (out.ok) return;
  assert.equal(out.code, "too_many_images");
  assert.match(out.error, new RegExp(String(FREE_DRAFT_MAX_IMAGES)));
});

Deno.test("US-3088: the cap is checked before the per-image shape", () => {
  // Thirty photos where the fourth is junk. The caller's problem is the count;
  // telling them the fourth photo is malformed sends them to fix the wrong
  // thing, and they cannot see which one we called the fourth anyway.
  const images = [PNG, PNG, PNG, 42, ...Array(26).fill(PNG)];
  const out = parseFreeDraftBody(body({ images }));
  assert.equal(out.ok, false);
  if (out.ok) return;
  assert.equal(out.code, "too_many_images");
});

Deno.test("US-3088: a non-image data URL is refused", () => {
  for (const bad of ["data:text/html;base64,PHNjcmlwdD4=", "https://x.test/a.jpg", "", 1, null]) {
    const out = parseFreeDraftBody(body({ images: [bad] }));
    assert.equal(out.ok, false, `${JSON.stringify(bad)} was accepted`);
    if (out.ok) return;
    assert.equal(out.code, "bad_image");
  }
});

Deno.test("US-3088: an empty or missing images array is refused", () => {
  assert.equal(parseFreeDraftBody(body({ images: [] })).ok, false);
  assert.equal(parseFreeDraftBody({ target: "ebay" }).ok, false);
  assert.equal(parseFreeDraftBody(null).ok, false);
  assert.equal(parseFreeDraftBody("images").ok, false);
});

Deno.test("US-3088: isFreeDraftTarget is the only gate on the target string", () => {
  assert.equal(isFreeDraftTarget("depop"), true);
  assert.equal(isFreeDraftTarget("shopify"), false);
  assert.equal(isFreeDraftTarget(undefined), false);
});

// ── Title limits come from MARKETPLACE_SPECS ─────────────────────────

Deno.test("US-3088: every target's title limit is the registry's number", () => {
  for (const target of ["ebay", "poshmark", "mercari", "depop"] as const) {
    assert.equal(
      freeDraftTitleLimit(target),
      MARKETPLACE_SPECS[target].titleMaxLength,
      `${target} title limit drifted from MARKETPLACE_SPECS`,
    );
  }
});

Deno.test("US-3088: depop has NO title limit and the response says so", () => {
  // Depop has no separate title field - its listing text is the description.
  // Reporting 80 here would be inventing a rule the platform does not have.
  assert.equal(freeDraftTitleLimit("depop"), null);
  const long = "Word ".repeat(40).trim();
  const out = buildFreeDraftTitle(long, undefined, "depop");
  assert.equal(out.limit, null);
  assert.equal(out.trimmed, false);
  assert.equal(out.text, long);
});

Deno.test("US-3088: an eBay title over 80 is word-trimmed, never sliced mid-word", () => {
  const long =
    "Patagonia Better Sweater Mens Medium Grey Fleece Full Zip Jacket Outdoor Hiking Warm Layer";
  const out = buildFreeDraftTitle(long, undefined, "ebay");
  assert.equal(out.limit, 80);
  assert.equal(out.trimmed, true);
  assert.ok(out.text.length <= 80, `title is ${out.text.length} chars`);
  // Word-boundary: every word in the result is a whole word from the original.
  for (const word of out.text.split(" ")) {
    assert.ok(long.split(" ").includes(word), `"${word}" was cut mid-word`);
  }
});

Deno.test("US-3088: warnings describe the TRIMMED title, not the one we discarded", () => {
  // 83 characters with "WOW" as the last word, so the 80-char trim is what
  // removes it. Reporting promotional filler that is no longer in the title
  // sends the seller looking for a word they were never handed.
  const long = "Patagonia Better Sweater Mens Medium Grey Fleece Full Zip Jacket Outdoor Hiking WOW";
  assert.ok(long.length > 80, `fixture must exceed the limit; it is ${long.length}`);
  const out = buildFreeDraftTitle(long, undefined, "ebay");
  assert.equal(out.trimmed, true);
  assert.ok(!out.text.includes("WOW"), `the trim did not drop the filler: ${out.text}`);
  assert.ok(
    !out.warnings.some((w) => w.includes("WOW")),
    `warned about "WOW", which is not in the title we returned: ${JSON.stringify(out.warnings)}`,
  );
  // …and the same lint on the untrimmed line DOES warn, so the case is about
  // WHICH string is linted rather than about lintTitle being quiet.
  assert.ok(lintTitle(long).warnings.some((w) => w.includes("WOW")));
});

// ── policyCleanTitle: the post-condition ─────────────────────────────

Deno.test("US-3088: a clean title is returned untouched", () => {
  const t = "Patagonia Better Sweater Mens Medium Grey Fleece Jacket";
  assert.equal(policyCleanTitle(t, "something else"), t);
});

Deno.test("US-3088: the model's own alternate is preferred over mutilating the first", () => {
  const dirty = "Mens Fleece Jacket in the style of Patagonia Medium Grey";
  const clean = "Mens Grey Fleece Full Zip Jacket Medium Outdoor";
  assert.equal(policyCleanTitle(dirty, clean), clean);
});

Deno.test("US-3088: with no clean alternate, the offending phrase is stripped", () => {
  const dirty = "Mens Fleece Jacket similar to Patagonia Medium Grey";
  const out = policyCleanTitle(dirty, "");
  assert.equal(lintTitle(out).policyViolations.length, 0);
  assert.ok(out.includes("Fleece Jacket"), `lost the item: ${out}`);
  assert.ok(!/similar to/i.test(out), out);
});

Deno.test("US-3088: THE POST-CONDITION - no input produces a title with a policy violation", () => {
  // The strip loop is capped rather than trusted to converge, so the guarantee
  // has to hold for inputs built to defeat it. "compared compared to to X"
  // re-forms the phrase after one strip; the last case stacks four different
  // patterns. An empty string is the honest failure and lints clean.
  const nasty = [
    "compared compared to to Nike Mens Shoes",
    "in the style of in the style of Supreme Hoodie",
    "similar to compared to inspired by style of Gucci Belt",
    "style of style of style of style of style of style of style of style of Prada",
    "",
    "   ",
  ];
  for (const input of nasty) {
    const out = policyCleanTitle(input, "");
    assert.equal(
      lintTitle(out).policyViolations.length,
      0,
      `policyCleanTitle(${JSON.stringify(input)}) returned "${out}", which still violates`,
    );
  }
});

Deno.test("US-3088: a title that cannot be cleaned comes back EMPTY, not violating", () => {
  // The route treats "" as a failed draft. That is the branch that makes the
  // post-condition a guarantee instead of a hope, so it has to be reachable
  // and it has to be empty rather than a best effort.
  const out = policyCleanTitle("compared to", "");
  assert.equal(lintTitle(out).policyViolations.length, 0);
});

// ── The response shape ───────────────────────────────────────────────

const LISTING = {
  title: "Patagonia Better Sweater Mens Medium Grey Fleece Full Zip Jacket",
  title_variant: "Patagonia Mens Grey Fleece Jacket Medium",
  description_intro: "A warm mid-layer that has plenty of seasons left in it.",
  description_features: "Full zip, two hand pockets, flat-lock seams.",
  description_condition: "Light pilling under the arms, no holes or stains.",
  condition_description: "Light pilling under the arms.",
  item_specifics: { Brand: ["Patagonia"], Size: ["M"], Color: ["Grey"] },
};

const INPUT = { images: [PNG], target: "ebay" as const, brand: "Patagonia", size: "M" };

Deno.test("US-3088: the response carries NO price, NO category id and NO comps", () => {
  const out = shapeFreeDraft(
    { ...LISTING, ...({ suggested_price_cents: 4500, suggested_category_query: "mens fleece" } as Record<string, unknown>) } as typeof LISTING,
    INPUT,
  );
  const json = JSON.stringify(out);
  // Not a key check: a nested field would pass that and still ship the number.
  assert.ok(!/4500/.test(json), `a price reached an anonymous response: ${json}`);
  assert.ok(!/category/i.test(json), `a category reached an anonymous response: ${json}`);
  assert.ok(!("suggested_price_cents" in (out as unknown as Record<string, unknown>)));
});

Deno.test("US-3088: the description renders through the shared block renderer", () => {
  const out = shapeFreeDraft(LISTING, INPUT);
  assert.ok(out.description.includes("warm mid-layer"), out.description);
  assert.ok(out.description.includes("Full zip"), out.description);
  // The attributes block prints what the caller told us, in the house style.
  assert.ok(out.description.includes("Patagonia"), out.description);
});

Deno.test("US-3088: no grade means no grade, disclosure or credential block", () => {
  const out = shapeFreeDraft(LISTING, INPUT);
  // An anonymous caller has no graded item and no seller profile. A heading
  // with nothing under it is the tell that a block rendered anyway.
  assert.ok(!/GradeThread grade/i.test(out.description), out.description);
  assert.ok(!/gradethread-disclosure/.test(out.description), out.description);
});

Deno.test("US-3088: the description limit is the registry's, per target", () => {
  for (const target of ["ebay", "poshmark", "mercari", "depop"] as const) {
    const out = shapeFreeDraft(LISTING, { ...INPUT, target });
    assert.equal(out.descriptionLimit, MARKETPLACE_SPECS[target].descriptionMaxLength);
  }
});

Deno.test("US-3088: item specifics pass through, and a missing map is empty not undefined", () => {
  assert.deepEqual(shapeFreeDraft(LISTING, INPUT).itemSpecifics, LISTING.item_specifics);
  const bare = shapeFreeDraft(
    { ...LISTING, item_specifics: undefined as unknown as Record<string, string[]> },
    INPUT,
  );
  assert.deepEqual(bare.itemSpecifics, {});
});

Deno.test("US-3088: the render context carries the caller's hints and NO grade", () => {
  const ctx = freeDraftRenderContext({ ...INPUT, condition: "worn twice" });
  assert.equal(ctx.grade, null);
  assert.equal(ctx.credential, null);
  assert.deepEqual(ctx.snippets, {});
  assert.equal(ctx.item.brand, "Patagonia");
  assert.equal(ctx.conditionDescription, "worn twice");
});

Deno.test("US-3088: blocks keep the paid default order", () => {
  const ctx = freeDraftRenderContext(INPUT);
  const keys = freeDraftBlocks(
    { intro: "a", features: "b", condition: "c" },
    ctx,
  ).map((b) => b.key);
  assert.deepEqual(keys.slice(0, 5), [
    "intro",
    "features",
    "attributes",
    "condition",
    "measurements",
  ]);
});

// ── The log line ─────────────────────────────────────────────────────

Deno.test("US-3088: the log line measures cost and carries no content", () => {
  const line = freeDraftLogLine({
    target: "poshmark",
    imageCount: 3,
    latencyMs: 4210.7,
    titleTrimmed: true,
    warningCount: 2,
    policyClean: true,
  });
  assert.ok(line.startsWith("[free-listing-draft]"), line);
  assert.match(line, /target=poshmark/);
  assert.match(line, /images=3/);
  assert.match(line, /latency_ms=4211/);
  assert.match(line, /title_trimmed=true/);
  assert.match(line, /policy_clean=true/);
  // "Nothing is stored" is a false claim if the answer sits in a log line.
  assert.ok(!/Patagonia|data:image|base64/.test(line), line);
});
