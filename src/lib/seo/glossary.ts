// Condition-grading glossary / knowledge hub (US-303).
//
// One definitive page per grade TIER and per grading FACTOR, generated from the
// canonical vocabulary in src/lib/constants.ts (GRADE_TIERS + GRADE_FACTORS).
// These are the hub-and-spoke "spokes" off the /condition-grading pillar
// (US-302): cheap, durable, AI-citation surfaces that answer queries like
// "what does NWOT mean" or "what is a fabric condition grade".
//
// This module is PURE DATA: it imports only the constants (relative path, so the
// Vite config's Node context can resolve it) and a type-only PublicRoute. It must
// NOT import the JSON-LD builders or public-routes *values* — public-routes.ts
// imports glossaryRoutes() from here, so a value cycle would be a footgun. The
// JSON-LD composition lives in src/pages/marketing/marketing-jsonld.ts, which is
// never imported by the registry.

import { GRADE_TIERS, GRADE_FACTORS, type GradeFactorKey } from "../constants";
import type { PublicRoute } from "./public-routes";

export type GlossaryKind = "tier" | "factor";

export interface GlossaryFaq {
  q: string;
  a: string;
}

export interface GlossaryEntry {
  /** URL slug, e.g. "nwt" or "fabric-condition". */
  slug: string;
  /** Absolute path: `/grading/<slug>`. */
  path: string;
  kind: GlossaryKind;
  /** Display term, e.g. "NWT" or "Fabric Condition". */
  term: string;
  /**
   * Full expansion of an abbreviated term, e.g. "New With Tags" (NWT/NWOT
   * tiers). Surfaced as the DefinedTerm `alternateName` (US-973); undefined for
   * terms that aren't abbreviations (most tiers + every factor).
   */
  expansion?: string;
  /** <title> (without the " | GradeThread" suffix the SEO layer adds). */
  title: string;
  /** Meta description (≤ ~160 chars). */
  description: string;
  /** On-page H1. */
  h1: string;
  /** The numeric anchor (tier) or weight sentence (factor) shown on-page. */
  rangeLabel: string;
  /** Answer-first lead definition (1–2 sentences, mirrored into the meta). */
  definition: string;
  /** "What graders look for" bullets. */
  lookFor: string[];
  /** Concrete examples that illustrate the term. */
  examples: string[];
  /** Q&A pairs rendered visibly AND as FAQPage JSON-LD. */
  faqs: GlossaryFaq[];
  /** Slugs of related glossary entries (internal-link block). */
  relatedSlugs: string[];
}

// ── Slug derivation (keyed off the constants) ───────────────────────
/** "Very Good" → "very-good", "NWT" → "nwt". */
export function tierSlug(tier: string): string {
  return tier.toLowerCase().replace(/\s+/g, "-");
}
/** "fabric_condition" → "fabric-condition". */
export function factorSlug(key: string): string {
  return key.replace(/_/g, "-");
}

// ── Editorial content, keyed by tier name / factor key ──────────────
// Each tier/factor in constants MUST have an entry here, or buildEntries()
// throws — which the glossary test surfaces as a build failure.

interface TierContent {
  /** Numeric anchor on the 1.0–10.0 scale (string so "3–4" works for Poor). */
  score: string;
  expansion?: string; // e.g. "New With Tags"
  definition: string;
  lookFor: string[];
  examples: string[];
  faqs: GlossaryFaq[];
}

