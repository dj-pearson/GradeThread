// Pure helpers for the global FlipDesk full-text search surface (US-1050).
//
// The weighted tsvector columns + the `flipdesk_search()` RPC already exist in
// the DB (supabase/migrations/00016_full_text_search.sql, 00248). That RPC is
// SECURITY INVOKER, so RLS keeps every row to one the caller MAY read. That is
// not the same as the workspace on screen: the SELECT policies admit the
// caller's own rows OR any workspace they belong to (00451), so a seller who is
// also a member of a client's workspace gets both. The hook
// (src/hooks/use-flipdesk-search.ts) filters to the active owner before
// anything renders, the same defect 00833 fixed for Inventory.
//
// This module owns the query-building and result-mapping logic so it can be
// unit-tested without a database or React. The IO lives in
// flipdesk-search-fetch.ts and the React side in the hook.

import type { Database } from "@/types/database";

export type SearchScope = "all" | "items" | "listings" | "sales";
export type ResultType = "item" | "listing" | "sale";

/** A raw row as returned by the `flipdesk_search` RPC. */
export type SearchHit =
  Database["public"]["Functions"]["flipdesk_search"]["Returns"][number];

/** Named args passed straight to `supabase.rpc("flipdesk_search", ...)`. */
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

const RESULT_TYPE_LABELS: Record<ResultType, string> = {
  item: "Item",
  listing: "Listing",
  sale: "Sale",
};

const MIN_QUERY_LENGTH = 2;
export const DEFAULT_LIMIT = 50;
// Mirrors the RPC's own LEAST(p_limit, 200) clamp.
export const MAX_LIMIT = 200;

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
 * Deep link for a result. Listings and sales hang off an inventory item, and
 * `inventory_item_id` is NOT NULL on both (00002), so every hit has a parent
 * item page to open. A listing opens that page's Listing tab and a sale its
 * Money tab, since a buyer-name search is about the sale, not the garment.
 */
export function deepLinkForHit(hit: SearchHit): string {
  const base = "/dashboard/flipdesk/items";
  switch (hit.result_type) {
    case "listing":
      return `${base}/${hit.inventory_item_id}?tab=listing&listing=${hit.result_id}`;
    case "sale":
      return `${base}/${hit.inventory_item_id}?tab=money&sale=${hit.result_id}`;
    default:
      return `${base}/${hit.result_id}`;
  }
}

/** The item page's tab groups (item.tsx), in the order it shows them. */
export const ITEM_PAGE_TABS = ["details", "listing", "grade", "money"] as const;
export type ItemPageTab = (typeof ITEM_PAGE_TABS)[number];

/** A `?tab=` value the item page has, or null for anything else. */
export function itemTabFromParam(raw: string | null): ItemPageTab | null {
  return (ITEM_PAGE_TABS as readonly string[]).includes(raw ?? "")
    ? (raw as ItemPageTab)
    : null;
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

/** Stable identity of a request, for telling current data from stale data. */
export function searchArgsKey(args: SearchArgs | null): string {
  return args ? `${args.p_scope}|${args.p_limit}|${args.p_query}` : "";
}
