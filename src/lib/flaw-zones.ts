// US-3336: pin each numbered flaw on the certificate's garment outline.
//
// The certificate numbers every localized flaw across its photos (US-1287,
// buildAnnotatedGroups) and draws a garment outline for photo coverage
// (US-1278/US-3216). This maps each numbered flaw to one inspection zone so the
// same number can sit on the outline: the damage map at a glance.
//
// The zone comes from the flaw's LOCATION text first, then its SOURCE PHOTO:
//   1. The first alias (in HINT_ALIASES order) that starts a word in the
//      location names the zone. The order is the edge coverage catalog's
//      (services/edge-functions/src/lib/coverage.ts), where front and back come
//      last, so "back of collar" is the collar and "chest pocket" the pocket.
//   2. With no usable word, a front or back photo places it on that side, and
//      a label photo on the branding zone.
//   3. Otherwise, or when the zone has no anchor on this shape, the flaw is
//      NOT MAPPED. It is listed as such rather than guessed onto the outline.
//
// Word-start matching differs from the edge on purpose. The edge credits
// coverage and a stray match only over-credits a zone; here a stray match puts
// a pin on the wrong part of a garment a buyer is looking at. As a substring,
// "tag" matches "vintage" and "hem" matches "chemical".

import type { NumberedAnnotation, AnnotatedPhotoGroup } from "@/components/certificate/annotated-defect-photo";
import type { Silhouette } from "@/lib/coverage-silhouettes";

/** Mirror of the edge HINT_ALIASES, same order. Parity-tested. */
export const HINT_ALIASES: ReadonlyArray<readonly [string, string]> = [
  ["collar", "collar_neckline"],
  ["neckline", "collar_neckline"],
  ["neck", "collar_neckline"],
  ["cuff", "cuffs"],
  ["sleeve", "cuffs"],
  ["wrist", "cuffs"],
  ["hem", "hem"],
  ["underarm", "underarms"],
  ["armpit", "underarms"],
  ["armhole", "underarms"],
  ["waistband", "waistband"],
  ["waist", "waistband"],
  ["crotch", "inseam_crotch"],
  ["inseam", "inseam_crotch"],
  ["rise", "inseam_crotch"],
  ["pocket", "pockets"],
  ["zipper", "closure"],
  ["zip", "closure"],
  ["button", "closure"],
  ["fly", "closure"],
  ["snap", "closure"],
  ["closure", "closure"],
  ["lining", "lining"],
  ["interior", "lining"],
  ["inner", "lining"],
  ["outsole", "sole"],
  ["sole", "sole"],
  ["insole", "insole"],
  ["footbed", "insole"],
  ["upper", "upper"],
  ["vamp", "upper"],
  ["toe", "upper"],
  ["buckle", "hardware"],
  ["clasp", "hardware"],
  ["hardware", "hardware"],
  ["strap", "strap"],
  ["handle", "strap"],
  ["brand", "branding"],
  ["label", "branding"],
  ["care tag", "branding"],
  ["tag", "branding"],
  ["chest", "front"],
  ["bust", "front"],
  ["seat", "back"],
  ["rear", "back"],
  ["front", "front"],
  ["back", "back"],
];

const ALIAS_PATTERNS = HINT_ALIASES.map(
  ([token, zone]) => [new RegExp(`\\b${token}`, "i"), zone] as const,
);

/** Zones the location names, in alias order (most specific first). */
export function zonesFromLocation(location: string | null | undefined): string[] {
  const text = (location ?? "").trim();
  if (!text) return [];
  const out: string[] = [];
  for (const [re, zone] of ALIAS_PATTERNS) {
    if (re.test(text) && !out.includes(zone)) out.push(zone);
  }
  return out;
}

/** The zone a source photo shows, when the photo itself says so. */
export function zoneFromPhoto(imageType: string | null | undefined): string | null {
  const t = (imageType ?? "").toLowerCase().trim();
  if (t === "front") return "front";
  if (t === "back") return "back";
  if (t === "label" || t.startsWith("label_")) return "branding";
  return null;
}

/**
 * The zone one flaw belongs to on this shape, or null when it cannot be placed.
 * A zone only counts when the shape has an anchor for it.
 */
export function zoneForFlaw(
  location: string | null | undefined,
  imageType: string | null | undefined,
  anchors: Silhouette["anchors"],
): string | null {
  for (const zone of zonesFromLocation(location)) {
    if (anchors[zone]) return zone;
  }
  const fromPhoto = zoneFromPhoto(imageType);
  return fromPhoto && anchors[fromPhoto] ? fromPhoto : null;
}

export interface FlawPin extends NumberedAnnotation {
  zone: string;
  /** Centre of the pin in the 100x130 viewBox. */
  cx: number;
  cy: number;
}

export interface FlawMap {
  pinned: FlawPin[];
  unmapped: NumberedAnnotation[];
}

// Pins in one zone fan out around its anchor instead of stacking, and sit off
// the anchor itself, where the coverage marker is drawn.
const FAN: ReadonlyArray<readonly [number, number]> = [
  [8, -8], [-8, -8], [8, 8], [-8, 8], [0, -13], [0, 13], [13, 0], [-13, 0],
];
const PIN_R = 5;

/**
 * Place every numbered flaw on the outline, keeping the callout numbers. With
 * no shape, every flaw is unmapped. Pure.
 */
export function buildFlawMap(
  groups: AnnotatedPhotoGroup[],
  silhouette: Silhouette | null,
): FlawMap {
  const pinned: FlawPin[] = [];
  const unmapped: NumberedAnnotation[] = [];
  const perZone = new Map<string, number>();
  for (const g of groups) {
    for (const a of g.annotations) {
      const zone = silhouette ? zoneForFlaw(a.location, g.image_type, silhouette.anchors) : null;
      if (!silhouette || !zone) {
        unmapped.push(a);
        continue;
      }
      const i = perZone.get(zone) ?? 0;
      perZone.set(zone, i + 1);
      const anchor = silhouette.anchors[zone]!;
      const [dx, dy] = FAN[i % FAN.length] ?? [0, 0];
      pinned.push({
        ...a,
        zone,
        cx: clamp(anchor.x * 100 + dx, PIN_R, 100 - PIN_R),
        cy: clamp(anchor.y * 130 + dy, PIN_R, 130 - PIN_R),
      });
    }
  }
  pinned.sort((a, b) => a.n - b.n);
  unmapped.sort((a, b) => a.n - b.n);
  return { pinned, unmapped };
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}
