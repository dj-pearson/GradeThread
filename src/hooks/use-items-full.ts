import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import { edgeFetch } from "@/lib/edge-fetch";
import { useAuthStore } from "@/stores/auth-store";
import type { ItemFullRow } from "@/types/database";
import {
  ITEM_LIST_SELECT,
  type ItemListRow,
} from "@/lib/item-list-columns";

// `items_full` is the heaviest read in FlipDesk — the full denormalized
// inventory view. Half a dozen routes (pipeline, prep, item, overview,
// composer, reconciliation, eBay SKU match) all need the same rows, so they
// MUST share one query key AND one queryFn. Same key + divergent queryFns is a
// foot-gun in React Query: whichever consumer mounts first wins, and every
// other route silently inherits its ordering and freshness — which previously
// meant the page-level `.order(...)` and `staleTime` overrides were redundant
// and non-deterministic. This hook is the single source of truth; import it
// instead of re-declaring the query. All mutations already invalidate the
// `["items_full"]` prefix, so every consumer refreshes together.

// Canonical order: newest first. Consumers that need a different order
// (e.g. prep wants oldest-first) sort client-side off this one cached array.
// Deliberate cache tuning for a large payload (US-419):
//  - staleTime 15 min: mutations invalidate `["items_full"]` explicitly, so we
//    don't need aggressive background refetching to stay correct.
//  - gcTime 30 min: keep the big array warm across route hops (Pipeline ->
//    Composer -> Item etc.) so navigating back doesn't refetch the whole view.
export const ITEMS_FULL_STALE_TIME = 15 * 60 * 1000;
export const ITEMS_FULL_GC_TIME = 30 * 60 * 1000;

export function itemsFullQueryKey(userId: string | undefined) {
  return ["items_full", userId] as const;
}

// Distinct key from the full read. Same-key-different-queryFn is the foot-gun
// called out above (first mounter wins), so the projected read gets its own
// key. It still sits UNDER the ["items_full"] prefix, so every existing
// `invalidateQueries({ queryKey: ["items_full"] })` refreshes both.
export function itemsListQueryKey(userId: string | undefined) {
  return ["items_full", "list", userId] as const;
}

// US-2188: page through the read instead of issuing one unbounded request.
//
// PostgREST caps a response at its `db-max-rows` and says so ONLY in the
// Content-Range header — supabase-js surfaces no error, so a seller past the cap
// just gets a short array. Every FlipDesk surface would then be quietly wrong in
// the same direction: items missing from the kanban, from the prep queue, and
// from reconciliation matching, with nothing anywhere reporting a problem. The
// rest of the app already treats this as real (bulk-pricing.tsx and grid.tsx
// both chunk with .range()); this was the one heavy read that did not.
//
// Both reads page identically and share the canonical newest-first order, so
// the consumers that group/filter/sort client-side see the same rows in the
// same sequence either way. They differ only in the column list.
const ITEMS_FULL_PAGE = 1000;

async function fetchItemsPaged<T>(columns: string): Promise<T[]> {
  // `.bind(supabase)` is LOAD-BEARING. supabase-js implements `from()` as
  // `return this.rest.from(relation)`, so the method only works while it is
  // still attached to the client. Hoisting it into a bare local
  // (`const from = supabase.from`) drops `this` and throws
  // "Cannot read properties of undefined (reading 'rest')" on the FIRST page
  // — before any network call. React Query swallows that into an errored
  // query, every items_full consumer falls back to its `= []` default, and
  // the app looks like a seller with no inventory: an empty items table and
  // "Item not found." on every item/draft detail page.
  //
  // The pre-paging code called it as `(supabase.from as unknown as T)(...)`,
  // which reads like the same cast but is not: parenthesising a member
  // expression preserves the `this` binding, so that form worked. Binding
  // explicitly removes the trap instead of re-hiding it.
  const from = (
    supabase.from as unknown as (
      name: "items_full",
    ) => {
      select: (cols: string) => {
        order: (
          col: string,
          opts?: { ascending?: boolean },
        ) => {
          range: (
            start: number,
            end: number,
          ) => Promise<{ data: T[] | null; error: Error | null }>;
        };
      };
    }
  ).bind(supabase);

  const all: T[] = [];
  for (let start = 0; ; start += ITEMS_FULL_PAGE) {
    const { data, error } = await from("items_full")
      .select(columns)
      .order("created_at", { ascending: false })
      .range(start, start + ITEMS_FULL_PAGE - 1);
    if (error) throw error;
    const batch = data ?? [];
    all.push(...batch);
    // A short page means the end. A full page might be the last one, so we
    // pay one extra empty request rather than guess — stopping early here is
    // the same silent truncation this exists to remove.
    if (batch.length < ITEMS_FULL_PAGE) break;
  }
  return all;
}

