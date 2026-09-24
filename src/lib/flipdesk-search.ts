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

/**
 * Marks the Search page's field. The palette's "/" shortcut steps aside while
 * one is on screen, so "/" focuses the page's own search instead.
 */
export const SEARCH_PAGE_FIELD_ATTR = "data-search-page-field";

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

/**
 * D1: the RPC builds item and listing snippets as `title + " <em dash> " + body`
 * (00248), so a fragment from the start repeats the title the row already
 * shows. Drop that leading echo; a fragment from further in is left alone.
 */
export function stripTitleEcho(
  segments: SnippetSegment[],
  title: string | null | undefined,
): SnippetSegment[] {
  const plain = segments.map((s) => s.text).join("");
  const lead = plain.length - plain.trimStart().length;
  // U+2014 is the separator the SQL writes; spelled as an escape here so the
  // source stays ASCII.
  const prefix = `${(title ?? "").trim()} \u2014`;
  if (!plain.trimStart().startsWith(prefix.trimStart())) return segments;
  let cut = lead + prefix.trimStart().length;
  while (cut < plain.length && plain[cut] === " ") cut++;
  const out: SnippetSegment[] = [];
  for (const seg of segments) {
    if (cut >= seg.text.length) {
      cut -= seg.text.length;
      continue;
    }
    out.push({ ...seg, text: seg.text.slice(cut) });
    cut = 0;
  }
  return out;
}

/** How a hit was found, when it was not by the full-text RPC (D2). */
export type MatchKind = "sku" | "bin";

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
  /** D2: pinned by an exact SKU or bin read rather than ranked by the RPC. */
  matchKind?: MatchKind;
}

/** Map raw RPC rows to render-ready hits, preserving the RPC's rank order. */
export function mapHits(rows: SearchHit[] | null | undefined): MappedHit[] {
  return (rows ?? []).map((h) => ({
    ...h,
    key: `${h.result_type}-${h.result_id}`,
    link: deepLinkForHit(h),
    segments:
      h.result_type === "sale"
        ? parseSnippet(h.snippet)
        : stripTitleEcho(parseSnippet(h.snippet), h.title),
    typeLabel: RESULT_TYPE_LABELS[h.result_type] ?? h.result_type,
  }));
}

/** Stable identity of a request, for telling current data from stale data. */
export function searchArgsKey(args: SearchArgs | null): string {
  return args ? `${args.p_scope}|${args.p_limit}|${args.p_query}` : "";
}

/** "3m ago", "5h ago", "2d ago", or a short date past a week (F7). */
export function formatRecentAge(iso: string, now: number = Date.now()): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const mins = Math.max(0, Math.round((now - t) / 60_000));
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days <= 7) return `${days}d ago`;
  return new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/**
 * A remembered result count for display. A capped search is stored as its
 * limit + 1: 51 for the default page and 201 after "Show 200". So 51 reads
 * "50+", anything past 200 reads "200+", and every other number is exact (an
 * uncapped 120 from a Show 200 search is 120 results, not "50+").
 */
export function formatRecentCount(n: number | null): string | null {
  if (n == null) return null;
  if (n > MAX_LIMIT) return `${MAX_LIMIT}+ results`;
  if (n === DEFAULT_LIMIT + 1) return `${DEFAULT_LIMIT}+ results`;
  return `${n} result${n === 1 ? "" : "s"}`;
}

/** Which result_type each tab shows. */
export const SCOPE_RESULT_TYPE: Record<Exclude<SearchScope, "all">, ResultType> = {
  items: "item",
  listings: "listing",
  sales: "sale",
};

const TYPE_ORDER: ResultType[] = ["item", "listing", "sale"];
const TYPE_PLURAL: Record<ResultType, [string, string]> = {
  item: ["item", "items"],
  listing: ["listing", "listings"],
  sale: ["sale", "sales"],
};

export interface HitSummary {
  total: number;
  byType: Record<ResultType, number>;
  /** "12 results", or "50+ results, showing the best 50" when capped. */
  headline: string;
  /** "3 items, 2 listings" (+ " in the top 50" when capped), or "". */
  breakdown: string;
}

/**
 * U2: an honest count. The RPC stops at the limit, so a full page is "50+",
 * never "50", and the per-type split is only of what came back.
 */