const TIER_CONTENT: Record<string, TierContent> = {
  NWT: {
    score: "10",
    expansion: "New With Tags",
    definition:
      "NWT (New With Tags) is a brand-new, unworn garment with its original retail tags still attached. It anchors the top of the 1.0–10.0 condition scale at 10 — indistinguishable from what you'd buy in-store.",
    lookFor: [
      "Original retail or brand tags still attached, undamaged",
      "No signs of wear, washing, pilling, or fading",
      "Original folds/creases consistent with never having been worn",
      "Factory packaging or polybag often still present",
    ],
    examples: [
      "A sweater bought, never worn, with the price tag and brand hangtag intact.",
      "Sneakers in the box with tissue and the size sticker untouched.",
    ],
    faqs: [
      {
        q: "What does NWT mean?",
        a: "NWT stands for 'New With Tags' — a brand-new, unworn item that still has its original retail tags attached. On the GradeThread scale it anchors a 10 out of 10.",
      },
      {
        q: "Is NWT the same as brand new?",
        a: "Yes. NWT is the highest condition grade and means the item is new, unworn, and still tagged, exactly as it would be sold at retail.",
      },
    ],
  },
  NWOT: {
    score: "9",
    expansion: "New Without Tags",
    definition:
      "NWOT (New Without Tags) is a new, unworn garment whose original tags have been removed. It anchors a 9 on the 1.0–10.0 scale — new condition, just missing the tags.",
    lookFor: [
      "No wear, laundering marks, pilling, or fading",
      "Tags removed but no thread holes or tag-tear damage",
      "Crisp, unwashed fabric hand and original finish",
      "May still have a 'never worn' shape and creasing",
    ],
    examples: [
      "A dress that was bought, had its tags snipped, but was never actually worn.",
      "A gift item that was unwrapped and detagged but stayed in the closet.",
    ],
    faqs: [
      {
        q: "What does NWOT mean?",
        a: "NWOT stands for 'New Without Tags' — an item that is new and unworn but no longer has its original retail tags. It anchors a 9 on the GradeThread 1.0–10.0 scale.",
      },
      {
        q: "Why is NWOT a 9 and not a 10?",
        a: "Without the original tags, a buyer can't fully verify the item was never worn, so NWOT sits one step below NWT even though the garment itself is in new condition.",
      },
    ],
  },
  Excellent: {
    score: "8",
    definition:
      "Excellent condition (an 8 on the 1.0–10.0 scale) describes a gently used garment with no notable flaws. It may have been worn or washed a few times but still looks nearly new.",
    lookFor: [
      "No holes, stains, or repairs",
      "Minimal to no pilling; colors still rich",
      "Hardware (zippers, buttons, snaps) fully functional",
      "Only the faintest signs of laundering or handling",
    ],
    examples: [
      "A jacket worn a handful of times with no visible wear.",
      "Jeans washed twice that still look crisp with no fading at stress points.",
    ],
    faqs: [
      {
        q: "What does 'Excellent' condition mean?",
        a: "Excellent means gently used with no notable flaws — worn or washed only a few times and still looking nearly new. It anchors an 8 on the 1.0–10.0 scale.",
      },
      {
        q: "What's the difference between Excellent and Very Good?",
        a: "Excellent (8) shows essentially no wear, while Very Good (7) has light, normal signs of use that don't affect the overall look or function.",
      },
    ],
  },
  "Very Good": {
    score: "7",
    definition:
      "Very Good condition (a 7 on the 1.0–10.0 scale) means light, normal wear: minor signs of use that don't affect the overall look or function of the garment.",
    lookFor: [
      "Light, even wear consistent with occasional use",
      "Slight softening of fabric; very minor pilling at most",
      "No holes, stains, or odor; fully functional hardware",
      "Color still strong with at most faint fading",
    ],
    examples: [
      "A t-shirt worn regularly for a season that holds its shape and color.",
      "A coat with light wear at the cuffs but no damage.",
    ],
    faqs: [
      {
        q: "What does 'Very Good' condition mean?",
        a: "Very Good means light, normal wear with minor signs of use that don't affect the look or function. It anchors a 7 on the 1.0–10.0 scale.",
      },
    ],
  },
  Good: {
    score: "6",
    definition:
      "Good condition (a 6 on the 1.0–10.0 scale) describes visible but minor wear — slight pilling, faint marks, or small cosmetic issues — on a garment that is still very wearable.",
    lookFor: [
      "Noticeable but minor pilling, fading, or surface marks",
      "Small cosmetic issues that don't impair use",
      "Hardware works; seams intact",
      "Overall still presentable and wearable",
    ],
    examples: [
      "A well-loved hoodie with mild pilling and slightly faded print.",
      "Jeans with light whiskering and a faint, removable mark.",
    ],
    faqs: [
      {
        q: "What does 'Good' condition mean?",
        a: "Good means visible but minor wear — slight pilling, faint marks, or small cosmetic issues — on an item that is still very wearable. It anchors a 6 on the 1.0–10.0 scale.",
      },
    ],
  },
  Fair: {
    score: "5",
    definition:
      "Fair condition (a 5 on the 1.0–10.0 scale) means noticeable wear or a documented flaw — such as a stain, hole, or fading — that affects the garment's appearance.",
    lookFor: [
      "A documented flaw: stain, small hole, snag, or pull",
      "Clear fading, pilling, or stretched areas",
      "Wear that affects appearance but not core wearability",
      "Flaws that should be photographed and disclosed",
    ],
    examples: [
      "A shirt with a small but visible stain near the hem.",
      "A sweater with a repaired snag and noticeable pilling.",
    ],
    faqs: [
      {
        q: "What does 'Fair' condition mean?",
        a: "Fair means noticeable wear or a documented flaw — a stain, hole, or fading — that affects appearance. It anchors a 5 on the 1.0–10.0 scale and should be disclosed with photos.",
      },
    ],
  },
  Poor: {
    score: "3–4",
    definition:
      "Poor condition (a 3–4 on the 1.0–10.0 scale) means significant damage or heavy wear. Items in this range are often sold for parts, repair, or intentionally distressed styling.",
    lookFor: [
      "Holes, tears, large stains, or broken hardware",
      "Heavy fading, thinning fabric, or structural damage",
      "Wear that materially limits normal use",
      "Best sold transparently as 'for parts/repair' or distressed",
    ],
    examples: [
      "A vintage tee with multiple holes sold for its graphic.",
      "Distressed denim with intentional rips and heavy fading.",
    ],
    faqs: [
      {
        q: "What does 'Poor' condition mean?",
        a: "Poor means significant damage or heavy wear — holes, tears, large stains, or broken hardware. It sits at 3–4 on the 1.0–10.0 scale and is often sold for parts, repair, or distressed styling.",
      },
    ],
  },
};

