// US-3216: which shape the certificate's coverage map draws, per garment.
//
// Pure data plus one lookup, in its own module so a test can import it without
// pulling a React component in — the same reason inventory-tabs.ts is separate
// from the page it serves.

// US-3216: the silhouette is chosen by garment, not drawn once for everything.
//
// It used to be a single hard-coded shape whose own comment read "collar +
// sleeves + body", drawn for every certificate. On a pair of trousers that put
// the Waistband, Inseam and Hem markers over a shirt's chest and sleeves: the
// legend was right and the picture contradicted it, on a document a buyer is
// asked to trust. A drawing that argues with its own labels is worse than no
// drawing, which is why `null` is a supported answer below.
//
// Anchors live WITH their shape. A waistband at 0.78 down a shirt is a hem; the
// same fraction on trousers is the top of the garment. Sharing one anchor table
// across shapes is exactly how the two drifted apart in the first place.
export interface Silhouette {
  /** SVG path in the 100x130 viewBox every shape shares. */
  path: string;
  /** Said aloud by a screen reader, so the drawing is not sighted-only. */
  shape: string;
  /** Fractional (0-1) anchor per zone id. A zone with none stays legend-only. */
  anchors: Record<string, { x: number; y: number }>;
}

const TOP_SILHOUETTE: Silhouette = {
  // Collar, shoulders, sleeves, body.
  path: "M38 6 L50 2 L62 6 L82 16 L76 34 L66 30 L66 122 L34 122 L34 30 L24 34 L18 16 Z",
  shape: "a top",
  anchors: {
    collar_neckline: { x: 0.5, y: 0.12 },
    front: { x: 0.5, y: 0.45 },
    back: { x: 0.5, y: 0.45 },
    underarms: { x: 0.26, y: 0.34 },
    closure: { x: 0.5, y: 0.6 },
    pockets: { x: 0.68, y: 0.62 },
    cuffs: { x: 0.12, y: 0.52 },
    waistband: { x: 0.5, y: 0.88 },
    hem: { x: 0.5, y: 0.94 },
    lining: { x: 0.36, y: 0.5 },
    branding: { x: 0.62, y: 0.2 },
  },
};

const BOTTOM_SILHOUETTE: Silhouette = {
  // Waistband across the top, two legs, a notch at the crotch.
  path: "M30 4 L70 4 L74 30 L68 122 L54 122 L50 52 L46 122 L32 122 L26 30 Z",
  shape: "a pair of bottoms",
  anchors: {
    waistband: { x: 0.5, y: 0.06 },
    front: { x: 0.36, y: 0.5 },
    back: { x: 0.64, y: 0.5 },
    // Where the legs meet, which is where this seam actually is.
    inseam_crotch: { x: 0.5, y: 0.4 },
    pockets: { x: 0.68, y: 0.18 },
    closure: { x: 0.5, y: 0.14 },
    hem: { x: 0.38, y: 0.93 },
    lining: { x: 0.4, y: 0.66 },
    branding: { x: 0.62, y: 0.09 },
    // A skirt shares this shape and has no inseam; its zones simply have no
    // anchor here and fall through to the legend.
  },
};

const ONEPIECE_SILHOUETTE: Silhouette = {
  // A dress: neckline and shoulders like a top, flaring to a hem.
  path: "M38 6 L50 2 L62 6 L78 14 L72 32 L66 28 L78 122 L22 122 L34 28 L28 32 L22 14 Z",
  shape: "a dress",
  anchors: {
    collar_neckline: { x: 0.5, y: 0.12 },
    front: { x: 0.5, y: 0.42 },
    back: { x: 0.5, y: 0.42 },
    underarms: { x: 0.28, y: 0.26 },
    waistband: { x: 0.5, y: 0.44 },
    closure: { x: 0.5, y: 0.3 },
    hem: { x: 0.5, y: 0.94 },
    lining: { x: 0.36, y: 0.6 },
    branding: { x: 0.62, y: 0.18 },
  },
};

/**
 * The shape for a garment category, or null when we do not have one.
 *
 * NULL IS A REAL ANSWER. Footwear, bags, belts, hats and scarves have zones
 * (sole, insole, strap, hardware) that no apparel outline can place honestly,
 * and drawing a shirt behind them is the bug this fixes rather than a
 * tolerable approximation. Those certificates get the legend alone, which was
 * always the authoritative list.
 *
 * Keys are the `garment_category` enum from 00001, so an unmapped value can
 * only ever mean "no drawing" — never "the wrong drawing".
 */
const SILHOUETTE_BY_CATEGORY: Record<string, Silhouette> = {
  "t-shirt": TOP_SILHOUETTE,
  shirt: TOP_SILHOUETTE,
  blouse: TOP_SILHOUETTE,
  sweater: TOP_SILHOUETTE,
  hoodie: TOP_SILHOUETTE,
  jacket: TOP_SILHOUETTE,
  coat: TOP_SILHOUETTE,

  jeans: BOTTOM_SILHOUETTE,
  pants: BOTTOM_SILHOUETTE,
  shorts: BOTTOM_SILHOUETTE,
  skirt: BOTTOM_SILHOUETTE,

  dress: ONEPIECE_SILHOUETTE,
};

export function silhouetteFor(category: string | null | undefined): Silhouette | null {
  return SILHOUETTE_BY_CATEGORY[(category ?? "").trim().toLowerCase()] ?? null;
}
