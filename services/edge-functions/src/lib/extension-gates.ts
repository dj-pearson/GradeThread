// US-1838: which extension confidence signals a caller may see, by tier. PURE.
//
// FAIL-SAFE by construction: an anonymous/invalid caller (ent = null) gets ONLY
// the free basics (the objective grade + coverage-gap advice); every paid signal
// defaults OFF. A signed-in buyer unlocks signals per their plan's gate flags.
// The base objective grade is always returned (the funnel hook) — gating only
// hides the paid VALUE layers.

export interface GateableEntitlements {
  plan: string;
  // Only the flags this resolver reads (a structural subset of BuyerGateFlags).
  gateFlags: {
    discrepancyScoring?: boolean;
    priceFairness?: boolean;
    fitPrediction?: boolean;
  };
}

export interface ExtensionGates {
  /** claimed-vs-objective discrepancy (US-1834). */
  discrepancy: boolean;
  /** condition-adjusted price fairness (US-1835). */
  priceFairness: boolean;
  /** point-of-purchase fraud flags (US-1836) — highest tier. */
  fraud: boolean;
  /** coverage-gap photo-request macro (US-1837) — a free basic. */
  coverage: boolean;
  /** inline "will it fit me?" (US-1839) — Guard+ entitlement. */
  fit: boolean;
  /**
   * US-2241: how many listing photos a grade may analyse.
   *
   * The cap was a flat 4 for everyone, which meant a 20-photo listing was judged
   * on the first four thumbnails — and the four the gallery happens to emit
   * first are the flattering ones, not the ones showing the cuff wear. More
   * photos is a straightforwardly better read, and each one costs Vision, so it
   * is the natural thing for a paid tier to buy.
   *
   * Anonymous stays at 4: it is the free hook and the surface with no account to
   * rate-limit against beyond IP + install id.
   */
  maxImages: number;
  tier: string;
}

/** The floor, and what an anonymous caller gets. */
export const EXTENSION_MAX_IMAGES_ANON = 4;
/** What any authenticated, paid tier gets. */
export const EXTENSION_MAX_IMAGES_PAID = 8;

/**
 * Resolve the extension gates for a caller. PURE. Null ent (anonymous / bad
 * token) → only the free basics. Otherwise per the plan's gate flags, with fraud
 * reserved for the Connoisseur tier.
 */
export function resolveExtensionGates(ent: GateableEntitlements | null | undefined): ExtensionGates {
  if (!ent) {
    return {
      discrepancy: false,
      priceFairness: false,
      fraud: false,
      coverage: true,
      fit: false,
      maxImages: EXTENSION_MAX_IMAGES_ANON,
      tier: "anonymous",
    };
  }
  return {
    discrepancy: ent.gateFlags?.discrepancyScoring === true,
    priceFairness: ent.gateFlags?.priceFairness === true,
    fraud: ent.plan === "connoisseur",
    coverage: true,
    fit: ent.gateFlags?.fitPrediction === true,
    // Any plan above free earns the deeper read. `plan` is a free-form string
    // from the entitlements row, so this tests for the ONE value that must not
    // get it rather than enumerating the paid names — a new plan added later
    // should inherit the paid behaviour, not silently fall back to 4.
    maxImages: ent.plan && ent.plan !== "free"
      ? EXTENSION_MAX_IMAGES_PAID
      : EXTENSION_MAX_IMAGES_ANON,
    tier: ent.plan,
  };
}
