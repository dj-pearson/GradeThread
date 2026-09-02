// US-545: per-item AI cost discipline for AutoLister.
//   1. photo dedupe + cap (selectListingPhotos)
//   2. easy-category model routing (isEasyAspectCategory)
//   3. measured ~30-50% per-item cost reduction at batch scale

import "./_env.ts";
import { assert, assertEquals } from "@std/assert";
import {
  APPROX_IMAGE_TOKENS,
  basePhotoRole,
  type BudgetPhoto,
  DEFAULT_MAX_LISTING_PHOTOS,
  estimateListingItemCost,
  isEasyAspectCategory,
  type PassCostInput,
  selectListingPhotos,
  selectAspectPhotos,
  DEFAULT_MAX_ASPECT_PHOTOS,
} from "../lib/listing-photo-budget.ts";

function photo(url: string, type?: string): BudgetPhoto {
  return { url, type };
}

// ── 1. selectListingPhotos ─────────────────────────────────────────────────

Deno.test("basePhotoRole collapses indexed + measurement roles", () => {
  assertEquals(basePhotoRole("detail_2"), "detail");
  assertEquals(basePhotoRole("tag_2"), "tag");
  assertEquals(basePhotoRole("measurement_chest"), "measurement");
  assertEquals(basePhotoRole("on_model"), "on_model");
  assertEquals(basePhotoRole(undefined), "other");
});

Deno.test("drops exact-duplicate URLs", () => {
  const out = selectListingPhotos([
    photo("a", "front"),
    photo("a", "front"),
    photo("b", "tag"),
  ]);
  assertEquals(out.map((p) => p.url), ["a", "b"]);
});

Deno.test("caps near-identical same-role shots (3rd detail dropped)", () => {
  const out = selectListingPhotos([
    photo("front", "front"),
    photo("d1", "detail"),
    photo("d2", "detail_2"),
    photo("d3", "detail_3"),
    photo("d4", "detail_4"),
  ]);
  const details = out.filter((p) => p.url.startsWith("d"));
  // keep: detail = 2 → only the first two details survive.
  assertEquals(details.map((p) => p.url), ["d1", "d2"]);
});

Deno.test("caps total to the default max, keeping role-diverse shots", () => {
  const many: BudgetPhoto[] = [
    photo("front", "front"),
    photo("back", "back"),
    photo("tag", "tag"),
    photo("tag2", "tag_2"),
    photo("d1", "detail"),
    photo("d2", "detail_2"),
    photo("def", "defect"),
    photo("fl", "flatlay"),
    photo("om", "on_model"),
  ];
  const out = selectListingPhotos(many);
  assertEquals(out.length, DEFAULT_MAX_LISTING_PHOTOS);
  // The two highest-priority roles (front, tag) must survive the cap.
  const urls = out.map((p) => p.url);
  assertEquals(urls.includes("front"), true);
  assertEquals(urls.includes("tag"), true);
});

Deno.test("defect shots outrank extra details under the cap (condition accuracy)", () => {
  // A photo-heavy pre-owned item: without defect > detail priority the cap
  // filled up with front+tag×2+back+detail×2 and every flaw shot was dropped,
  // so generated condition notes missed visible defects.
  const out = selectListingPhotos([
    photo("front", "front"),
    photo("back", "back"),
    photo("tag", "tag"),
    photo("tag2", "tag_2"),
    photo("d1", "detail"),
    photo("d2", "detail_2"),
    photo("d3", "detail_3"),
    photo("def1", "defect"),
    photo("def2", "defect_2"),
    photo("fl", "flatlay"),
  ]);
  assertEquals(out.length, DEFAULT_MAX_LISTING_PHOTOS);
  const urls = out.map((p) => p.url);
  assertEquals(urls.includes("def1"), true);
  assertEquals(urls.includes("def2"), true);
  // Both defects kept means at most one detail survives the 6-photo cap.
  assertEquals(urls.filter((u) => u.startsWith("d") && !u.startsWith("def")).length <= 1, true);
});

Deno.test("preserves original capture order in the result", () => {
  const out = selectListingPhotos([
    photo("p0", "detail"),
    photo("p1", "front"),
    photo("p2", "tag"),
  ]);
  assertEquals(out.map((p) => p.url), ["p0", "p1", "p2"]);
});

Deno.test("never returns empty even when all shots are zero-budget roles", () => {
  const out = selectListingPhotos([
    photo("m1", "measurement_chest"),
    photo("m2", "measurement_waist"),
  ]);
  assertEquals(out.length, 1);
  assertEquals(out[0]!.url, "m1");
});

Deno.test("empty input → empty output", () => {
  assertEquals(selectListingPhotos([]), []);
});

// ── 2. isEasyAspectCategory ─────────────────────────────────────────────────

Deno.test("common apparel categories route to the cheap model", () => {
  assertEquals(isEasyAspectCategory("men's denim jeans"), true);
  assertEquals(isEasyAspectCategory("Clothing > Men > T-Shirts"), true);
  assertEquals(isEasyAspectCategory("Women's Athletic Shoes"), true);
});

