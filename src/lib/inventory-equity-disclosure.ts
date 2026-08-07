// US-1868: the Inventory Equity scope fence, as code rather than prose.
//
// Phase 1 of GradeThread Capital is DISPLAY-ONLY valuation. Phase 2 —
// working-capital advances against inventory — is deferred on legal and
// financial-responsibility grounds and needs an explicit founder green-light
// before ANY of it is built, UI hints included.
//
// A scope fence written only in a story note has no compiler: the next feature
// on this surface can falsify it in total silence. So the two halves that CAN
// be checked live here — the disclosure every equity display must carry, and
// the vocabulary Phase 1 refuses — and `src/test/inventory-equity-scope-fence
// .test.ts` enforces both across every equity surface it discovers, including
// ones that do not exist yet.
//
// Rules and rationale: vault/20-domain/inventory-equity.md.

/**
 * The single wording every Inventory Equity display carries, verbatim.
 *
 * It states three things on purpose: that the number is an ESTIMATE, what it is
 * built from, and the three things it is NOT. The last clause is what keeps a
 * valuation from reading as an offer.
 *
 * Other surfaces (iOS, Android) cannot import this module — they carry the same
 * sentence as a literal, and the guard test compares them against this one.
 */
export const EQUITY_ESTIMATE_DISCLOSURE =
  "An estimate for planning only, from sold comps and your own sell-through — " +
  "not an appraisal, an offer, or borrowing capacity. Items without a grade or " +
  "usable comps are excluded.";

/**
 * The clause a guard can look for when the full sentence has been re-wrapped by
 * a formatter or translated into another platform's string syntax.
 */
export const EQUITY_REFUSAL_CLAUSE = "not an appraisal, an offer, or borrowing capacity";

/**
 * Phase-2 vocabulary. Any of these in user-facing equity copy means the product
 * is implying credit — which is the exact thing the founder decision of
 * 2026-07-09 deferred.
 *
 * Bare "credit" is deliberately absent: grading credits are an unrelated,
 * long-standing concept, and a guard that fires on its own product vocabulary
 * gets deleted rather than obeyed.
 */
export const PHASE_2_REFUSED_TERMS: readonly RegExp[] = [
  /\bloans?\b/i,
  /\blend(?:s|ing|er|ers)?\b/i,
  /\bborrow(?:s|ing|ed)?\b/i,
  /\badvances?\b/i,
  /\bunderwrit(?:e|es|ing|ten)\b/i,
  /\bfinanc(?:e|es|ing)\b/i,
  /\bline of credit\b/i,
  /\bcredit line\b/i,
  /\bcash advance\b/i,
  /\bget funded\b/i,
  /\bpre-?qualif\w*/i,
  /\bAPR\b/,
];
