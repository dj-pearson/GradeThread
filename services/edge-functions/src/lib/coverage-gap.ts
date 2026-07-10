// US-1837: coverage-gap "request the missing photos" macro (PURE, unit-tested).
//
// A confident condition grade needs specific angles. This turns the inspection
// template (the same coverage model the grader uses) into a buyer-facing list of
// the photos worth asking a seller for, plus a polite, ready-to-send message.
// The buyer sends it MANUALLY — no automated messaging (marketplace ToS safe).

import { inspectionTemplate } from "./coverage.ts";

// The always-recommended core grading photos (independent of the zone template).
const CORE_PHOTOS = ["Clear photo of the front", "Clear photo of the back", "The brand & size label / tag"];
const MAX_ZONE_PHOTOS = 4;

// Light garment-category hint from a listing title, so the zone suggestions match
// the item. Unknown → '' (inspectionTemplate falls back to its default template).
const TITLE_CATEGORY: Array<[RegExp, string]> = [
  [/jean|denim|trouser|pant|chino|slack/, "pants"],
  [/short(s)?\b/, "shorts"],
  [/skirt/, "skirt"],
  [/dress\b|gown/, "dress"],
  [/jacket|coat|blazer|parka|bomber/, "jacket"],
  [/hoodie|sweatshirt|sweater|jumper|knit|cardigan/, "sweater"],
  [/shirt|blouse|top\b|tee\b|t-shirt|polo/, "shirt"],
  [/shoe|sneaker|boot|heel|sandal|loafer/, "shoes"],
  [/bag|purse|handbag|backpack|tote/, "bag"],
];

export function categoryFromTitle(title: string | null | undefined): string {
  const t = (title ?? "").toLowerCase();
  for (const [re, cat] of TITLE_CATEGORY) {
    if (re.test(t)) return cat;
  }
  return "";
}

/**
 * The photos worth requesting for a confident grade: the core three plus close-
 * ups of the item's highest-wear zones (from its inspection template). PURE.
 */
export function recommendedPhotos(garmentCategory: string): string[] {
  const zones = inspectionTemplate(garmentCategory)
    .filter((z) => z.id !== "front" && z.id !== "back")
    .slice(0, MAX_ZONE_PHOTOS);
  return [...CORE_PHOTOS, ...zones.map((z) => `Close-up of the ${z.label.toLowerCase()}`)];
}

/**
 * A polite, ready-to-send seller message asking for exactly those photos. PURE.
 * Framed as a friendly buyer request (ToS-safe: the buyer copies + sends it).
 */
export function buildPhotoRequestMessage(recommended: string[]): string {
  const bullets = recommended.map((p) => `• ${p}`).join("\n");
  return (
    "Hi! I'm interested in this item and want to make sure of its condition before buying. " +
    "Would you be able to add a few more photos?\n\n" +
    `${bullets}\n\n` +
    "Thanks so much — really appreciate it!"
  );
}

export interface CoverageGap {
  recommendedPhotos: string[];
  message: string;
}

/** Build the coverage-gap macro from a listing title. PURE. */
export function coverageGapForTitle(title: string | null | undefined): CoverageGap {
  const recommended = recommendedPhotos(categoryFromTitle(title));
  return { recommendedPhotos: recommended, message: buildPhotoRequestMessage(recommended) };
}