export function summarizeHits(
  hits: readonly Pick<SearchHit, "result_type">[],
  capped: boolean,
  limit: number = DEFAULT_LIMIT,
): HitSummary {
  const byType: Record<ResultType, number> = { item: 0, listing: 0, sale: 0 };
  for (const h of hits) byType[h.result_type] += 1;
  const total = hits.length;
  const plural = `${total} result${total === 1 ? "" : "s"}`;
  // The cap is counted before the workspace filter and the exact-code de-dup,
  // so a capped answer can show fewer than `limit`. Only a full page may claim
  // "the best 50"; a short one says what it shows and that more may exist.
  const headline = !capped
    ? plural
    : total >= limit
      ? `${limit}+ results, showing the best ${limit}`
      : `${plural} shown, there may be more`;
  const parts = TYPE_ORDER.filter((t) => byType[t] > 0).map(
    (t) => `${byType[t]} ${TYPE_PLURAL[t][byType[t] === 1 ? 0 : 1]}`,
  );
  const breakdown = parts.length
    ? `${parts.join(", ")}${capped && total >= limit ? ` in the top ${limit}` : ""}`
    : "";
  return { total, byType, headline, breakdown };
}

/** One garment in the result list, however many of its records matched (D1). */
export interface HitGroup {
  itemId: string;
  /** The best-ranked hit for this garment; its link is where the row goes. */
  best: MappedHit;
  /** Every record type that matched, in item, listing, sale order. */
  matchedIn: ResultType[];
  hits: MappedHit[];
  /** The best sale hit, for a "Sold to <buyer>" line. */
  sale: MappedHit | null;
}

/**
 * D1: one row per garment. A single jacket used to take three rows (the item,
 * its eBay listing, its sale). Order follows the first appearance of each
 * garment, which is rank order, with pinned exact matches first.
 */
export function groupHitsByItem(hits: readonly MappedHit[]): HitGroup[] {
  const byItem = new Map<string, HitGroup>();
  for (const h of hits) {
    const id = h.inventory_item_id;
    let g = byItem.get(id);
    if (!g) {
      g = { itemId: id, best: h, matchedIn: [], hits: [], sale: null };
      byItem.set(id, g);
    }
    g.hits.push(h);
    if (!g.matchedIn.includes(h.result_type)) g.matchedIn.push(h.result_type);
    if (h.result_type === "sale" && !g.sale) g.sale = h;
  }
  for (const g of byItem.values()) {
    g.matchedIn.sort((a, b) => TYPE_ORDER.indexOf(a) - TYPE_ORDER.indexOf(b));
  }
  return [...byItem.values()];
}

export type QueryClass =
  | { kind: "text"; rpcQuery: string }
  | { kind: "code"; term: string; fields: MatchKind[]; rpcQuery: string };

const CODE_TOKEN = /^[A-Za-z0-9._-]+$/;

/**
 * D2: is this a warehouse lookup? `sku:J0042` and `bin:A3` say so outright; a
 * single token with a digit in it (J0042, A3, 2024-117) is treated as one too.
 * Codes go to an exact prefix read on item_number and location_bin as well as
 * the full-text RPC, because the RPC stems English and never searched bins.
 */
export function classifyQuery(raw: string): QueryClass {
  const q = normalizeQuery(raw);
  const prefixed = /^(sku|bin):\s*(\S+)$/i.exec(q);
  if (prefixed) {
    const term = prefixed[2]!;
    if (CODE_TOKEN.test(term)) {
      return {
        kind: "code",
        term,
        fields: [prefixed[1]!.toLowerCase() as MatchKind],
        rpcQuery: term,
      };
    }
    return { kind: "text", rpcQuery: term };
  }
  if (!q.includes(" ") && /\d/.test(q) && CODE_TOKEN.test(q)) {
    return { kind: "code", term: q, fields: ["sku", "bin"], rpcQuery: q };
  }
  return { kind: "text", rpcQuery: q };
}

/** Escape LIKE wildcards so a code matches literally before the trailing %. */
export function escapeLike(term: string): string {
  return term.replace(/[\\%_]/g, (c) => `\\${c}`);
}