/**
 * The FULL 61-column read: every row, every column.
 *
 * US-2188 left this with NO CONSUMERS, deliberately, and that is the state to
 * keep it in. The surfaces that used to call it now take one of the two reads
 * that bound their cost — {@link useItemsList} for anything that lists, groups,
 * filters or charts, {@link useItemFull} for a canvas rendering one item. The
 * CSV exporters run off the listings page's own LISTINGS_COLUMNS query, which
 * already carries the wide columns they serialise.
 *
 * It stays exported as the honest escape hatch for a future surface that
 * genuinely needs every column of every row — but reach for it only after
 * establishing that neither of the other two will do, because this is exactly
 * the unbounded shape US-2188 removed.
 */
export function useItemsFull() {
  const user = useAuthStore((s) => s.user);
  return useQuery({
    queryKey: itemsFullQueryKey(user?.id),
    enabled: !!user,
    staleTime: ITEMS_FULL_STALE_TIME,
    gcTime: ITEMS_FULL_GC_TIME,
    queryFn: () => fetchItemsPaged<ItemFullRow>("*"),
  });
}

/**
 * The projected LIST read (US-2188): same rows, same canonical newest-first
 * order, same paging, minus the four detail-only columns no list surface
 * reads. Prefer this everywhere that groups, filters, counts or charts items.
 */
export function useItemsList() {
  const user = useAuthStore((s) => s.user);
  return useQuery({
    queryKey: itemsListQueryKey(user?.id),
    enabled: !!user,
    staleTime: ITEMS_FULL_STALE_TIME,
    gcTime: ITEMS_FULL_GC_TIME,
    queryFn: () => fetchItemsPaged<ItemListRow>(ITEM_LIST_SELECT),
  });
}

export function itemFullQueryKey(
  userId: string | undefined,
  itemId: string | undefined,
) {
  return ["items_full", "detail", userId, itemId] as const;
}

/**
 * The FULL row for ONE item (US-2188). This is what the detail canvases want:
 * the composer and the item page each render exactly one item, and pulling the
 * whole catalog to `.find()` it was the single most wasteful read in FlipDesk.
 *
 * `null` data means the row does not exist (or is not the caller's) — an
 * errored query is a different thing and surfaces as `isError`, so the callers
 * can keep telling "not found" apart from "couldn't load".
 *
 * Keyed under the ["items_full"] prefix like the other two, so every existing
 * `invalidateQueries({ queryKey: ["items_full"] })` refreshes it too.
 */
export function useItemFull(itemId: string | undefined) {
  const user = useAuthStore((s) => s.user);
  return useQuery({
    queryKey: itemFullQueryKey(user?.id, itemId),
    enabled: !!user && !!itemId,
    staleTime: ITEMS_FULL_STALE_TIME,
    gcTime: ITEMS_FULL_GC_TIME,
    queryFn: async (): Promise<ItemFullRow | null> => {
      const { data, error } = await (
        supabase.from as unknown as (
          name: "items_full",
        ) => {
          select: (cols: string) => {
            eq: (
              col: string,
              val: string,
            ) => {
              maybeSingle: () => Promise<{
                data: ItemFullRow | null;
                error: Error | null;
              }>;
            };
          };
        }
      ).bind(supabase)("items_full")
        .select("*")
        .eq("id", itemId as string)
        .maybeSingle();
      if (error) throw error;
      return data ?? null;
    },
  });
}

// Hard-delete a whole inventory item (for removing a DUPLICATE) — distinct from
// End (withdraws the eBay offer, keeps the draft) and Archive (a status change).
// The server refuses items with a live listing or any sale (see the
// DELETE /api/flipdesk/listings/item/:id guards) and returns a 409 with a
// `code` the caller surfaces. On success every items_full consumer refreshes.
export interface DeleteItemError extends Error {
  status?: number;
  code?: string;
}

export function useDeleteItem() {
  const qc = useQueryClient();
  return useMutation<{ ok: true; item_id: string }, DeleteItemError, { itemId: string }>({
    mutationFn: async ({ itemId }) => {
      const res = await edgeFetch(
        `/api/flipdesk/listings/item/${encodeURIComponent(itemId)}`,
        { method: "DELETE" },
      );
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        const err: DeleteItemError = new Error(json.error || "Delete failed.");
        err.status = res.status;
        err.code = json.code;
        throw err;
      }
      return json as { ok: true; item_id: string };
    },
    onSuccess: () => {
      // Prefix-invalidate ["items_full"] — this also covers the tab status counts
      // (["items_full","status_counts",…]) so every consumer refreshes together.
      qc.invalidateQueries({ queryKey: ["items_full"] });
    },
  });
}
