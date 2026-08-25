import { GRADE_FACTORS, type GradeFactorKey } from "@/lib/constants";

// US-2865. ONE worked example of what GradeThread produces, so a brand-new
// account is something to read rather than seven zeros.
//
// WHY A FIXTURE AND NOT SEEDED ROWS. Writing an example item into the user's
// own tables would mean a row they have to delete, a row that counts toward
// their plan caps, a row RLS has to scope, and a row every aggregate has to
// learn to exclude. This is a constant. Nothing here is written anywhere,
// nothing is fetched, and no query key touches it.
//
// WHY THIS GARMENT. The landing page has shown a Patagonia Better Sweater
// Fleece Jacket graded 9.0 / NWOT since US-604. Support answering "what does a
// 9.0 look like" should be able to name ONE garment, so this module is now the
// single definition and landing.tsx reads its numbers from here. A second
// example with different numbers would be the same failure US-2864 fixed for
// the glossary: right in one place and stale in the other.
//
// The money is in CENTS everywhere, matching the database columns, so nothing
// here needs a second rounding rule.

/** Marks every surface that renders this. Never render the example unbadged. */
export const EXAMPLE_BADGE = "Example";

/**
 * The one line that has to appear wherever the example renders. It says both
 * halves: this is not yours, and it cost you nothing.
 */
export const EXAMPLE_DISCLAIMER =
  "This is a worked example, not your data. Nothing here is saved to your account and it does not count against your plan.";

export interface ExamplePhoto {
  /** A member of IMAGE_TYPES. The four a grade requires. */
  type: "front" | "back" | "label" | "detail";
  label: string;
  /** What the grader is actually looking for in this shot. */
  teaches: string;
}

export interface ExampleFactor {
  key: GradeFactorKey;
  score: number;
  /** Why this factor scored what it scored, in one plain sentence. */
  note: string;
}

/** The garment. */
export const EXAMPLE_ITEM = {
  title: "Patagonia Better Sweater Fleece Jacket",
  brand: "Patagonia",
  category: "outerwear",
  size: "M",
  colorway: "Stonewash",
  sku: "EXAMPLE-001",
  /** What the seller paid, in cents. */
  acquiredPriceCents: 1200,
  source: "Goodwill on Elm St",
} as const;

/**
 * The four shots a grade requires. There are no photographs here on purpose:
 * a stock image of a real branded garment is a licensing question, and a drawn
 * frame teaches the thing that actually matters, which is WHICH four shots and
 * what each one is for.
 */
export const EXAMPLE_PHOTOS: readonly ExamplePhoto[] = [
  {
    type: "front",
    label: "Front",
    teaches: "The whole garment, flat and square on. This sets the overall read.",
  },
  {
    type: "back",
    label: "Back",
    teaches: "Where wear hides. Shoulders, seat and elbows show first.",
  },
  {
    type: "label",
    label: "Label",
    teaches: "Brand, size and fabric content, so the grade is not a guess.",
  },
  {
    type: "detail",
    label: "Detail",
    teaches: "One close-up of the worst spot you can find. Hiding it costs you later.",
  },
] as const;

/** The grade. Weights come from GRADE_FACTORS, never restated here. */
export const EXAMPLE_FACTORS: readonly ExampleFactor[] = [
  {
    key: "fabric_condition",
    score: 9.5,
    note: "Fleece face is even, with no matting or pilling under the arms.",
  },
  {
    key: "structural_integrity",
    score: 9.0,
    note: "Seams and cuffs are sound. No stretch at the hem.",
  },
  {
    key: "cosmetic_appearance",
    score: 8.5,
    note: "One faint mark near the left pocket, visible only in raking light.",
  },
  {
    key: "functional_elements",
    score: 9.0,
    note: "Full-length zip runs clean end to end. Both pockets close.",
  },
  {
    key: "odor_cleanliness",
    // NOT 9.0, and the half point is deliberate. With every factor at the
    // landing page's original numbers the weighted total came to 9.05, which
    // rounds to 9.1 -- so the certificate on the marketing page printed a 9.0
    // its own five bars did not add up to. An example nobody can follow is
    // worse than none, so the factor that honestly deserved the half point
    // took it and the total is now exactly 9.0.
    score: 8.5,
    note: "Clean, with a faint trace of storage on the collar that airs out.",
  },
] as const;

export const EXAMPLE_GRADE = {
  overallScore: 9.0,
  tier: "NWOT",
  /** Above the 0.75 human-review threshold, so this one graded straight through. */
  confidence: 0.92,
  summary:
    "A barely-worn Better Sweater. The one cosmetic mark near the pocket is the only thing keeping it off a 9.5, and it is the thing to photograph rather than hope a buyer misses.",
  certificateId: "EXAMPLE-CERT",
} as const;

/** What comparable sold listings said the garment was worth. */
export const EXAMPLE_COMP = {
  lowCents: 5500,
  medianCents: 7200,
  highCents: 8900,
  soldCount: 34,
  windowDays: 90,
  source: "eBay sold listings",
  note: "Sold comps, not asking prices. Asking prices run high because the ones that did not sell are still in the list.",
} as const;

/** What actually happened when it sold. Every deduction is named. */
export const EXAMPLE_SALE = {
  soldPriceCents: 7400,
  shippingChargedCents: 800,
  shippingCostCents: 920,
  /** Named line by line, because "fees" as one number teaches nothing. */
  fees: [
    { label: "Marketplace fee", cents: 993 },
    { label: "Payment processing", cents: 268 },
  ],
  soldOn: "eBay",
  daysToSell: 11,
} as const;

/**
 * Profit, computed rather than stated, so the example can never disagree with
 * itself. Same arithmetic the reconciliation surfaces use: what came in, minus
 * every deduction, minus what the seller paid for it.
 */
export function exampleNetCents(): number {
  const feeTotal = EXAMPLE_SALE.fees.reduce((sum, f) => sum + f.cents, 0);
  return (
    EXAMPLE_SALE.soldPriceCents +
    EXAMPLE_SALE.shippingChargedCents -
    feeTotal -
    EXAMPLE_SALE.shippingCostCents
  );
}

export function exampleProfitCents(): number {
  return exampleNetCents() - EXAMPLE_ITEM.acquiredPriceCents;
}

/**
 * The weighted overall, recomputed from the factors. Called by the guard so a
 * hand-edited factor score cannot silently contradict EXAMPLE_GRADE.overallScore
 * -- the whole point of an example is that a seller can follow the arithmetic.
 */
export function exampleWeightedScore(): number {
  const total = EXAMPLE_FACTORS.reduce(
    (sum, f) => sum + f.score * GRADE_FACTORS[f.key].weight,
    0,
  );
  return Math.round(total * 10) / 10;
}
