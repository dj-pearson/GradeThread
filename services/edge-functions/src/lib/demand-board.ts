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

// ── seller demand aggregate (PII-safe) ──────────────────────────────────────

export interface PublicWantRow {
  brands: string[];
  categories: string[];
  min_grade: number | null;
  max_price_cents: number | null;
}

export interface DemandFacet {
  term: string;
  wantCount: number;
  /** Highest min-grade any want in this facet asked for (a quality signal). */
  topMinGrade: number | null;
  /** Highest max-price ceiling any want here set, in cents (a budget signal). */
  topMaxPriceCents: number | null;
}

export interface DemandAggregate {
  brands: DemandFacet[];
  categories: DemandFacet[];
  totalWants: number;
}

/**
 * Aggregate PUBLIC active wants into a PII-safe demand signal for sellers: per
 * brand + per category, how many buyers want it (a want may contribute to
 * several facets) and the strongest grade/budget signal. PURE — no buyer identity
 * ever appears. Facets are ranked by demand and capped.
 */
export function aggregatePublicWants(wants: PublicWantRow[], limit = 25): DemandAggregate {
  const brand = new Map<string, DemandFacet>();
  const cat = new Map<string, DemandFacet>();

  const bump = (m: Map<string, DemandFacet>, term: string, w: PublicWantRow) => {
    const key = term.trim();
    if (!key) return;
    const f = m.get(key.toLowerCase()) ?? { term: key, wantCount: 0, topMinGrade: null, topMaxPriceCents: null };
    f.wantCount++;
    if (w.min_grade != null) f.topMinGrade = Math.max(f.topMinGrade ?? 0, w.min_grade);
    if (w.max_price_cents != null) f.topMaxPriceCents = Math.max(f.topMaxPriceCents ?? 0, w.max_price_cents);
    m.set(key.toLowerCase(), f);
  };

  for (const w of wants) {
    for (const b of w.brands) bump(brand, b, w);
    for (const cName of w.categories) bump(cat, cName, w);
  }

  const rank = (m: Map<string, DemandFacet>) =>
    [...m.values()].sort((a, b) => b.wantCount - a.wantCount).slice(0, limit);

  return { brands: rank(brand), categories: rank(cat), totalWants: wants.length };
}
