// US-473 + US-566: publish pre-flight — image cap/de-dup/order, category
// condition allow-list validation, and image reachability probing.

// US-2379: publish-preflight.ts reaches lib/supabase.ts through its import
// graph, and that module throws at import time without the service credentials.
// This file passed only when some earlier test file had already set them, which
// is a pass that depends on the run order.
import "./_env.ts";
import { assert, assertEquals } from "@std/assert";
import {
  APPAREL_CONDITION_BANDS,
  type CategoryLeafStatus,
  checkImageReachability,
  conditionDescriptionConsistency,
  CONDITION_ENUM_TO_ID,
  conditionOptionsForCategory,
  dedupeAndCapImages,
  EBAY_MAX_IMAGES,
  imageCapBlocker,
  isApparelPrelovedCategory,
  leafCategoryBlocker,
  type LeafCategorySuggestion,
  mapGradeToApparelCondition,
  mapGradeToBaseCondition,
  PHOTO_MIN_LONGEST_PX,
  PHOTO_ZOOM_LONGEST_PX,
  type PhotoStandardsPhoto,
  photoStandardsPreflight,
  reachabilityBlocker,
  remapConditionForCategory,
  resolveCategoryLeafStatus,
  resolveDraftCondition,
  resolveEbayCondition,
  validateConditionForCategory,
} from "../lib/publish-preflight.ts";
import { EBAY_CONDITION_VALUES } from "../lib/ai-listing.ts";

// ── apparel condition family (2990/3010) — the Dress/Women's-Sweaters set ──────

// The exact allow-list eBay returns for apparel leaves like Dresses.
const APPAREL_CONDITIONS = ["1000", "1500", "1750", "2990", "3000", "3010"];

Deno.test("apparel enums map to the right conditionIds (2990/3010)", () => {
  assertEquals(CONDITION_ENUM_TO_ID.PRE_OWNED_EXCELLENT, "2990");
  assertEquals(CONDITION_ENUM_TO_ID.PRE_OWNED_FAIR, "3010");
});

Deno.test("apparel condition is accepted (no blocker) in an apparel category", () => {
  assertEquals(validateConditionForCategory("PRE_OWNED_EXCELLENT", APPAREL_CONDITIONS), null);
  assertEquals(validateConditionForCategory("PRE_OWNED_FAIR", APPAREL_CONDITIONS), null);
});

Deno.test("apparel remap never overstates: LIKE_NEW → nearest worse allowed (Pre-owned Excellent)", () => {
  // Like new (2750) is rejected by apparel → step DOWN to the nearest allowed of
  // equal-or-worse quality: 2990 (PRE_OWNED_EXCELLENT). Never jumps to a NEW_* id.
  assertEquals(remapConditionForCategory("LIKE_NEW", APPAREL_CONDITIONS), "PRE_OWNED_EXCELLENT");
});

Deno.test("apparel remap never overstates: USED_EXCELLENT(3000) stays, not upgraded to 2990", () => {
  // 3000 is allowed → unchanged (never jump UP to Excellent/2990).
  assertEquals(remapConditionForCategory("USED_EXCELLENT", APPAREL_CONDITIONS), "USED_EXCELLENT");
});

Deno.test("legacy USED_GOOD in an apparel category → safe block (never a cross-family overstate)", () => {
  // "Good" (5000) is a LEGACY tier; the apparel set shares id 3000 for a
  // different meaning, so there's no safe linear remap. Rather than risk
  // overstating, remap returns null and validate surfaces the fixable blocker —
  // the seller then picks a real apparel condition from the (now category-aware)
  // dropdown.
  assertEquals(remapConditionForCategory("USED_GOOD", APPAREL_CONDITIONS), null);
  const msg = validateConditionForCategory("USED_GOOD", APPAREL_CONDITIONS);
  assertEquals(typeof msg, "string");
  assertEquals(msg!.includes("Change the condition in the composer"), true);
});

