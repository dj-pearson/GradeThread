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
  tier: string;
}

/**
 * Resolve the extension gates for a caller. PURE. Null ent (anonymous / bad
 * token) → only the free basics. Otherwise per the plan's gate flags, with fraud
 * reserved for the Connoisseur tier.
 */
export function resolveExtensionGates(ent: GateableEntitlements | null | undefined): ExtensionGates {
  if (!ent) {
    return { discrepancy: false, priceFairness: false, fraud: false, coverage: true, tier: "anonymous" };
  }
  return {
    discrepancy: ent.gateFlags?.discrepancyScoring === true,
    priceFairness: ent.gateFlags?.priceFairness === true,
    fraud: ent.plan === "connoisseur",
    coverage: true,
    tier: ent.plan,
  };
}