interface FactorContent {
  definition: string;
  lookFor: string[];
  examples: string[];
  faqs: GlossaryFaq[];
}

const FACTOR_CONTENT: Record<GradeFactorKey, FactorContent> = {
  fabric_condition: {
    definition:
      "Fabric Condition is the most heavily weighted grading factor at 30% of the overall grade. It measures the state of the material itself — pilling, fading, thinning, stains, and overall fabric integrity.",
    lookFor: [
      "Pilling, fuzzing, or surface abrasion",
      "Color fading, discoloration, or staining",
      "Thinning, stretching, or weakened fibers",
      "Snags, pulls, and washing-related wear",
    ],
    examples: [
      "A cotton tee judged on how crisp vs. pilled and faded the fabric is.",
      "A wool sweater assessed for felting, pilling, and thinning at the elbows.",
    ],
    faqs: [
      {
        q: "What is the fabric condition grade?",
        a: "Fabric Condition measures the state of the material — pilling, fading, thinning, and stains. It is the most heavily weighted factor at 30% of the overall GradeThread grade.",
      },
      {
        q: "Why is fabric condition weighted the most?",
        a: "Fabric is the largest, most visible part of any garment and the hardest to repair, so its condition is the single strongest signal of overall wear — hence the 30% weight.",
      },
    ],
  },
  structural_integrity: {
    definition:
      "Structural Integrity is the second-heaviest factor at 25% of the overall grade. It assesses seams, stitching, and the garment's construction — whether the item is sound and holds its intended shape.",
    lookFor: [
      "Seam strength and any loose or split stitching",
      "Holes, tears, or repaired areas",
      "Shape retention vs. stretching or sagging",
      "Hems, cuffs, and reinforced stress points",
    ],
    examples: [
      "Jeans checked for blown-out inseams and intact belt loops.",
      "A blazer assessed for shoulder construction and lining seams.",
    ],
    faqs: [
      {
        q: "What is structural integrity in clothing grading?",
        a: "Structural Integrity assesses seams, stitching, and construction — whether the garment is sound and holds its shape. It accounts for 25% of the overall grade.",
      },
    ],
  },
  cosmetic_appearance: {
    definition:
      "Cosmetic Appearance accounts for 20% of the overall grade. It captures the garment's visual presentation — how clean, crisp, and well-kept it looks at a glance, beyond the fabric and construction.",
    lookFor: [
      "Surface marks, scuffs, or visible blemishes",
      "Wrinkling, misshaping, or poor drape",
      "Print, graphic, or embellishment condition",
      "Overall 'shelf appeal' and presentation",
    ],
    examples: [
      "A graphic tee judged on whether the print is cracked or vibrant.",
      "A handbag assessed for corner scuffs and surface sheen.",
    ],
    faqs: [
      {
        q: "What is cosmetic appearance in a condition grade?",
        a: "Cosmetic Appearance captures how clean, crisp, and well-kept a garment looks at a glance — surface marks, wrinkling, and print condition. It is 20% of the overall grade.",
      },
    ],
  },
  functional_elements: {
    definition:
      "Functional Elements make up 15% of the overall grade. This factor checks the working parts of a garment — zippers, buttons, snaps, drawstrings, and other hardware — to confirm they all operate correctly.",
    lookFor: [
      "Zippers that glide and lock without catching",
      "All buttons, snaps, and hooks present and secure",
      "Drawstrings, elastic, and Velcro still effective",
      "Clasps, buckles, and hardware free of corrosion",
    ],
    examples: [
      "A jacket whose main zipper is tested for smooth full travel.",
      "Cargo pants checked for missing snaps and a working button fly.",
    ],
    faqs: [
      {
        q: "What are functional elements in clothing grading?",
        a: "Functional Elements are the working parts of a garment — zippers, buttons, snaps, and other hardware — checked to confirm they operate correctly. They account for 15% of the overall grade.",
      },
    ],
  },
  odor_cleanliness: {
    definition:
      "Odor & Cleanliness is weighted at 10% of the overall grade. It evaluates whether the garment is clean and free of odors such as smoke, mildew, or perfume that would affect a buyer's experience.",
    lookFor: [
      "Smoke, mildew, mustiness, or strong perfume odors",
      "Residual stains, dirt, or laundry residue",
      "Pet hair or environmental contaminants",
      "Overall freshness and ready-to-wear cleanliness",
    ],
    examples: [
      "A coat flagged for a lingering smoke smell despite looking clean.",
      "A thrifted shirt assessed for mustiness before listing.",
    ],
    faqs: [
      {
        q: "How does odor and cleanliness affect a condition grade?",
        a: "Odor & Cleanliness evaluates whether an item is clean and free of smells like smoke, mildew, or perfume. It is weighted at 10% of the overall grade.",
      },
    ],
  },
};