Deno.test("conditionOptionsForCategory: apparel set → selectable options, best→worst, 3000='Good'", () => {
  const { options, allowedLabels } = conditionOptionsForCategory(APPAREL_CONDITIONS);
  assertEquals(
    options.map((o) => o.value),
    [
      "NEW",
      "NEW_OTHER",
      "NEW_WITH_DEFECTS",
      "PRE_OWNED_EXCELLENT",
      "USED_EXCELLENT",
      "PRE_OWNED_FAIR",
    ],
  );
  // In the apparel family the shared id 3000 is labeled "Pre-owned - Good"
  // (not the generic "Used / pre-owned") so it doesn't duplicate 2990's label.
  assertEquals(options.find((o) => o.value === "USED_EXCELLENT")?.label, "Pre-owned - Good");
  assertEquals(options.find((o) => o.value === "PRE_OWNED_EXCELLENT")?.label, "Pre-owned - Excellent");
  assertEquals(allowedLabels.includes("Pre-owned - Fair"), true);
});

Deno.test("conditionOptionsForCategory: empty allow-list → empty (caller uses static list)", () => {
  assertEquals(conditionOptionsForCategory([]), { options: [], allowedLabels: [] });
});

Deno.test("conditionOptionsForCategory: non-apparel keeps 3000 as the generic 'Used / pre-owned'", () => {
  const { options } = conditionOptionsForCategory(["1000", "3000", "4000", "5000"]);
  assertEquals(options.find((o) => o.value === "USED_EXCELLENT")?.label, "Used / pre-owned");
});

// ── image cap / de-dup / order ─────────────────────────────────────────

Deno.test("dedupe drops empties and duplicates, preserves order", () => {
  const r = dedupeAndCapImages(["a", "", null, "b", "a", "  ", "c"]);
  assertEquals(r.urls, ["a", "b", "c"]);
  assertEquals(r.duplicatesRemoved, 1); // the second "a"
  assertEquals(r.dropped, 0);
});

Deno.test("caps to eBay's 24-image limit and reports dropped", () => {
  const urls = Array.from({ length: 30 }, (_, i) => `img-${i}`);
  const r = dedupeAndCapImages(urls);
  assertEquals(r.urls.length, EBAY_MAX_IMAGES);
  assertEquals(r.urls[0], "img-0"); // order (cover first) preserved
  assertEquals(r.dropped, 6);
});

Deno.test("imageCapBlocker only fires over the cap, not on duplicates", () => {
  assertEquals(imageCapBlocker(dedupeAndCapImages(["a", "a", "b"])), null);
  const over = dedupeAndCapImages(Array.from({ length: 26 }, (_, i) => `i${i}`));
  const msg = imageCapBlocker(over);
  assertEquals(typeof msg, "string");
  assertEquals(msg!.includes("Remove 2"), true);
  assertEquals(msg!.includes("24"), true);
});

// ── condition vs. category allow-list ──────────────────────────────────

Deno.test("condition enum→id mapping covers every EbayCondition value", () => {
  assertEquals(CONDITION_ENUM_TO_ID.NEW, "1000");
  assertEquals(CONDITION_ENUM_TO_ID.USED_EXCELLENT, "3000");
  assertEquals(CONDITION_ENUM_TO_ID.FOR_PARTS_OR_NOT_WORKING, "7000");
});

Deno.test("valid condition for the category → no blocker", () => {
  // USED_EXCELLENT → 3000, which the category allows.
  assertEquals(
    validateConditionForCategory("USED_EXCELLENT", ["1000", "3000"]),
    null,
  );
});

Deno.test("unrestricted / unknown category → no blocker", () => {
  assertEquals(validateConditionForCategory("USED_GOOD", []), null);
});

Deno.test("disallowed condition → fixable blocker naming allowed conditions", () => {
  // A NEW-only category rejects a used condition.
  const msg = validateConditionForCategory("USED_ACCEPTABLE", ["1000", "1500"]);
  assertEquals(typeof msg, "string");
  assertEquals(msg!.includes("Acceptable"), true);
  assertEquals(msg!.includes("New"), true);
});

// ── condition auto-pick (remap) ────────────────────────────────────────

Deno.test("remap keeps an already-allowed condition unchanged", () => {
  assertEquals(
    remapConditionForCategory("USED_EXCELLENT", ["1000", "1500", "3000"]),
    "USED_EXCELLENT",
  );
});

Deno.test("remap leaves condition untouched when allow-list is empty/unknown", () => {
  assertEquals(remapConditionForCategory("LIKE_NEW", []), "LIKE_NEW");
});

