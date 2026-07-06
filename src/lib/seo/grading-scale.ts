// The GradeThread Clothing Condition Grading Scale — canonical scale data
// (US-1664, the SEO 2.0 keystone).
//
// This is the single source of truth for the named 1.0–10.0 scale as rendered on
// the /grading/scale/ pillar: the quotable definition, the grade-band TABLE rows
// (Grade | Label | Criteria | Typical flaws | Marketplace equivalent), and the
// DefinedTerm inputs for the scale's DefinedTermSet JSON-LD.
//
// It is PURE DATA. The term / score / label / one-line summary / spoke path for
// each band are sourced from tierSummaries() (src/lib/seo/glossary.ts → the same
// canonical TIER_CONTENT the glossary spokes and the grading-standard page use),
// so the scale page can NEVER drift from the per-tier pages. The three extra
// columns the standard adds — the compressed criteria, the typical flaws, and the
// marketplace-vocabulary equivalent — are editorial, keyed by tier term below.
//
// Imported by the page (src/pages/marketing/grading-scale.tsx), the prerender
// head-builder (via marketing-jsonld.ts), and the printable-chart generator
// (scripts/generate-scale-chart.mjs), so all three render identical data.

import { tierSummaries, type TierSummary } from "./glossary";
import type { DefinedTermInput } from "./json-ld";

// The 40–60 word, self-contained, quotable definition rendered directly under
// the H1 (the paragraph-snippet + AI-citation unit). Names the standard "the
// GradeThread Scale" — used consistently everywhere (SEO plan §6.1).
export const GRADETHREAD_SCALE_DEFINITION =
  "The GradeThread Scale is a standardized 1.0–10.0 system for grading the " +
  "condition of pre-owned clothing. Each garment is scored across five weighted " +
  "factors — fabric, structure, cosmetics, function, and odor — then mapped to " +
  "seven named tiers, from New With Tags (10) down to Poor (3–4), so a condition " +
  "grade means the same thing for every seller, buyer, and marketplace.";

/** The stable, canonical name of the scale — capitalized consistently (GEO). */
export const GRADETHREAD_SCALE_NAME =
  "The GradeThread Clothing Condition Grading Scale";

// Extra table columns per tier (keyed by the tier `term` in constants). Compressed
// for the at-a-glance scale table; the per-tier glossary spokes carry the full
// "what graders look for" detail.
interface ScaleBandExtra {
  /** Compressed grading criteria (what earns this band). */
  criteria: string;
  /** The flaws you typically see at this band. */
  typicalFlaws: string;
  /** How marketplaces name this condition (eBay / Poshmark / reseller vocab). */
  marketplaceEquivalent: string;
}

const BAND_EXTRA: Record<string, ScaleBandExtra> = {
  NWT: {
    criteria: "Brand-new and unworn with original retail tags still attached.",
    typicalFlaws: "None — indistinguishable from in-store stock.",
    marketplaceEquivalent: "eBay “New with tags” · Poshmark “NWT”",
  },
  NWOT: {
    criteria: "New and unworn, but the original tags have been removed.",
    typicalFlaws: "None beyond the missing tags; no wear or laundering.",
    marketplaceEquivalent: "eBay “New without tags” · Poshmark “NWOT”",
  },
  Excellent: {
    criteria: "Gently used with no notable flaws; looks nearly new.",
    typicalFlaws: "At most the faintest signs of laundering or handling.",
    marketplaceEquivalent: "Excellent Used Condition (EUC) · eBay “Pre-owned”",
  },
  "Very Good": {
    criteria: "Light, even wear that doesn’t affect look or function.",
    typicalFlaws: "Slight fabric softening; very minor pilling at most.",
    marketplaceEquivalent: "Very Good Used Condition (VGUC)",
  },
  Good: {
    criteria: "Visible but minor wear on a garment that’s still very wearable.",
    typicalFlaws: "Noticeable pilling, light fading, or small surface marks.",
    marketplaceEquivalent: "Good Used Condition (GUC)",
  },
  Fair: {
    criteria: "Noticeable wear or a documented flaw that affects appearance.",
    typicalFlaws: "A stain, small hole, snag, or clear fading — disclose it.",
    marketplaceEquivalent: "eBay “Pre-owned” with disclosed flaws",
  },
  Poor: {
    criteria: "Significant damage or heavy wear; sold transparently as-is.",
    typicalFlaws: "Holes, tears, large stains, broken hardware, or distressing.",
    marketplaceEquivalent: "eBay “For parts or not working” · distressed / repair",
  },
};

export interface ScaleBand extends TierSummary {
  criteria: string;
  typicalFlaws: string;
  marketplaceEquivalent: string;
}

/** The ordered grade bands (10 → Poor) with all five scale-table columns. */
export function scaleBands(): ScaleBand[] {
  return tierSummaries().map((t) => {
    const extra = BAND_EXTRA[t.term];
    if (!extra) {
      throw new Error(`[grading-scale] missing BAND_EXTRA for grade tier "${t.term}"`);
    }
    return { ...t, ...extra };
  });
}

/**
 * DefinedTerm inputs for the scale's DefinedTermSet (US-1664 AC3). One per grade
 * band; each links to its /grading/<slug> spoke. The definition is the band's
 * canonical one-line summary + its score anchor, so the structured data mirrors
 * the visible table row.
 */
export function scaleDefinedTerms(): DefinedTermInput[] {
  return scaleBands().map((b) => ({
    term: b.label,
    definition: `${b.summary} Anchors ${b.score} on the GradeThread 1.0–10.0 condition scale.`,
    path: b.path,
  }));
}
