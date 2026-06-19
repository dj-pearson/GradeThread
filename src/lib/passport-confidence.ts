// Garment Passport confidence taxonomy (US-1102) — the single source of truth.
//
// Every link in a passport chain (a garment_event) is established with a known
// degree of certainty. We surface that honestly so the passport is legally safe:
// proven vs. inferred is ALWAYS visible, and we never over-claim on a link we
// only inferred. There are exactly THREE levels, mirroring the
// garment_event_confidence enum (00256) so the DB, edge, and every UI agree:
//
//   • deterministic — a first-party fact: a physical tag scan or owner-confirmed
//     claim handoff (US-1094/1096), marketplace order lineage (US-1100), or the
//     first-party grade itself.
//   • probable      — an INFERRED link: a visual fingerprint match (US-1097/1098)
//     or a reused-photo relist match (US-1099). Likely, not confirmed.
//   • unknown       — basis not independently verified (e.g. a self-declared origin).
//
// Copy is deliberately measured (no "confirmed"/"guaranteed" on probable/unknown)
// for legal safety. This module is PURE + unit-tested; UIs read labels/tooltips
// and the aggregate chain-strength from here so nothing drifts.

export type ConfidenceLevel = "deterministic" | "probable" | "unknown";

export interface ConfidenceTaxonomyEntry {
  level: ConfidenceLevel;
  /** Badge label shown to users. */
  label: string;
  /** Tooltip explaining the BASIS — measured wording, no over-claiming. */
  tooltip: string;
}

export const CONFIDENCE_TAXONOMY: Record<ConfidenceLevel, ConfidenceTaxonomyEntry> = {
  deterministic: {
    level: "deterministic",
    label: "Verified",
    tooltip:
      "Established by a first-party fact — a physical tag scan, an owner-confirmed " +
      "claim handoff, marketplace order lineage, or the original grade itself.",
  },
  probable: {
    level: "probable",
    label: "Probable",
    tooltip:
      "Inferred from a visual fingerprint or reused-photo match. A likely link in " +
      "the chain — not an independently verified one.",
  },
  unknown: {
    level: "unknown",
    label: "Unverified",
    tooltip:
      "The basis for this link isn't independently verified (for example, a " +
      "self-declared origin).",
  },
};

/** Coerce any stored confidence string to one of the three known levels. */
export function confidenceLevelOf(c: string | null | undefined): ConfidenceLevel {
  return c === "deterministic" || c === "probable" ? c : "unknown";
}

/** Label + tooltip for a stored confidence value (always resolves). */
export function confidenceInfo(c: string | null | undefined): ConfidenceTaxonomyEntry {
  return CONFIDENCE_TAXONOMY[confidenceLevelOf(c)];
}

export type ChainStrengthLabel = "Strong" | "Moderate" | "Emerging" | "None";

export interface ChainStrength {
  total: number;
  deterministic: number;
  probable: number;
  unknown: number;
  /** Fraction of links that are deterministic, [0,1]. */
  score: number;
  label: ChainStrengthLabel;
  /** One-line, legally-measured summary for the aggregate indicator. */
  summary: string;
}

/**
 * Summarize a chain's overall strength from its per-link confidences — "how many
 * hops are proven vs. inferred". Strength is driven by the share of DETERMINISTIC
 * links (the proven ones); probable/unknown links don't add strength but are
 * counted so the summary stays honest. Pure.
 */
export function chainStrength(confidences: Array<string | null | undefined>): ChainStrength {
  let deterministic = 0;
  let probable = 0;
  let unknown = 0;
  for (const c of confidences) {
    const level = confidenceLevelOf(c);
    if (level === "deterministic") deterministic++;
    else if (level === "probable") probable++;
    else unknown++;
  }
  const total = confidences.length;
  const score = total === 0 ? 0 : deterministic / total;

  let label: ChainStrengthLabel;
  if (total === 0) label = "None";
  else if (score >= 0.75) label = "Strong";
  else if (score >= 0.4) label = "Moderate";
  else label = "Emerging";

  const summary = total === 0
    ? "No history recorded yet."
    : `${deterministic} of ${total} ${total === 1 ? "link is" : "links are"} independently verified.`;

  return { total, deterministic, probable, unknown, score, label, summary };
}
