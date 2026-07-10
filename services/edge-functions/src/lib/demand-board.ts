// US-1830: 'Graded Wanted' demand board — want normalization + matching adapter.
//
// PURE (unit-tested). A want is matched with the SAME engine as saved-search
// alerts: `wantToSearch` projects a want onto the AlertSearch shape so
// condition-alerts.matchesSearch does the work (one engine, no drift). Input
// normalization keeps criteria arrays clean + bounded and clamps the numbers.

import { type AlertSearch, matchesSearch } from "./condition-alerts.ts";

const MAX_TERMS = 20;
const MAX_TERM_LEN = 60;

/** Clean a criteria array: strings only, trimmed, de-duped, bounded. */
export function normalizeTerms(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of raw) {
    if (typeof v !== "string") continue;
    const t = v.trim().slice(0, MAX_TERM_LEN);
    if (!t) continue;
    const key = t.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t);
    if (out.length >= MAX_TERMS) break;
  }
  return out;
}

export interface WantInput {
  brands: string[];
  categories: string[];
  keywords: string[];
  min_grade: number | null;
  max_price_cents: number | null;
  size: string | null;
  budget_cents: number | null;
  visibility: "public" | "private";
  expires_at: string | null;
}

function clampGrade(raw: unknown): number | null {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return null;
  return Math.min(10, Math.max(1, Math.round(raw * 2) / 2));
}
function nonNegCents(raw: unknown): number | null {
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0) return null;
  return Math.round(raw);
}

/**
 * Coerce an untrusted want body into a safe, fully-populated WantInput. Never
 * throws. A want with NO criteria at all is invalid (it would match everything)
 * — the caller rejects `hasCriteria(want) === false`.
 */
export function normalizeWantInput(raw: unknown): WantInput {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  return {
    brands: normalizeTerms(r.brands),
    categories: normalizeTerms(r.categories),
    keywords: normalizeTerms(r.keywords),
    min_grade: clampGrade(r.min_grade),
    max_price_cents: nonNegCents(r.max_price_cents),
    size: typeof r.size === "string" && r.size.trim() ? r.size.trim().slice(0, 40) : null,
    budget_cents: nonNegCents(r.budget_cents),
    visibility: r.visibility === "public" ? "public" : "private",
    expires_at: typeof r.expires_at === "string" && r.expires_at.trim() ? r.expires_at : null,
  };
}

/** A want must constrain SOMETHING — an all-wildcard want matches the whole
 *  catalogue and is meaningless as a demand signal. */
export function hasCriteria(w: WantInput): boolean {
  return (
    w.brands.length > 0 ||
    w.categories.length > 0 ||
    w.keywords.length > 0 ||
    w.min_grade != null ||
    w.max_price_cents != null
  );
}

export interface WantSearchFields {
  id: string;
  user_id: string;
  brands: string[];
  categories: string[];
  keywords: string[];
  min_grade: number | null;
  max_price_cents: number | null;
}

/** Project a want onto the alerts AlertSearch shape so the ONE matching engine
 *  (matchesSearch) applies. Pure. */
export function wantToSearch(w: WantSearchFields): AlertSearch {
  return {
    id: w.id,
    user_id: w.user_id,
    label: "want",
    brands: w.brands,
    categories: w.categories,
    keywords: w.keywords,
    min_grade: w.min_grade,
    max_price_cents: w.max_price_cents,
    last_matched_at: null,
  };
}

/** Re-export the shared predicate so demand-board callers use ONE engine. */
export { matchesSearch };