Deno.test("remap downgrades a rejected condition to the nearest worse allowed", () => {
  // The classic apparel failure: LIKE_NEW (2750) rejected; category allows
  // New-with-tags (1000), New-without-tags (1500), Used (3000). Never overstate,
  // so fall to the nearest EQUAL-OR-WORSE → USED_EXCELLENT (3000).
  assertEquals(
    remapConditionForCategory("LIKE_NEW", ["1000", "1500", "3000"]),
    "USED_EXCELLENT",
  );
  // NEW_OTHER (1500) rejected, only Used tiers allowed → nearest worse 3000.
  assertEquals(
    remapConditionForCategory("NEW_OTHER", ["3000", "4000"]),
    "USED_EXCELLENT",
  );
});

Deno.test("remap never overstates: blocks (null) when only better conditions allowed", () => {
  // Item graded USED_GOOD (5000) but the category accepts only New → no honest
  // equal-or-worse option, so signal the caller to block rather than upgrade.
  assertEquals(remapConditionForCategory("USED_GOOD", ["1000", "1500"]), null);
});

Deno.test("remap returns null when only unrepresentable (refurb) conditions allowed", () => {
  // 2000/2010 (refurbished) have no enum we emit → can't honestly remap.
  assertEquals(remapConditionForCategory("USED_EXCELLENT", ["2000", "2010"]), null);
});

// ── image reachability ─────────────────────────────────────────────────

Deno.test("reachability flags only definitive 404/410/403", async () => {
  const statusByUrl: Record<string, number> = {
    ok: 200,
    gone: 410,
    missing: 404,
    forbidden: 403,
    flaky: 500, // transient → treated as reachable
  };
  const r = await checkImageReachability(
    ["ok", "gone", "missing", "forbidden", "flaky"],
    (url) =>
      Promise.resolve({ ok: statusByUrl[url] < 400, status: statusByUrl[url] }),
  );
  assertEquals(r.unreachable.sort(), ["forbidden", "gone", "missing"]);
});

Deno.test("network errors are treated as reachable (best-effort)", async () => {
  const r = await checkImageReachability(["x"], () =>
    Promise.reject(new Error("ECONNRESET")));
  assertEquals(r.unreachable, []);
  assertEquals(reachabilityBlocker(r), null);
});

Deno.test("reachabilityBlocker phrases the unreachable set", () => {
  const msg = reachabilityBlocker({ unreachable: ["a", "b"] });
  assertEquals(msg!.includes("2 photos"), true);
});

// ── US-1894: grade → eBay 2025 pre-loved apparel condition bands ──────────────

const NON_APPAREL_USED = ["1000", "3000", "4000", "5000", "6000"]; // legacy ladder

Deno.test("isApparelPrelovedCategory detects the 2990/3010 apparel set", () => {
  assert(isApparelPrelovedCategory(APPAREL_CONDITIONS));
  assert(isApparelPrelovedCategory(["1000", "3010"]));
  assert(!isApparelPrelovedCategory(NON_APPAREL_USED));
  assert(!isApparelPrelovedCategory([]));
});

Deno.test("apparel bands map each grade tier to the pre-loved scale", () => {
  const m = (g: number) => mapGradeToApparelCondition(g, null);
  assertEquals(m(9.9), "NEW"); // NWT tier
  assertEquals(m(9.2), "NEW_OTHER"); // NWOT tier
  assertEquals(m(8.0), "PRE_OWNED_EXCELLENT"); // 2990
  assertEquals(m(7.5), "PRE_OWNED_EXCELLENT"); // band edge (inclusive)
  assertEquals(m(6.0), "USED_EXCELLENT"); // 3000 = Pre-owned - Good
  assertEquals(m(5.0), "USED_EXCELLENT"); // band edge (inclusive)
  assertEquals(m(4.9), "PRE_OWNED_FAIR"); // 3010
  assertEquals(m(2.0), "PRE_OWNED_FAIR"); // never falls off the pre-loved scale
});

Deno.test("apparel band edges track the named constants", () => {
  const m = (g: number) => mapGradeToApparelCondition(g, null);
  assertEquals(m(APPAREL_CONDITION_BANDS.NEW_MIN), "NEW");
  assertEquals(m(APPAREL_CONDITION_BANDS.NEW_OTHER_MIN), "NEW_OTHER");
  assertEquals(m(APPAREL_CONDITION_BANDS.PRE_OWNED_EXCELLENT_MIN), "PRE_OWNED_EXCELLENT");
  assertEquals(m(APPAREL_CONDITION_BANDS.PRE_OWNED_GOOD_MIN), "USED_EXCELLENT");
});

