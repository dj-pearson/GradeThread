import type { ItemFullRow } from "@/types/database";

const DAY_MS = 24 * 60 * 60 * 1000;

export interface ListabilityResult {
  score: number; // 0-100
  reasons: string[]; // short positive factors, for tooltip/explanation
  margin: number | null; // expected margin fraction (target − cost) / target
}

// Heuristic "how ready + how worth-it is this to list right now" score.
// Readiness (max 60): graded 25, has comps 20, target priced 15.
// Worth-it (max 40): expected margin up to 25, age-in-inventory nudge up to 15.
// Photo-readiness factor is reserved for when US-106 lands (item_photos).
export function scoreListability(it: ItemFullRow): ListabilityResult {
  let score = 0;
  const reasons: string[] = [];

  if (it.grade_value != null) {
    score += 25;
    reasons.push("graded");
  }

  const hasComps = Array.isArray(it.comps) && it.comps.length > 0;
  if (hasComps) {
    score += 20;
    reasons.push("has comps");
  }

  if (it.target_price != null) {
    score += 15;
    reasons.push("target priced");
  }

  // Expected margin from target (fallback list) price vs cost.
  const price = it.target_price ?? it.list_price;
  const cost = it.purchase_price ?? 0;
  let margin: number | null = null;
  if (price != null && price > 0) {
    margin = (price - cost) / price;
    const marginPts = Math.max(0, Math.min(25, Math.round(margin * 30)));
    score += marginPts;
    if (margin >= 0.6) reasons.push("high margin");
  }

  // Age nudge — older items score a little higher so the backlog clears.
  const created = it.created_at ? new Date(it.created_at).getTime() : null;
  if (created != null && !isNaN(created)) {
    const days = Math.floor((Date.now() - created) / DAY_MS);
    const agePts = Math.min(15, Math.round(days / 7));
    score += agePts;
    if (days >= 30) reasons.push("aging backlog");
  }

  return { score: Math.min(100, Math.round(score)), reasons, margin };
}

// Highest comp price recorded on an item, for the "Highest comp" sort.
export function maxCompPrice(it: ItemFullRow): number {
  if (!Array.isArray(it.comps) || it.comps.length === 0) return 0;
  return it.comps.reduce((max, c) => {
    const p = Number(c.price);
    return Number.isFinite(p) && p > max ? p : max;
  }, 0);
}
