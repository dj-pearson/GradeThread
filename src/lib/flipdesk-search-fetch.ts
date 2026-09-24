// The IO half of FlipDesk search. flipdesk-search.ts stays pure; this module
// talks to Supabase and is what the useFlipdeskSearch queryFn calls.
//
// Two reads, in order, inside ONE queryFn so nothing renders between them:
//
//   1. flipdesk_search, the SECURITY INVOKER RPC. RLS keeps it to rows the
//      caller may read, which includes every workspace they belong to.
//   2. items_full for the hit item ids, filtered to the ACTIVE owner. A hit
//      whose item is not in that answer is dropped. This is the client-side
//      stand-in for a server owner predicate (the 00833 pattern Inventory
//      already uses), and it doubles as the enrichment the rows render from.

import { supabase } from "@/lib/supabase";
import { fetchInChunks } from "@/lib/supabase-batch";
import { itemPhotoThumb } from "@/lib/images";
import { ITEM_LIST_SELECT, type ItemListRow } from "@/lib/item-list-columns";
import type { Database } from "@/types/database";
import {
  classifyQuery,
  deepLinkForHit,
  escapeLike,
  mapHits,
  type MappedHit,
  type MatchKind,
  type SearchArgs,
  type SearchHit,
} from "@/lib/flipdesk-search";

type SearchReturns = Database["public"]["Functions"]["flipdesk_search"]["Returns"];

/**
 * The RPC call, typed. The Database type does not satisfy supabase-js's
 * GenericSchema, so the client cannot infer Args/Returns from it; the shapes
 * come from Database["public"]["Functions"] here instead, in one place.
 */
export async function searchFlipdesk(
  args: SearchArgs,
  signal?: AbortSignal,
): Promise<SearchHit[]> {
  let builder = supabase.rpc("flipdesk_search", args as never);
  if (signal) builder = builder.abortSignal(signal);
  // supabase-js RESOLVES with { data: null, error } on a Postgres error. It
  // does not throw, so the error has to be read or an outage reads as "no
  // matches" (US-2517).
  const { data, error } = await builder;
  if (error) throw error;
  return (data as SearchReturns | null) ?? [];
}

/** items_full rows for these ids that belong to `ownerId`, keyed by id. */
export async function fetchOwnedItems(
  ids: readonly string[],
  ownerId: string,
  signal?: AbortSignal,
): Promise<Map<string, ItemListRow>> {
  const out = new Map<string, ItemListRow>();
  if (ids.length === 0) return out;
  const rows = await fetchInChunks<ItemListRow>(ids, (chunk) => {
    let q = supabase
      .from("items_full")
      .select(ITEM_LIST_SELECT)
      .in("id", chunk)
      .eq("user_id", ownerId);
    if (signal) q = q.abortSignal(signal);
    return q as unknown as PromiseLike<{
      data: unknown[] | null;
      error: { message: string } | null;
    }>;
  });
  for (const row of rows) out.set(row.id, row);
  return out;
}

/**
 * First photo (lowest sort_order) per item, as a thumbnail URL. Same rule as
 * the listings page covers. Best effort: a failed cover read leaves the row
 * without a picture rather than failing the search.
 */
export async function fetchCovers(
  ids: readonly string[],
  signal?: AbortSignal,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (ids.length === 0) return out;
  try {
    const rows = await fetchInChunks<{
      inventory_item_id: string | null;
      thumbnail_url: string | null;
      photo_url: string | null;
    }>(ids, (chunk) => {
      let q = supabase
        .from("item_photos")
        .select("inventory_item_id, thumbnail_url, photo_url, sort_order")
        .in("inventory_item_id", chunk)
        .order("sort_order", { ascending: true });
      if (signal) q = q.abortSignal(signal);
      return q as unknown as PromiseLike<{
        data: unknown[] | null;
        error: { message: string } | null;
      }>;
    });
    for (const row of rows) {
      if (!row.inventory_item_id || out.has(row.inventory_item_id)) continue;
      const url = itemPhotoThumb(row);
      if (url) out.set(row.inventory_item_id, url);
    }
  } catch {
    // Pictures are decoration here. The rows still carry SKU, bin and status.
  }
  return out;
}

const EXACT_LIMIT = 10;
const CODE_COLUMN: Record<MatchKind, "item_number" | "location_bin"> = {
  sku: "item_number",
  bin: "location_bin",
};

/**
 * D2: items whose SKU or bin starts with `term`, for this owner only. A SELECT
 * with .or() is fine on the self-hosted PostgREST (the US-1552 trap is .or() on
 * a mutation). `term` is already restricted to [A-Za-z0-9._-] by classifyQuery,
 * so the only LIKE metacharacter it can carry is `_`, escaped here.
 */