Deno.test("apparel bands honor tag labels + defect hint", () => {
  assertEquals(mapGradeToApparelCondition(6.0, "NWT"), "NEW");
  assertEquals(mapGradeToApparelCondition(6.0, "NWOT"), "NEW_OTHER");
  assertEquals(mapGradeToApparelCondition(9.9, "New with defects"), "NEW_WITH_DEFECTS");
  assertEquals(mapGradeToApparelCondition(null, null), "USED_EXCELLENT");
});

Deno.test("resolveEbayCondition: apparel leaf uses pre-loved bands, always in-range", () => {
  // Grade 8 excellent → 2990 (unreachable via the legacy ladder + downgrade-only remap).
  assertEquals(
    resolveEbayCondition({ explicit: null, grade: 8.0, label: null, allowedConditionIds: APPAREL_CONDITIONS }),
    "PRE_OWNED_EXCELLENT",
  );
  // Grade 4 fair → 3010 (the legacy ladder produced 6000, which apparel rejects
  // with nothing worse allowed → old code blocked the publish).
  assertEquals(
    resolveEbayCondition({ explicit: null, grade: 4.0, label: null, allowedConditionIds: APPAREL_CONDITIONS }),
    "PRE_OWNED_FAIR",
  );
});

Deno.test("resolveEbayCondition: explicit editor value wins (only allow-list-remapped)", () => {
  // Explicit NEW is accepted by the apparel leaf → returned untouched.
  assertEquals(
    resolveEbayCondition({ explicit: "NEW", grade: 4.0, label: null, allowedConditionIds: APPAREL_CONDITIONS }),
    "NEW",
  );
  // Explicit LIKE_NEW is rejected by apparel → remapped down, not to a grade band.
  assertEquals(
    resolveEbayCondition({ explicit: "LIKE_NEW", grade: 9.0, label: null, allowedConditionIds: APPAREL_CONDITIONS }),
    "PRE_OWNED_EXCELLENT",
  );
});

Deno.test("resolveEbayCondition: NON-apparel category is unchanged (base ladder + remap)", () => {
  for (const grade of [9.9, 8.0, 6.5, 5.0, 3.0]) {
    const base = mapGradeToBaseCondition(grade, null);
    assertEquals(
      resolveEbayCondition({ explicit: null, grade, label: null, allowedConditionIds: NON_APPAREL_USED }),
      remapConditionForCategory(base, NON_APPAREL_USED),
    );
  }
});

Deno.test("resolveEbayCondition: unknown allow-list leaves the base condition untouched", () => {
  assertEquals(
    resolveEbayCondition({ explicit: null, grade: 8.0, label: null, allowedConditionIds: [] }),
    mapGradeToBaseCondition(8.0, null),
  );
});

// ── US-1894 AC2: condition-description consistency ─────────────────────────────

Deno.test("condition description flags superlatives on lower tiers", () => {
  const fair = conditionDescriptionConsistency("PRE_OWNED_FAIR", "In flawless, like new shape!");
  assert(!fair.ok);
  assert(fair.warnings.length >= 1);

  const good = conditionDescriptionConsistency("USED_EXCELLENT", "Pristine, no signs of wear");
  assert(!good.ok);
});

Deno.test("condition description allows honest text + higher tiers", () => {
  assertEquals(
    conditionDescriptionConsistency("PRE_OWNED_FAIR", "Visible fading and a small stain on the hem").ok,
    true,
  );
  // Excellent / NEW may use strong language.
  assertEquals(conditionDescriptionConsistency("PRE_OWNED_EXCELLENT", "flawless").ok, true);
  assertEquals(conditionDescriptionConsistency("NEW", "pristine, unworn").ok, true);
  // Empty text passes.
  assertEquals(conditionDescriptionConsistency("PRE_OWNED_FAIR", "").ok, true);
  assertEquals(conditionDescriptionConsistency("PRE_OWNED_FAIR", null).ok, true);
});

Deno.test("condition description word-boundary: 'mint' inside a word does not fire", () => {
  assertEquals(
    conditionDescriptionConsistency("PRE_OWNED_FAIR", "faint minty-green colour, worn").ok,
    true,
  );
});

// ── US-1893: leaf-category guard ───────────────────────────────────────────────

const LEAF_SUGGESTION: LeafCategorySuggestion = {
  categoryId: "11554",
  categoryName: "Dresses",
  categoryTreePath: "Clothing › Women › Dresses",
};