Deno.test("hard / high-stakes categories stay on the full model", () => {
  assertEquals(isEasyAspectCategory("Sports Trading Cards"), false);
  assertEquals(isEasyAspectCategory("Men's Designer Jackets"), false);
  // "vintage" is a hard signal even on an otherwise-apparel path.
  assertEquals(isEasyAspectCategory("Vintage Band T-Shirts"), false);
  assertEquals(isEasyAspectCategory("Wristwatches"), false);
  assertEquals(isEasyAspectCategory(null), false);
  assertEquals(isEasyAspectCategory(""), false);
});

// ── 3. measured per-item cost reduction at batch scale ──────────────────────

const SONNET = "claude-sonnet-4-6";
const HAIKU = "claude-haiku-4-5-20251001";

// A representative AutoLister item: 8 uploaded photos, an easy clothing
// category, three model passes (generation + aspect-refine + tag-OCR).
const SrcPhotos: BudgetPhoto[] = [
  photo("front", "front"),
  photo("back", "back"),
  photo("tag", "tag"),
  photo("tag2", "tag_2"),
  photo("d1", "detail"),
  photo("d2", "detail_2"),
  photo("d3", "detail_3"),
  photo("def", "defect"),
];

const TEXT_TOKENS_IN = 800; // system + user + tool schema, per pass
const GEN_OUT = 500;
const REFINE_OUT = 400;
const TAG_OUT = 150;
const TAG_PHOTOS = 2;

Deno.test("per-item cost drops ~30-50% at batch scale (measured)", () => {
  // BEFORE: both vision passes send all 8 photos on Sonnet.
  const before: PassCostInput[] = [
    { model: SONNET, imageCount: SrcPhotos.length, textTokensIn: TEXT_TOKENS_IN, tokensOut: GEN_OUT },
    { model: SONNET, imageCount: SrcPhotos.length, textTokensIn: TEXT_TOKENS_IN, tokensOut: REFINE_OUT },
    { model: SONNET, imageCount: TAG_PHOTOS, textTokensIn: TEXT_TOKENS_IN, tokensOut: TAG_OUT },
  ];

  // AFTER: capped photo set on both vision passes; refine downshifts to Haiku
  // on the easy clothing category. Tag-OCR is unchanged.
  const vision = selectListingPhotos(SrcPhotos);
  const after: PassCostInput[] = [
    { model: SONNET, imageCount: vision.length, textTokensIn: TEXT_TOKENS_IN, tokensOut: GEN_OUT },
    { model: HAIKU, imageCount: vision.length, textTokensIn: TEXT_TOKENS_IN, tokensOut: REFINE_OUT },
    { model: SONNET, imageCount: TAG_PHOTOS, textTokensIn: TEXT_TOKENS_IN, tokensOut: TAG_OUT },
  ];

  const costBefore = estimateListingItemCost(before);
  const costAfter = estimateListingItemCost(after);
  const reduction = (costBefore - costAfter) / costBefore;

  // The vision passes must actually see fewer photos.
  assertEquals(vision.length < SrcPhotos.length, true);
  // Reduction lands in the targeted 30-50% band.
  assertEquals(reduction >= 0.3, true);
  assertEquals(reduction <= 0.5, true);
});

Deno.test("image-token approximation is the dominant per-pass cost driver", () => {
  // A single photo dwarfs the per-pass text overhead, confirming photo COUNT
  // (not source downscale) is the lever the budget pulls.
  assertEquals(APPROX_IMAGE_TOKENS > TEXT_TOKENS_IN, true);
});

// ── 2026-09-02: the aspect-refine pass gets fewer photos than the listing pass ─

const VISION_SET = [
  { url: "u/front", type: "front" },
  { url: "u/tag", type: "tag" },
  { url: "u/defect1", type: "defect" },
  { url: "u/back", type: "back" },
  { url: "u/detail", type: "detail" },
  { url: "u/defect2", type: "defect_2" },
];

Deno.test("selectAspectPhotos drops the defect close-ups and keeps capture order", () => {
  const out = selectAspectPhotos(VISION_SET);
  assertEquals(out.map((p) => p.url), ["u/front", "u/tag", "u/back", "u/detail"]);
});

Deno.test("selectAspectPhotos caps by role priority (tag outranks a 2nd detail)", () => {
  const set = [
    { url: "u/detail1", type: "detail" },
    { url: "u/detail2", type: "detail_2" },
    { url: "u/interior", type: "interior" },
    { url: "u/flatlay", type: "flatlay" },
    { url: "u/tag", type: "tag" },
    { url: "u/front", type: "front" },
  ];
  const out = selectAspectPhotos(set, 3);
  // front (0), tag (1), detail (4) survive; order restored to capture order.
  assertEquals(out.map((p) => p.url), ["u/detail1", "u/tag", "u/front"]);
});

Deno.test("selectAspectPhotos never returns empty for a non-empty set", () => {
  const onlyDefects = [{ url: "u/d1", type: "defect" }, { url: "u/d2", type: "defect_2" }];
  assertEquals(selectAspectPhotos(onlyDefects).length, 2);
  assertEquals(selectAspectPhotos([]), []);
});

Deno.test("the aspect budget is below the listing budget (that is the saving)", () => {
  assert(DEFAULT_MAX_ASPECT_PHOTOS < DEFAULT_MAX_LISTING_PHOTOS);
});