export async function fetchExactMatches(
  term: string,
  fields: MatchKind[],
  ownerId: string,
  signal?: AbortSignal,
): Promise<ItemListRow[]> {
  const pattern = `${escapeLike(term)}%`;
  let q = supabase
    .from("items_full")
    .select(ITEM_LIST_SELECT)
    .eq("user_id", ownerId)
    .or(fields.map((f) => `${CODE_COLUMN[f]}.ilike.${pattern}`).join(","))
    .limit(EXACT_LIMIT);
  if (signal) q = q.abortSignal(signal);
  const { data, error } = await q;
  if (error) throw error;
  return (data as unknown as ItemListRow[] | null) ?? [];
}

/** Exact equality first, then prefix; SKU before bin. */
function exactRank(row: ItemListRow, term: string, fields: MatchKind[]): [number, MatchKind] {
  const t = term.toLowerCase();
  const sku = (row.item_number ?? "").toLowerCase();
  const bin = (row.location_bin ?? "").toLowerCase();
  if (fields.includes("sku") && sku === t) return [0, "sku"];
  if (fields.includes("sku") && sku.startsWith(t)) return [1, "sku"];
  if (fields.includes("bin") && bin === t) return [2, "bin"];
  return [3, "bin"];
}

function exactHit(row: ItemListRow, kind: MatchKind): MappedHit {
  const base: SearchHit = {
    result_type: "item",
    result_id: row.id,
    inventory_item_id: row.id,
    title: row.item_title ?? "",
    snippet: "",
    rank: Number.POSITIVE_INFINITY,
  };
  return {
    ...base,
    key: `item-${row.id}`,
    link: deepLinkForHit(base),
    segments: [],
    typeLabel: "Item",
    matchKind: kind,
  };
}

export interface SearchResult {
  /** The args this data answers. Compared against the live input for staleness. */
  args: SearchArgs;
  /** Hits for the active owner only, in rank order. */
  hits: MappedHit[];
  /** The RPC returned more rows than `limit`: there are more than shown. */
  capped: boolean;
  /** items_full rows for every hit, all owned by the active owner. */
  items: Map<string, ItemListRow>;
  /** Cover thumbnail per item id, when covers were asked for. */
  covers: Map<string, string>;
  /** D2: the one item whose SKU equals the query exactly, if exactly one. */
  exactSkuId: string | null;
}

export interface RunSearchOptions {
  args: SearchArgs;
  /** How many rows the caller shows. args.p_limit is one more, to detect a cap. */
  limit: number;
  ownerId: string;
  withCovers?: boolean;
  /** D2: also pin exact SKU/bin prefix matches for a code-shaped query. */
  withExact?: boolean;
  signal?: AbortSignal;
}

export async function runFlipdeskSearch(
  opts: RunSearchOptions,
): Promise<SearchResult> {
  const { args, limit, ownerId, signal } = opts;
  const cls = classifyQuery(args.p_query);
  const code = opts.withExact && cls.kind === "code" ? cls : null;
  const [raw, exactRows] = await Promise.all([
    // sku:/bin: are for the exact read; the RPC gets the bare code.
    searchFlipdesk({ ...args, p_query: cls.rpcQuery }, signal),
    code
      ? fetchExactMatches(code.term, code.fields, ownerId, signal)
      : Promise.resolve([] as ItemListRow[]),
  ]);
  // The cap is a fact about the RPC's answer, not about how many survive the
  // owner filter below. At MAX_LIMIT the request could not ask for one extra
  // row, so a full page is the most it can say.
  const capped =
    raw.length > limit || (args.p_limit <= limit && raw.length >= args.p_limit);

  const exact = code
    ? exactRows
        .map((row) => ({ row, r: exactRank(row, code.term, code.fields) }))
        .sort((a, b) => a.r[0] - b.r[0])
    : [];
  const exactIds = new Set(exact.map((e) => e.row.id));
  const ids = [...new Set(raw.map((h) => h.inventory_item_id))].filter(
    (id) => !exactIds.has(id),
  );
  // In parallel for speed. Covers for a dropped item are discarded below, never
  // rendered.
  const [items, allCovers] = await Promise.all([
    fetchOwnedItems(ids, ownerId, signal),
    opts.withCovers
      ? fetchCovers([...exactIds, ...ids], signal)
      : Promise.resolve(new Map<string, string>()),
  ]);
  // Exact rows were read with the owner filter already.
  for (const { row } of exact) items.set(row.id, row);

  const ftsHits = mapHits(
    raw.filter(
      (h) =>
        items.has(h.inventory_item_id) &&
        // The pinned row already stands for this item.
        !(h.result_type === "item" && exactIds.has(h.result_id)),
    ),
  );
  const hits = [...exact.map((e) => exactHit(e.row, e.r[1])), ...ftsHits].slice(
    0,
    limit,
  );
  const skuEqual = exact.filter((e) => e.r[0] === 0);
  const covers = new Map([...allCovers].filter(([id]) => items.has(id)));
  return {
    args,
    hits,
    capped,
    items,
    covers,
    exactSkuId: skuEqual.length === 1 ? skuEqual[0]!.row.id : null,
  };
}