Deno.test("leafCategoryBlocker: a leaf category passes (no blocker)", () => {
  assertEquals(leafCategoryBlocker("11554", "leaf", null), null);
  assertEquals(leafCategoryBlocker("11554", "leaf", LEAF_SUGGESTION), null);
});

Deno.test("leafCategoryBlocker: no category id → null (a separate blocker owns that)", () => {
  assertEquals(leafCategoryBlocker(null, "not_found", LEAF_SUGGESTION), null);
});

Deno.test("leafCategoryBlocker: unverified fails OPEN — an outage never blocks publish", () => {
  assertEquals(leafCategoryBlocker("11554", "unverified", null), null);
  assertEquals(leafCategoryBlocker("11554", "unverified", LEAF_SUGGESTION), null);
});

Deno.test("leafCategoryBlocker: non-leaf id → fixable blocker naming the suggested leaf", () => {
  const msg = leafCategoryBlocker("15724", "non_leaf", LEAF_SUGGESTION);
  assertEquals(typeof msg, "string");
  assert(msg!.includes("15724")); // the bad parent id
  assert(msg!.includes("parent category")); // why it's blocked
  assert(msg!.includes("Dresses")); // the one-click fix name
  assert(msg!.includes("11554")); // the fix id
  assert(msg!.includes("Clothing › Women › Dresses")); // the breadcrumb
});

Deno.test("leafCategoryBlocker: unknown/not-found id → distinct 'not found' blocker", () => {
  const msg = leafCategoryBlocker("99999999", "not_found", LEAF_SUGGESTION);
  assertEquals(typeof msg, "string");
  assert(msg!.includes("could not be found"));
  assert(msg!.includes("11554")); // still offers the fix
});

Deno.test("leafCategoryBlocker: non-leaf with no suggestion → generic fixable copy", () => {
  const msg = leafCategoryBlocker("15724", "non_leaf", null);
  assertEquals(typeof msg, "string");
  assert(msg!.includes("Pick a specific (leaf) category"));
});

Deno.test("resolveCategoryLeafStatus: cache hit → 'leaf' WITHOUT a live probe", async () => {
  let probed = 0;
  const status = await resolveCategoryLeafStatus("11554", {
    hasCachedLeaf: () => Promise.resolve(true),
    probeLeafStatus: () => {
      probed++;
      return Promise.resolve("non_leaf" as CategoryLeafStatus);
    },
  });
  assertEquals(status, "leaf");
  assertEquals(probed, 0); // the whole point: already-validated ids skip the API.
});

Deno.test("resolveCategoryLeafStatus: cache miss → falls through to the live probe", async () => {
  let probed = 0;
  const status = await resolveCategoryLeafStatus("15724", {
    hasCachedLeaf: () => Promise.resolve(false),
    probeLeafStatus: (id) => {
      probed++;
      assertEquals(id, "15724");
      return Promise.resolve("non_leaf" as CategoryLeafStatus);
    },
  });
  assertEquals(status, "non_leaf");
  assertEquals(probed, 1);
});

Deno.test("resolveCategoryLeafStatus + blocker: cache-miss leaf passes end-to-end", async () => {
  const status = await resolveCategoryLeafStatus("11554", {
    hasCachedLeaf: () => Promise.resolve(false),
    probeLeafStatus: () => Promise.resolve("leaf" as CategoryLeafStatus),
  });
  assertEquals(leafCategoryBlocker("11554", status, LEAF_SUGGESTION), null);
});

// ── US-1896: photo standards preflight ─────────────────────────────────────

const P = (
  o: Partial<PhotoStandardsPhoto> & { sort_order: number },
): PhotoStandardsPhoto => ({ photo_type: "front", width: 2000, height: 2000, ...o });

Deno.test("photoStandards: empty set → no blockers/warnings/nudge", () => {
  const r = photoStandardsPreflight([]);
  assertEquals(r.blockers, []);
  assertEquals(r.warnings, []);
  assertEquals(r.nudge, null);
});

Deno.test("photoStandards: an all-good set is clean", () => {
  const r = photoStandardsPreflight([
    P({ sort_order: 0, photo_type: "front", width: 2000, height: 1600 }),
    P({ sort_order: 1, photo_type: "back", width: 1600, height: 2000 }),
  ]);
  assertEquals(r.blockers, []);
  assertEquals(r.warnings, []);
  assertEquals(r.nudge, null);
});

