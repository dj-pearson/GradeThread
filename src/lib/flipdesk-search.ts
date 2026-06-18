// Pure helpers for the global FlipDesk full-text search surface (US-1050).
//
// The weighted tsvector columns + the `flipdesk_search()` RPC already exist in
// the DB (supabase/migrations/00016_full_text_search.sql). That RPC is
// SECURITY INVOKER, so RLS on the underlying tables scopes every result to the
// caller's own rows — the UI never has to filter for tenant isolation.
//
// This module owns the query-building and result-mapping logic so it can be
// unit-tested without a database or React. The page (search.tsx) is a thin
// shell over these functions.

export type SearchScope = "all" | "items" | "listings" | "sales";
export type ResultType = "item" | "listing" | "sale";

/** A raw row as returned by the `flipdesk_search` RPC. */
export interface SearchHit {
  result_type: string;
  result_id: string;
  inventory_item_id: string | null;
  title: string;
  snippet: string;
  rank: number;
}

/** Positional args passed straight to `supabase.rpc("flipdesk_search", …)`. */
export interface SearchArgs {
  p_query: string;
  p_scope: SearchScope;
  p_limit: number;
}

/** Tab order for the search surface — also the set of valid scopes. */
export const SEARCH_SCOPES: { id: SearchScope; label: string }[] = [
  { id: "all", label: "All" },
  { id: "items", label: "Items" },
  { id: "listings", label: "Listings" },
  { id: "sales", label: "Sales" },
];

export const RESULT_TYPE_LABELS: Record<string, string> = {
  item: "Item",
  listing: "Listing",
  sale: "Sale",
};

const MIN_QUERY_LENGTH = 2;
const DEFAULT_LIMIT = 50;
// Mirrors the RPC's own LEAST(p_limit, 200) clamp.
const MAX_LIMIT = 200;

/**
 * Collapse internal whitespace and trim. We intentionally preserve websearch
 * operators (`"quoted phrases"`, `-exclusion`, `AND`/`OR`) verbatim — the RPC
 * hands the string to `websearch_to_tsquery`, which parses them.
 */
export function normalizeQuery(raw: string): string {
  return raw.replace(/\s+/g, " ").trim();
}

export function isSearchableQuery(raw: string): boolean {
  return normalizeQuery(raw).length >= MIN_QUERY_LENGTH;
}

/** Coerce an arbitrary (e.g. URL-sourced) scope value to a valid scope. */
export function normalizeScope(raw: string | null | undefined): SearchScope {
  return SEARCH_SCOPES.some((s) => s.id === raw) ? (raw as SearchScope) : "all";
}

/**
 * Build the RPC argument object, or `null` when the query is too short to be
 * worth a round-trip. The limit is clamped to the RPC's accepted range so a
 * caller can't ask for an unbounded scan.
 */
export function buildSearchArgs(
  raw: string,
  scope: SearchScope = "all",
  limit: number = DEFAULT_LIMIT,
): SearchArgs | null {
  const q = normalizeQuery(raw);
  if (q.length < MIN_QUERY_LENGTH) return null;
  const requested = Math.floor(limit) || DEFAULT_LIMIT;
  const clamped = Math.max(1, Math.min(requested, MAX_LIMIT));
  return { p_query: q, p_scope: normalizeScope(scope), p_limit: clamped };
}

/**
 * Deep link for a result. Listings and sales hang off an inventory item, so we
 * jump to the item detail page when we know the parent; otherwise we fall back
 * to the relevant index surface.
 */
export function deepLinkForHit(hit: SearchHit): string {
  const itemPath = (id: string) => `/dashboard/flipdesk/items/${id}`;
  const itemId = hit.inventory_item_id;
  switch (hit.result_type) {
    case "item":
      return itemPath(hit.result_id);
    case "listing":
      return itemId ? itemPath(itemId) : "/dashboard/flipdesk/listings";
    case "sale":
      return itemId ? itemPath(itemId) : "/dashboard/flipdesk/reconciliation";
    default:
      return itemId ? itemPath(itemId) : "/dashboard/flipdesk/inventory";
  }
}

export interface SnippetSegment {
  text: string;
  highlight: boolean;
}

/**
 * Split a `ts_headline` snippet into highlighted / plain segments. We render
 * the text as React children (never `dangerouslySetInnerHTML`), so any raw
 * HTML in user content is escaped rather than executed.
 */
export function parseSnippet(snippet: string): SnippetSegment[] {
  if (!snippet) return [];
  return snippet
    .split(/(<mark>.*?<\/mark>)/g)
    .filter((p) => p.length > 0)
    .map((p) =>
      p.startsWith("<mark>") && p.endsWith("</mark>")
        ? { text: p.slice(6, -7), highlight: true }
        : { text: p, highlight: false },
    );
}

/** A search hit enriched with everything the UI needs to render one row. */
export interface MappedHit extends SearchHit {
  /** Stable React key (result_type + id). */
  key: string;
  /** In-app destination for this hit. */
  link: string;
  /** Snippet broken into highlighted / plain segments. */
  segments: SnippetSegment[];
  /** Human label for the result type ("Item", "Listing", "Sale"). */
  typeLabel: string;
}

/** Map raw RPC rows to render-ready hits, preserving the RPC's rank order. */
export function mapHits(rows: SearchHit[] | null | undefined): MappedHit[] {
  return (rows ?? []).map((h) => ({
    ...h,
    key: `${h.result_type}-${h.result_id}`,
    link: deepLinkForHit(h),
    segments: parseSnippet(h.snippet),
    typeLabel: RESULT_TYPE_LABELS[h.result_type] ?? h.result_type,
  }));
}