// ── Build the entries from constants + content ──────────────────────

function tierTitle(term: string, expansion?: string): string {
  // Keep titles (incl the " | GradeThread" suffix the SEO layer adds) within the
  // ~60-char SERP cap enforced by src/lib/seo/__tests__/route-metadata.test.ts
  // (US-435).
  return expansion
    ? `${term} (${expansion}) — Grade Meaning`
    : `${term} Condition Grade — What It Means`;
}

function tierDescription(term: string, score: string, expansion?: string): string {
  const exp = expansion ? `${term} means "${expansion}". ` : "";
  return `${exp}What ${term} condition means in clothing grading and why it anchors ${score} on the 1.0–10.0 scale.`;
}

function buildTierEntries(): GlossaryEntry[] {
  return GRADE_TIERS.map((term, i) => {
    const content = TIER_CONTENT[term];
    if (!content) {
      throw new Error(`[glossary] missing TIER_CONTENT for grade tier "${term}"`);
    }
    const slug = tierSlug(term);
    // Related: adjacent tiers (neighbors on the scale) + the top fabric factor.
    const related: string[] = [];
    if (i > 0) related.push(tierSlug(GRADE_TIERS[i - 1]!));
    if (i < GRADE_TIERS.length - 1) related.push(tierSlug(GRADE_TIERS[i + 1]!));
    related.push(factorSlug("fabric_condition"));
    return {
      slug,
      path: `/grading/${slug}`,
      kind: "tier",
      term,
      ...(content.expansion ? { expansion: content.expansion } : {}),
      title: tierTitle(term, content.expansion),
      description: tierDescription(term, content.score, content.expansion),
      h1: content.expansion
        ? `${term} — ${content.expansion}`
        : `${term} condition`,
      rangeLabel:
        content.score === "3–4"
          ? "Anchors 3–4 on the 1.0–10.0 scale"
          : `Anchors ${content.score} on the 1.0–10.0 scale`,
      definition: content.definition,
      lookFor: content.lookFor,
      examples: content.examples,
      faqs: content.faqs,
      relatedSlugs: related,
    };
  });
}