Deno.test("photoStandards: a sub-500px photo is a fixable BLOCKER", () => {
  const r = photoStandardsPreflight([
    P({ sort_order: 0, photo_type: "front", width: 2000, height: 2000 }),
    P({ sort_order: 1, photo_type: "detail", width: 480, height: 300 }),
  ]);
  assertEquals(r.blockers.length, 1);
  assert(r.blockers[0].includes(String(PHOTO_MIN_LONGEST_PX)));
  assert(r.blockers[0].startsWith("A photo is"));
});

Deno.test("photoStandards: multiple sub-500px photos are pluralized in one blocker", () => {
  const r = photoStandardsPreflight([
    P({ sort_order: 0, photo_type: "front", width: 400, height: 400 }),
    P({ sort_order: 1, photo_type: "back", width: 300, height: 499 }),
  ]);
  assertEquals(r.blockers.length, 1);
  assert(r.blockers[0].includes("2 photos are"));
});

Deno.test("photoStandards: longest SIDE (not both) decides the 500px floor", () => {
  // 300x600 → longest 600 ≥ 500 → not a blocker.
  const ok = photoStandardsPreflight([P({ sort_order: 0, width: 300, height: 600 })]);
  assertEquals(ok.blockers, []);
  // 300x400 → longest 400 < 500 → blocker.
  const bad = photoStandardsPreflight([P({ sort_order: 0, width: 300, height: 400 })]);
  assertEquals(bad.blockers.length, 1);
});

Deno.test("photoStandards: hero under 1600px longest side is a zoom WARNING (not a blocker)", () => {
  const r = photoStandardsPreflight([
    P({ sort_order: 0, photo_type: "front", width: 1200, height: 900 }),
  ]);
  assertEquals(r.blockers, []);
  assertEquals(r.warnings.length, 1);
  assert(r.warnings[0].includes(String(PHOTO_ZOOM_LONGEST_PX)));
  assert(r.warnings[0].includes("1200px"));
});

Deno.test("photoStandards: only the HERO (lowest sort_order) drives the zoom warning", () => {
  // A small non-hero photo (≥500) must not warn; hero is large → no warning.
  const r = photoStandardsPreflight([
    P({ sort_order: 1, photo_type: "detail", width: 800, height: 800 }),
    P({ sort_order: 0, photo_type: "front", width: 2400, height: 2400 }),
  ]);
  assertEquals(r.warnings, []);
});

Deno.test("photoStandards: unknown dimensions fail OPEN (no blocker, no warning)", () => {
  const r = photoStandardsPreflight([
    P({ sort_order: 0, photo_type: "front", width: null, height: null }),
    P({ sort_order: 1, photo_type: "back", width: 100, height: null }),
  ]);
  assertEquals(r.blockers, []);
  assertEquals(r.warnings, []);
});

Deno.test("photoStandards: first photo being a tag/detail/defect shot triggers the reorder NUDGE", () => {
  const tag = photoStandardsPreflight([
    P({ sort_order: 0, photo_type: "tag", width: 2000, height: 2000 }),
    P({ sort_order: 1, photo_type: "front", width: 2000, height: 2000 }),
  ]);
  assert(tag.nudge && tag.nudge.includes("tag"));

  const defect = photoStandardsPreflight([P({ sort_order: 0, photo_type: "defect", width: 2000, height: 2000 })]);
  assert(defect.nudge && defect.nudge.includes("flaw"));

  const detail2 = photoStandardsPreflight([P({ sort_order: 0, photo_type: "detail_2", width: 2000, height: 2000 })]);
  assert(detail2.nudge && detail2.nudge.includes("detail"));
});

Deno.test("photoStandards: front/back/flatlay/on_model heroes never nudge", () => {
  for (const t of ["front", "back", "flatlay", "on_model"]) {
    const r = photoStandardsPreflight([P({ sort_order: 0, photo_type: t, width: 2000, height: 2000 })]);
    assertEquals(r.nudge, null, `${t} hero should not nudge`);
  }
});

Deno.test("photoStandards: an unknown/absent hero photo_type does not nudge (fail-open)", () => {
  const nullType = photoStandardsPreflight([P({ sort_order: 0, photo_type: null, width: 2000, height: 2000 })]);
  assertEquals(nullType.nudge, null);
});

Deno.test("photoStandards: does not mutate or reorder the caller's array", () => {
  const input: PhotoStandardsPhoto[] = [
    P({ sort_order: 2, photo_type: "detail", width: 2000, height: 2000 }),
    P({ sort_order: 0, photo_type: "front", width: 2000, height: 2000 }),
  ];
  const snapshot = input.map((p) => p.sort_order);
  photoStandardsPreflight(input);
  assertEquals(input.map((p) => p.sort_order), snapshot);
});


// ── US-3031: generation-time condition settlement ────────────────────────────
//
// The listing model picks a condition before the leaf is known. These cover the
// crossing it makes most often: a worn garment on an apparel leaf.

Deno.test("resolveDraftCondition keeps an already-allowed pick untouched", () => {
  const r = resolveDraftCondition("PRE_OWNED_EXCELLENT", APPAREL_CONDITIONS);
  assertEquals(r.condition, "PRE_OWNED_EXCELLENT");
  assertEquals(r.changed, false);
  assertEquals(r.unresolved, false);
});

Deno.test("resolveDraftCondition leaves an unrestricted category alone", () => {
  const r = resolveDraftCondition("USED_GOOD", []);
  assertEquals(r.condition, "USED_GOOD");
  assertEquals(r.changed, false);
  assertEquals(r.unresolved, false);
});

Deno.test("resolveDraftCondition translates the legacy used ladder onto apparel", () => {
  // The whole point: rank-only remapping sent Very good and Good to Fair, two
  // tiers below what the model meant.
  assertEquals(
    resolveDraftCondition("USED_VERY_GOOD", APPAREL_CONDITIONS).condition,
    "USED_EXCELLENT", // 3000 = "Pre-owned - Good"
  );
  assertEquals(
    resolveDraftCondition("USED_GOOD", APPAREL_CONDITIONS).condition,
    "USED_EXCELLENT",
  );
  assertEquals(
    resolveDraftCondition("USED_ACCEPTABLE", APPAREL_CONDITIONS).condition,
    "PRE_OWNED_FAIR",
  );
  assertEquals(
    resolveDraftCondition("LIKE_NEW", APPAREL_CONDITIONS).condition,
    "PRE_OWNED_EXCELLENT",
  );
  for (const c of ["USED_VERY_GOOD", "USED_GOOD", "USED_ACCEPTABLE", "LIKE_NEW"]) {
    assertEquals(resolveDraftCondition(c, APPAREL_CONDITIONS).changed, true);
    assertEquals(resolveDraftCondition(c, APPAREL_CONDITIONS).unresolved, false);
  }
});

Deno.test("resolveDraftCondition emits only conditions the category accepts", () => {
  for (const c of EBAY_CONDITION_VALUES) {
    const r = resolveDraftCondition(c, APPAREL_CONDITIONS);
    if (r.unresolved) continue;
    const id = CONDITION_ENUM_TO_ID[r.condition];
    assert(
      APPAREL_CONDITIONS.includes(id),
      `${c} settled on ${r.condition} (${id}), which the leaf rejects`,
    );
  }
});

Deno.test("resolveDraftCondition falls back to rank remapping off apparel", () => {
  // Non-apparel leaf without 1500: New without tags steps down to Used.
  assertEquals(
    resolveDraftCondition("NEW_OTHER", ["1000", "3000", "4000"]).condition,
    "USED_EXCELLENT",
  );
});

Deno.test("resolveDraftCondition takes the pre-owned floor when nothing is worse", () => {
  // For-parts has no apparel translation and nothing below Fair to fall to.
  const r = resolveDraftCondition("FOR_PARTS_OR_NOT_WORKING", APPAREL_CONDITIONS);
  assertEquals(r.condition, "PRE_OWNED_FAIR");
  assertEquals(r.unresolved, false);
});

Deno.test("resolveDraftCondition never calls a used item new", () => {
  // A new-only category: no honest stand-in exists, so the draft keeps the
  // model's value and goes to review rather than claiming "New without tags".
  const r = resolveDraftCondition("USED_GOOD", ["1000", "1500"]);
  assertEquals(r.condition, "USED_GOOD");
  assertEquals(r.changed, false);
  assertEquals(r.unresolved, true);
});

Deno.test("resolveDraftCondition marks refurbished-only categories unresolved", () => {
  const r = resolveDraftCondition("USED_EXCELLENT", ["2000", "2010"]);
  assertEquals(r.unresolved, true);
  assertEquals(r.condition, "USED_EXCELLENT");
});