function buildFactorEntries(): GlossaryEntry[] {
  const keys = Object.keys(GRADE_FACTORS) as GradeFactorKey[];
  const factorSlugs = keys.map(factorSlug);
  return keys.map((key, i) => {
    const content = FACTOR_CONTENT[key];
    if (!content) {
      throw new Error(`[glossary] missing FACTOR_CONTENT for factor "${key}"`);
    }
    const { label, weight } = GRADE_FACTORS[key];
    const pct = `${(weight * 100).toFixed(0)}%`;
    const slug = factorSlug(key);
    // Related: the other four factors.
    const related = factorSlugs.filter((_, j) => j !== i);
    return {
      slug,
      path: `/grading/${slug}`,
      kind: "factor",
      term: label,
      title: `${label} — Grading Factor`,
      description: `What the ${label} factor measures in clothing condition grading and why it is weighted ${pct} of the overall grade.`,
      h1: `${label} grading factor`,
      rangeLabel: `Weighted ${pct} of the overall grade`,
      definition: content.definition,
      lookFor: content.lookFor,
      examples: content.examples,
      faqs: content.faqs,
      relatedSlugs: related,
    };
  });
}

/** Every glossary entry (7 tiers + 5 factors), tiers first. */
export const GLOSSARY_ENTRIES: GlossaryEntry[] = [
  ...buildTierEntries(),
  ...buildFactorEntries(),
];

/** Quick path → entry lookup. */
const ENTRY_BY_PATH = new Map(GLOSSARY_ENTRIES.map((e) => [e.path, e]));
const ENTRY_BY_SLUG = new Map(GLOSSARY_ENTRIES.map((e) => [e.slug, e]));

export function getGlossaryEntryByPath(path: string): GlossaryEntry | undefined {
  return ENTRY_BY_PATH.get(path);
}
export function getGlossaryEntryBySlug(slug: string): GlossaryEntry | undefined {
  return ENTRY_BY_SLUG.get(slug);
}
export function isGlossaryPath(path: string): boolean {
  return ENTRY_BY_PATH.has(path);
}

/** The trail items (relative paths) for a glossary breadcrumb. */
export function glossaryTrail(
  entry: GlossaryEntry,
): Array<{ name: string; path: string }> {
  return [
    { name: "GradeThread", path: "/" },
    { name: "Condition grading", path: "/condition-grading" },
    { name: entry.term, path: entry.path },
  ];
}

/**
 * PublicRoute entries for every glossary page, spread into PUBLIC_ROUTES so they
 * auto-flow into the manifest → sitemap (US-293) + IndexNow (US-297) + the
 * prerender (US-292). Tiers rank a touch higher than factors.
 */
export function glossaryRoutes(): PublicRoute[] {
  return GLOSSARY_ENTRIES.map((e) => ({
    path: e.path,
    title: e.title,
    description: e.description,
    changefreq: "monthly",
    priority: e.kind === "tier" ? 0.7 : 0.6,
    jsonLdType: "FAQPage",
  }));
}
