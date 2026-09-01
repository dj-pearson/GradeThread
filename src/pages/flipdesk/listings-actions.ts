// US-2173 AC2: the listings mutation handlers, out of the page.
//
// These are the ~17 handlers behind every write on the highest-traffic surface
// in FlipDesk — inline edits, the bulk bar, the two undo paths, the CSV export.
// They were the last thing left inside a 2,600-line component, and they were the
// hardest part to test: none of them is pure. Each is validate -> optimistic
// cache write -> server call -> invalidate -> toast, with a rollback on the
// error path. There is no pure function hiding inside `bulkPriceDrop` waiting to
// be extracted; the ORDER of those steps IS the behaviour, and the order is what
// goes wrong.
//
// So this module does not make them pure. It makes their dependencies explicit.
// Everything the page used to supply by closure — the query client, the
// optimistic patcher, the current rows, the selection, the busy/progress
// setters, the six mutation hooks — arrives as one `ListingsActionDeps` object.
// A test builds that object out of fakes and calls a handler directly. Nothing
// renders.
//
// THE BODIES ARE VERBATIM. `makeListingsActions` destructures every dep back
// into the name the handler already used, so not one line inside a handler
// changed in the move. That is deliberate: this surface handles money, its
// failure modes are silent (a price the marketplace never saw, a listing that
// stayed live after "ended"), and a refactor that also rewrites the code cannot
// be reviewed as a move. The comments came with them — several record oversell
// hazards that are not obvious from the code.
//
// A NOTE ON IDENTITY. The factory is called on every render, exactly as the
// function declarations were re-created on every render before. Handler identity
// churns the same as it always did; nothing downstream memoizes on it.
//
// The pure decisions these handlers turn on already live elsewhere and are
// already tested: planListingDemote (listings-filter.ts), planStatusUndo /
// undoEntriesFor / describeSkipped (lib/bulk-status-undo.ts), chunkForBulkPrice
// / mergeBulkPriceResponses / undoableFrom (hooks/use-listing-lifecycle.ts).
// This module owns the IO and the reporting around them.

import type { QueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { toastError, toastWarning } from "@/lib/toast-error";
import { supabase } from "@/lib/supabase";
import { downloadItemsCsv } from "@/lib/items-csv";
import type { FilterQuery } from "@/lib/item-filter";
import { DRAFT_LIKE_STATUSES, type TabId } from "@/pages/flipdesk/inventory-tabs";
import {
  planListingDemote,
  type SoldFilter,
  type SortPreset,
} from "@/pages/flipdesk/listings-filter";
import { LISTINGS_COLUMN_LIST } from "@/pages/flipdesk/listings-columns";
import type { ListingPageResult } from "@/pages/flipdesk/listings-page-queries";
import {
  type BulkPriceResponse,
  type BulkEndResponse,
  type BulkReviseResponse,
  describeBulkRevise,
  chunkForBulkPrice,
  mergeBulkPriceResponses,
  undoableFrom,
} from "@/hooks/use-listing-lifecycle";
import {
  planStatusUndo,
  undoEntriesFor,
  describeSkipped,
  type StatusUndoEntry,
} from "@/lib/bulk-status-undo";
import { ITEM_STATUS_LABELS } from "@/lib/constants";
import type { ItemFullRow, ItemStatus, ListingInsert } from "@/types/database";

/** A mutation hook's call surface, narrowed to what a handler actually uses. */
interface MutationLike<TVars, TResult> {
  mutateAsync: (vars: TVars) => Promise<TResult>;
}

export interface ListingsActionDeps {
  /** For the post-write invalidate. Every handler ends with one. */
  qc: Pick<QueryClient, "invalidateQueries">;
  /**
   * The optimistic cache patcher. Returns its own rollback, which the error
   * path calls — that pairing is why it is injected whole rather than
   * reconstructed here.
   */
  patchRow: (id: string, patch: Partial<ItemFullRow>) => () => void;
  /** The rows currently on screen. Bulk handlers resolve ids against this. */
  items: ItemFullRow[];
  selected: Set<string>;
  setSelected: (next: Set<string>) => void;

  // The page criteria the CSV export replays against the server. Export pages
  // the RPC itself rather than exporting the rendered page, so it needs the
  // same criteria the page query used.
  tab: TabId;
  search: string;
  soldFilter: SoldFilter;
  filterQuery: FilterQuery;
  columnSort: { field: keyof ItemFullRow; dir: "asc" | "desc" } | null;
  sortPreset: SortPreset;

  setExporting: (v: boolean) => void;
  setBusy: (v: boolean) => void;
  setDropProgress: (v: { done: number; total: number } | null) => void;
  /**
   * A REF, not state: a mid-batch cancel has to be visible to the loop that is
   * already running, and a state update would never reach that closure.
   */
  dropCancelled: { current: boolean };
  bulkDropPct: string;
  setBulkPublishProgress: (v: { done: number; total: number } | null) => void;
  /** US-2404: live counter while a chunked bulk resubmit runs. */
  setBulkReviseProgress: (v: { done: number; total: number } | null) => void;
  setBulkDeleteProgress: (v: { done: number; total: number } | null) => void;
  setBulkDeleteOpen: (v: boolean) => void;
  setBulkStatusOpen: (v: boolean) => void;
  setBulkStatusValue: (v: "" | ItemStatus) => void;
  /** Only gates bulk publish; the eBay-specific paths check it themselves. */
  ebayConnection: unknown;

  updatePrice: MutationLike<
    { listingId: string; price: number },
    // US-9202: queued = live on an extension channel, waiting on the desktop.
    { pushed: boolean; queued?: boolean }
  >;
  endListingApi: MutationLike<
    { listingId: string },
    {
      already_ended?: boolean;
      ended_upstream?: boolean;
      queued?: boolean;
      note?: string;
    }
  >;
  bulkPrice: MutationLike<
    | { listingIds: string[]; dropPct: number }
    | { items: { listingId: string; price: number }[] },
    BulkPriceResponse
  >;
  bulkEnd: MutationLike<{ listingIds: string[] }, BulkEndResponse>;
  bulkRevise: MutationLike<
    { listingIds: string[]; onProgress?: (done: number, total: number) => void },
    BulkReviseResponse
  >;
  deleteItemApi: MutationLike<{ itemId: string }, unknown>;
  publishApi: MutationLike<{ itemId: string }, unknown>;
}

export function makeListingsActions(d: ListingsActionDeps) {
  const {
    qc,
    patchRow,
    items,
    selected,
    setSelected,
    tab,
    search,
    soldFilter,
    filterQuery,
    columnSort,
    sortPreset,
    setExporting,
    setBusy,
    setDropProgress,
    dropCancelled,
    bulkDropPct,
    setBulkPublishProgress,
    setBulkReviseProgress,
    setBulkDeleteProgress,
    setBulkDeleteOpen,
    setBulkStatusOpen,
    setBulkStatusValue,
    ebayConnection,
    updatePrice,
    endListingApi,
    bulkPrice,
    bulkEnd,
    bulkRevise,
    deleteItemApi,
    publishApi,
  } = d;

  // Keep the listing row consistent when an item moves back to a draft-like
  // status. A LOCAL (never-published) listing is demoted to draft + is_active
  // false; a genuinely LIVE eBay offer is left untouched and reported as `true`
  // so the caller can tell the seller to End it (we never silently pull a live
  // marketplace offer down). Returns true only when a live listing was left.
  async function syncListingForDraftStatus(it: ItemFullRow): Promise<boolean> {
    // US-2178: the decision lives in planListingDemote (pure, unit-tested); this
    // performs it. The rule that matters is that a LIVE marketplace offer is
    // never silently demoted — the caller reports it so the seller can End it.
    const plan = planListingDemote(it);
    if (plan.action === "none") return false;
    if (plan.action === "live") return true;
    const { error } = await supabase
      .from("listings")
      .update(plan.patch as never)
      .eq("id", it.listing_id as string);
    if (error) throw error;
    return false;
  }

  async function exportCsv() {
    setExporting(true);
    try {
      const PAGE = 500;
      const all: ItemFullRow[] = [];
      for (let offset = 0; ; offset += PAGE) {
        const { data, error } = await supabase.rpc("flipdesk_listing_page", {
          p_tab: tab,
          p_search: search,
          p_sold_filter: soldFilter,
          p_filter: filterQuery,
          p_column_sort: columnSort,
          p_sort_preset: sortPreset,
          p_ytd_start: new Date(new Date().getFullYear(), 0, 1).toISOString(),
          p_limit: PAGE,
          p_offset: offset,
          p_columns: LISTINGS_COLUMN_LIST,
        } as never);
        if (error) throw error;
        const batch = ((data ?? {}) as ListingPageResult).rows ?? [];
        all.push(...batch);
        // Stop on an EMPTY page, not a short one — the same rule paged-read.ts
        // spells out, for the same reason.
        if (batch.length === 0 || all.length >= (((data ?? {}) as ListingPageResult).total ?? 0)) {
          break;
        }
      }
      downloadItemsCsv(all);
    } catch (e) {
      toastError(e, "Export failed.");
    } finally {
      setExporting(false);
    }
  }
  async function bulkCreateDrafts() {
    if (selected.size === 0) return;
    setBusy(true);
    const errors: { message: string }[] = [];
    let created = 0;
    for (const id of selected) {
      const it = items.find((i) => i.id === id);
      if (!it) continue;
      try {
        const listing: ListingInsert = {
          inventory_item_id: it.id,
          platform: "ebay",
          // US-1077: bulk-created draft is GradeThread-originated.
          listing_origin: "gradethread",
          listing_status: "draft",
          listing_price: it.target_price ?? it.list_price ?? 0,
          listing_title: it.item_title,
          listing_description: it.item_description ?? null,
          is_active: false,
        };
        const { error: lErr } = await supabase
          .from("listings")
          .insert(listing as never);
        if (lErr) throw lErr;
        const { error: uErr } = await supabase
          .from("inventory_items")
          .update({ status: "drafted" } as never)
          .eq("id", it.id);
        if (uErr) throw uErr;
        created++;
      } catch (err) {
        errors.push({
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }
    setBusy(false);
    setSelected(new Set());
    await qc.invalidateQueries({ queryKey: ["items_full"] });
    if (errors.length === 0) {
      toast.success(`Created ${created} draft${created === 1 ? "" : "s"}.`);
    } else {
      toastWarning(
        errors[0],
        `Created ${created}, ${errors.length} failed.`,
        { duration: 12_000 },
      );
    }
  }

  // US-960: look up the item's most-recent sale id so the Shipped tab can write
  // fulfillment fields (tracking / delivered_at) to the right sale row. RLS on
  // `sales` scopes both the read and the write to the owner.
  async function latestSaleId(itemId: string): Promise<string | null> {
    const { data, error } = await supabase
      .from("sales")
      .select("id")
      .eq("inventory_item_id", itemId)
      .order("sale_date", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    return (data as { id: string } | null)?.id ?? null;
  }

  // US-960: edit/add the tracking number on a shipped item straight from the
  // Shipped tab. Optimistic local write-through, then persists to the sale.
  async function updateTracking(it: ItemFullRow, raw: string) {
    const next = raw.trim();
    if ((it.tracking ?? "") === next) return;
    const rollback = patchRow(it.id, { tracking: next || null });
    try {
      const saleId = await latestSaleId(it.id);
      if (!saleId) throw new Error("No sale record for this item.");
      const { error } = await supabase
        .from("sales")
        .update({ tracking_number: next || null } as never)
        .eq("id", saleId);
      if (error) throw error;
      // US-2372: reconcile with the server like the other three inline edits.
      // Without this the row kept whatever the optimistic patch put there until
      // the query went stale on its own — 15 minutes off the Active tab — so a
      // value the server had silently rejected would keep reading as saved.
      await qc.invalidateQueries({ queryKey: ["items_full"] });
      toast.success("Tracking updated.");
    } catch (err) {
      rollback();
      toastError(err, "Couldn't update tracking.");
    }
  }

  // US-960: one-click "Mark delivered" on the Shipped tab — stamps the sale's
  // delivered_at and moves the item to `completed` (terminal). Optimistic.
  async function markDelivered(it: ItemFullRow) {
    const now = new Date().toISOString();
    const rollback = patchRow(it.id, { delivered_at: now, status: "completed" });
    try {
      const saleId = await latestSaleId(it.id);
      if (saleId) {
        const { error } = await supabase
          .from("sales")
          .update({ delivered_at: now } as never)
          .eq("id", saleId);
        if (error) throw error;
      }
      const { error: iErr } = await supabase
        .from("inventory_items")
        .update({ status: "completed" } as never)
        .eq("id", it.id);
      if (iErr) throw iErr;
      await qc.invalidateQueries({ queryKey: ["items_full"] });
      toast.success("Marked delivered.");
    } catch (err) {
      rollback();
      toastError(err, "Couldn't mark delivered.");
    }
  }

  // Inline price edit on the Active tab. US-2163: ONE platform-agnostic call
  // that reprices the listing on whatever marketplace it actually lives on.
  //
  // The old shape branched on `ebayConnection` rather than the listing's
  // platform, so a Shopify/Etsy/Depop row hit eBay's endpoint, got a 409 (no
  // offer id), and fell through to a direct listings.update() — leaving a local
  // price no buyer could see. There is deliberately NO local-write fallback
  // here now: the server writes the row itself when (and only when) the
  // marketplace accepted the change, and reports `pushed:false` for a draft that
  // was never live. A failure is a failure.
  async function updateListingPrice(it: ItemFullRow, raw: string) {
    if (!it.listing_id) {
      toast.error("No listing record for this item.");
      return;
    }
    const next = Number(raw);
    if (!Number.isFinite(next) || next < 0) {
      toast.error("Enter a valid price.");
      return;
    }
    const rollback = patchRow(it.id, { list_price: next });
    try {
      const res = await updatePrice.mutateAsync({
        listingId: it.listing_id,
        price: next,
      });
      // US-2372: same reconcile. This one is money, and `pushed:false` means the
      // marketplace was never told — the row must come back from the server
      // rather than sitting on an optimistic number nobody else can see.
      await qc.invalidateQueries({ queryKey: ["items_full"] });
      // US-9202: an extension channel is queued, not pushed, and the seller
      // must not read "updated" for a marketplace that still shows the old price.
      if (res.queued) {
        toast.info(
          "Price saved. It reaches the marketplace when your desktop extension applies it; the row reads Stale until then.",
          { duration: 8_000 },
        );
      } else {
        toast.success(res.pushed ? "Price updated on the marketplace." : "Price updated.");
      }
    } catch (err) {
      rollback();
      toastError(err, "Price update failed.");
    }
  }

  // Generic inline edit of a single base inventory_items column, mirrored
  // optimistically into the items_full cache under its view alias and rolled
  // back on a server error (US-959). Writes hit the RLS-enforced client, so
  // they're tenant-scoped without an explicit user_id filter (same as every
  // other write on this page). NOT for list_price — that path syncs to eBay
  // via updateListingPrice.
  async function patchItemColumn(
    it: ItemFullRow,
    column: string,
    value: string | number | null,
    viewPatch: Partial<ItemFullRow>,
    label: string,
  ) {
    const rollback = patchRow(it.id, viewPatch);
    try {
      const { error } = await supabase
        .from("inventory_items")
        .update({ [column]: value } as never)
        .eq("id", it.id);
      if (error) throw error;
      await qc.invalidateQueries({ queryKey: ["items_full"] });
      toast.success(`${label} updated.`);
    } catch (err) {
      rollback();
      toastError(err, `Couldn't update ${label.toLowerCase()}.`);
    }
  }

  // Inline status change. Honors the explicit pick (forward or back, incl.
  // side-track statuses) — same direct write the mobile quick-edit sheet uses.
  async function updateItemStatus(it: ItemFullRow, next: ItemStatus) {
    if (next === it.status) return;
    await patchItemColumn(it, "status", next, { status: next }, "Status");
    // Keep the listing row in lockstep so a re-drafted item doesn't keep showing
    // as a live listing in the composer.
    if (DRAFT_LIKE_STATUSES.has(next)) {
      try {
        const liveSkipped = await syncListingForDraftStatus(it);
        if (liveSkipped) {
          toast.warning(
            "This item still has a live eBay listing — use End to take it down before drafting.",
            { duration: 10_000 },
          );
        }
        await qc.invalidateQueries({ queryKey: ["items_full"] });
      } catch (e) {
        toastError(e, "Status changed, but the listing didn't sync.");
      }
    }
  }

  // Inline numeric edit (cost → acquired_price, target → target_price). Empty
  // clears the field; otherwise must be a finite, non-negative number.
  async function updateItemMoney(
    it: ItemFullRow,
    raw: string,
    column: "acquired_price" | "target_price",
    viewKey: "purchase_price" | "target_price",
    label: string,
  ) {
    const trimmed = raw.trim();
    const value = trimmed === "" ? null : Number(trimmed);
    if (value != null && (!Number.isFinite(value) || value < 0)) {
      toast.error(`Enter a valid ${label.toLowerCase()}.`);
      return;
    }
    await patchItemColumn(it, column, value, { [viewKey]: value }, label);
  }

  // Inline notes edit (condition_notes on the base table, aliased as `notes`).
  async function updateItemNotes(it: ItemFullRow, raw: string) {
    const trimmed = raw.trim();
    const value = trimmed === "" ? null : trimmed;
    await patchItemColumn(it, "condition_notes", value, { notes: value }, "Notes");
  }

  // US-2162: end the listing on ITS OWN marketplace.
  //
  // This used to branch on `ebayConnection`, call eBay's endpoint for every row
  // whatever its platform, and on the resulting 409 write listing_status:'ended'
  // straight to the table — then tell the seller "Listing ended locally." while
  // the Shopify/Etsy/Depop listing stayed live and purchasable. That is the
  // oversell hazard, stated as a success message.
  //
  // The server now owns the whole decision: it marks the row ended only when the
  // listing is genuinely not live, and returns an error otherwise. So there is no
  // client-side fallback, and the toast reports what actually happened rather
  // than what we hoped happened.
  async function endListing(it: ItemFullRow) {
    if (!it.listing_id) {
      toast.error("No listing record for this item.");
      return;
    }
    try {
      const res = await endListingApi.mutateAsync({ listingId: it.listing_id });
      await qc.invalidateQueries({ queryKey: ["items_full"] });
      if (res.already_ended) {
        toast.success("That listing was already ended.");
      } else if (res.ended_upstream) {
        toast.success("Listing ended on the marketplace.");
      } else if (res.queued) {
        // US-2162: the marketplace has no end API, so this is QUEUED, not
        // ended. Saying "ended" here is the oversell lie in a different
        // costume, so it gets the long, explicit toast the still-live cases do.
        toast.warning(res.note ?? "Queued to be ended by the Lister extension.", {
          duration: 12_000,
        });
      } else {
        // Nothing was live to end — an unpublished draft, or the marketplace
        // reported it already gone. Distinct from the old "ended locally",
        // which meant "we couldn't reach the marketplace".
        toast.success(res.note ?? "Listing ended.");
      }
    } catch (err) {
      const e = err as Error & { status?: number; code?: string };
      if (e.code === "unsupported_platform" || e.code === "not_connected") {
        // The listing is STILL LIVE. Say so plainly and for long enough to read
        // — this is the case that costs a seller a double sale.
        toastError(e, "Could not end that listing.", {
          duration: 12_000,
        });
        return;
      }
      toastError(e, "End failed.");
    }
  }

  async function bulkPriceDrop() {
    if (selected.size === 0) return;
    const pct = Number(bulkDropPct);
    if (!Number.isFinite(pct) || pct <= 0) return;
    // US-2163: ONE request for the whole selection.
    //
    // This was a browser loop firing one HTTP call per selected listing — 200
    // listings meant 200 round trips under a blocking spinner with no cancel,
    // and it would have tripped the 30-req/60s rate limit on
    // /api/flipdesk/listings/* somewhere around the 30th row. Worse, its 409
    // branch wrote the local price for every non-eBay row and reported it as
    // "(N updated locally only)" — a number the marketplace never saw, which
    // then fed margin and ROI.
    //
    // The percentage is applied SERVER-side to each row's own current price, so
    // the result can't be computed from a stale render.
    const listingIds = Array.from(selected)
      .map((id) => items.find((i) => i.id === id)?.listing_id)
      .filter((id): id is string => Boolean(id));
    if (listingIds.length === 0) {
      toast.error("None of the selected items have a listing to reprice.");
      return;
    }

    // US-2163 (AC2 + AC5): send the selection in 25-listing chunks rather than
    // as one opaque request. A chunk boundary is the only place a long batch can
    // report progress or be stopped — one request for 100 listings is a black
    // box. It stays nothing like the old per-listing loop: 100 listings cost 4
    // requests, well inside the 30-per-60s limit that loop used to trip.
    const chunks = chunkForBulkPrice(listingIds);
    dropCancelled.current = false;
    setDropProgress({ done: 0, total: listingIds.length });
    setBusy(true);
    try {
      const parts: BulkPriceResponse[] = [];
      let cancelledAfter = 0;
      for (const chunk of chunks) {
        if (dropCancelled.current) break;
        parts.push(await bulkPrice.mutateAsync({ listingIds: chunk, dropPct: pct }));
        cancelledAfter += chunk.length;
        setDropProgress({ done: cancelledAfter, total: listingIds.length });
      }
      const res = mergeBulkPriceResponses(parts);
      const stopped = dropCancelled.current && res.total < listingIds.length;
      setSelected(new Set());

      // US-9202: rows on Poshmark/Mercari/Vinted took the price locally and are
      // waiting on the desktop extension; say so, because "repriced" would be
      // a claim about a marketplace that still shows the old number.
      if ((res.queued ?? 0) > 0) {
        toast.info(
          `${res.queued} of these are on extension channels and read Stale until your desktop extension applies the drop.`,
          { duration: 12_000 },
        );
      }

      if (stopped) {
        // Be exact about what a mid-batch cancel means: the chunks already sent
        // ARE repriced on their marketplaces. Implying a clean stop would send
        // the seller looking for prices that already moved. The undo offered
        // below still covers them.
        toast.warning(
          `Stopped after ${res.total} of ${listingIds.length}. ` +
            `Those ${res.total} are already repriced — use Undo to put them back.`,
          { duration: 15_000 },
        );
      }

      // US-2172: undo. A markdown across a large selection is the single most
      // expensive mis-click on this page, and it was irreversible — the seller's
      // only recovery was to reprice every listing by hand.
      //
      // Only rows that actually succeeded and have a known prior price are
      // offered: a row the marketplace refused never changed, so "undoing" it
      // would push a price nobody asked for.
      const undoable = undoableFrom(res);
      const undoAction = undoable.length > 0
        ? {
          label: "Undo",
          onClick: () => {
            void (async () => {
              try {
                const back = await bulkPrice.mutateAsync({ items: undoable });
                if (back.failed === 0) {
                  toast.success(
                    `Restored ${back.succeeded} price${back.succeeded === 1 ? "" : "s"}.`,
                  );
                } else {
                  // Undo is a real marketplace push and can fail too. Say which
                  // rows didn't come back rather than implying a clean revert.
                  const firstError = back.results.find((r) => !r.ok)?.error;
                  toast.warning(
                    `Restored ${back.succeeded}, ${back.failed} couldn't be put back.${
                      firstError ? ` First: ${firstError}` : ""
                    }`,
                    { duration: 12_000 },
                  );
                }
              } catch (err) {
                toastError(err, "Undo failed.");
              }
            })();
          },
        }
        : undefined;

      if (res.failed === 0) {
        toast.success(
          `Dropped price ${pct}% on ${res.succeeded} listing${
            res.succeeded === 1 ? "" : "s"
          }.`,
          // Longer than a default toast: undo is only useful while it's on screen.
          { duration: 15_000, action: undoAction },
        );
      } else {
        // Name the first real reason rather than a bare count — "3 failed" with
        // no cause is what sends a seller to support.
        const firstError = res.results.find((r) => !r.ok)?.error;
        toast.warning(
          `Dropped ${res.succeeded}, ${res.failed} failed.${
            firstError ? ` First: ${firstError}` : ""
          }`,
          { duration: 15_000, action: undoAction },
        );
      }
    } catch (err) {
      toastError(err, "Bulk reprice failed.");
    } finally {
      setBusy(false);
      setDropProgress(null);
      dropCancelled.current = false;
    }
  }

  // Sequential publish so we don't hammer eBay's rate limits and so
  // partial failures surface in a deterministic order. Each publish hits
  // the validate-then-push pipeline server-side, so blockers come back as
  // structured errors (the same the dialog surfaces single-item).
  async function bulkPublishToEbay() {
    if (selected.size === 0 || !ebayConnection) return;
    const ids = Array.from(selected);
    setBusy(true);
    setBulkPublishProgress({ done: 0, total: ids.length });
    const errors: { title: string; message: string }[] = [];
    let published = 0;
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i]!;
      const it = items.find((x) => x.id === id);
      if (!it) {
        setBulkPublishProgress({ done: i + 1, total: ids.length });
        continue;
      }
      try {
        await publishApi.mutateAsync({ itemId: id });
        published++;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        errors.push({ title: it.item_title, message: msg.split("\n")[0] ?? msg });
      }
      setBulkPublishProgress({ done: i + 1, total: ids.length });
    }
    setBusy(false);
    setBulkPublishProgress(null);
    setSelected(new Set());
    await qc.invalidateQueries({ queryKey: ["items_full"] });
    // US-2172 AC4: publishing is NOT undoable, and saying nothing is what makes
    // a seller look for an Undo that isn't there. Taking a live listing down is
    // End — a real marketplace operation that costs the insertion fee again on
    // relist — so the toast names it instead of offering a button that would
    // quietly do the wrong thing.
    const PUBLISH_IS_FINAL = "Publishing can't be undone — use End to take one down.";
    if (errors.length === 0) {
      toast.success(
        `Published ${published} listing${published === 1 ? "" : "s"} to eBay.`,
        { description: PUBLISH_IS_FINAL, duration: 10_000 },
      );
    } else if (published === 0) {
      toastError(
        errors[0],
        `Publish failed for all ${errors.length}. First: ${errors[0]?.title}`,
        { duration: 14_000 },
      );
    } else {
      toastWarning(
        errors[0],
        `Published ${published}, ${errors.length} failed. First: ${errors[0]?.title}. ${PUBLISH_IS_FINAL}`,
        { duration: 14_000 },
      );
    }
  }

  // Hard-delete every selected item (for clearing out drafts/dupes in bulk).
  // The server guards items with a live listing or any sale (409) — those are
  // reported and skipped, the rest still delete.
  async function bulkDeleteItems() {
    if (selected.size === 0) return;
    const ids = Array.from(selected);
    setBusy(true);
    setBulkDeleteProgress({ done: 0, total: ids.length });
    const errors: { title: string; message: string }[] = [];
    let deleted = 0;
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i]!;
      const it = items.find((x) => x.id === id);
      try {
        await deleteItemApi.mutateAsync({ itemId: id });
        deleted++;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        errors.push({
          title: it?.item_title ?? "item",
          message: msg.split("\n")[0] ?? msg,
        });
      }
      setBulkDeleteProgress({ done: i + 1, total: ids.length });
    }
    setBusy(false);
    setBulkDeleteProgress(null);
    setBulkDeleteOpen(false);
    setSelected(new Set());
    await qc.invalidateQueries({ queryKey: ["items_full"] });
    if (errors.length === 0) {
      // US-2172 AC4: the confirm dialog already says a delete is permanent; the
      // toast repeats it because that is the moment a seller looks for Undo.
      toast.success(`Deleted ${deleted} item${deleted === 1 ? "" : "s"}.`, {
        description: "Deletes are permanent — there's nothing to undo.",
        duration: 10_000,
      });
    } else if (deleted === 0) {
      toastError(
        errors[0],
        `Couldn't delete ${errors.length}. First: ${errors[0]?.title}`,
        { duration: 14_000 },
      );
    } else {
      toastWarning(
        errors[0],
        `Deleted ${deleted}, ${errors.length} skipped. First: ${errors[0]?.title}`,
        { duration: 14_000 },
      );
    }
  }

  // US-2162: end the whole selection in ONE request, each listing on its own
  // marketplace. Previously a per-listing loop whose 409 branch wrote
  // listing_status:'ended' locally and reported "(N ended locally only)" — those
  // listings stayed live. Past ~30 selected rows the loop also tripped the
  // 30-req/60s rate limit on /api/flipdesk/listings/*, so a large bulk end
  // silently half-finished.
  async function bulkEndListings() {
    if (selected.size === 0) return;
    const listingIds = Array.from(selected)
      .map((id) => items.find((i) => i.id === id)?.listing_id)
      .filter((id): id is string => Boolean(id));
    if (listingIds.length === 0) {
      toast.error("None of the selected items have a listing to end.");
      return;
    }

    setBusy(true);
    try {
      const res = await bulkEnd.mutateAsync({ listingIds });
      setSelected(new Set());
      // US-2162: a queued row is NOT ended — Poshmark/Mercari/Grailed have no
      // end API, so the Lister extension ends it in the seller's browser and
      // the listing stays buyable until then. Counting those as "ended" is the
      // oversell lie this story removed from the single-end path, so the bulk
      // summary must separate them too.
      const queued = res.results.filter((r) => r.ok && r.queued).length;
      const queuedNote = queued > 0
        ? ` ${queued} queued for the Lister extension — still live until it runs.`
        : "";
      if (res.failed === 0) {
        const ended = res.succeeded - queued;
        const msg = `Ended ${ended} listing${ended === 1 ? "" : "s"}.${queuedNote}`;
        if (queued > 0) toast.warning(msg, { duration: 14_000 });
        else toast.success(msg);
      } else {
        // A failed end means the listing is STILL LIVE — surface the reason and
        // leave it up long enough to act on.
        const firstError = res.results.find((r) => !r.ok)?.error;
        toast.warning(
          `Ended ${res.succeeded - queued}, ${res.failed} still live.${queuedNote}${
            firstError ? ` First: ${firstError}` : ""
          }`,
          { duration: 14_000 },
        );
      }
    } catch (err) {
      toastError(err, "Bulk end failed.");
    } finally {
      setBusy(false);
    }
  }
  // US-2404: resubmit a SELECTION of live eBay listings — re-assert the saved
  // item specifics, category, condition and photos against each live listing.
  // The bulk-bar equivalent of the composer's "Save & resubmit to eBay".
  //
  // It sends NO new field values. Everything pushed is what is already stored,
  // so a stale row on screen cannot send a wrong price or title.
  async function bulkResubmitToEbay() {
    if (selected.size === 0) return;
    const listingIds = Array.from(selected)
      .map((id) => items.find((i) => i.id === id)?.listing_id)
      .filter((id): id is string => Boolean(id));
    if (listingIds.length === 0) {
      toast.error("None of the selected items have a live listing to resubmit.");
      return;
    }

    setBusy(true);
    setBulkReviseProgress({ done: 0, total: listingIds.length });
    try {
      const res = await bulkRevise.mutateAsync({
        listingIds,
        onProgress: (done, total) => setBulkReviseProgress({ done, total }),
      });
      setSelected(new Set());
      // A refused row was NOT pushed and its local state is untouched, so the
      // summary must never round it up into the success count — a seller who
      // believes eBay has their edits stops checking.
      if (res.failed === 0) {
        toast.success(describeBulkRevise(res));
      } else {
        const firstError = res.results.find((r) => !r.ok)?.error;
        toast.warning(
          `${describeBulkRevise(res)}${firstError ? ` First: ${firstError}` : ""}`,
          { duration: 14_000 },
        );
      }
    } catch (err) {
      toastError(err, "Bulk resubmit failed.");
    } finally {
      setBulkReviseProgress(null);
      setBusy(false);
    }
  }


  // US-2172: put a bulk status change back.
  //
  // Deliberately re-reads the CURRENT state instead of trusting the cached
  // array the batch ran against: the seconds between the action and the undo
  // click are exactly where a sale lands, and restoring `active` over a sold
  // listing re-exposes stock that is already gone. planStatusUndo owns those
  // rules; this owns the IO and the reporting.
  async function undoBulkStatus(entries: StatusUndoEntry[]) {
    setBusy(true);
    try {
      const ids = entries.map((e) => e.itemId);
      const { data: fresh, error: readErr } = await supabase
        .from("items_full")
        .select("id, status, listing_status")
        .in("id", ids);
      if (readErr) throw readErr;
      const current = ((fresh ?? []) as unknown as Array<{
        id: string;
        status: string;
        listing_status: string | null;
      }>).map((r) => ({
        itemId: r.id,
        status: r.status,
        listingStatus: r.listing_status,
      }));

      const plan = planStatusUndo(entries, current);
      const failures: string[] = [];
      let restored = 0;
      for (const e of plan.restore) {
        const { error } = await supabase
          .from("inventory_items")
          .update({ status: e.previousStatus } as never)
          .eq("id", e.itemId);
        if (error) {
          failures.push(error.message);
          continue;
        }
        if (e.listing) {
          const { error: lErr } = await supabase
            .from("listings")
            .update({
              listing_status: e.listing.previousStatus,
              is_active: e.listing.previousIsActive,
            } as never)
            .eq("id", e.listing.id);
          // The status IS back even if the listing half failed, so this counts
          // as restored and the listing error is reported separately rather
          // than swallowed or double-counted.
          if (lErr) failures.push(lErr.message);
        }
        restored++;
      }
      await qc.invalidateQueries({ queryKey: ["items_full"] });

      const skippedLine = describeSkipped(plan.skipped);
      if (failures.length === 0 && plan.skipped.length === 0) {
        toast.success(`Put ${restored} item${restored === 1 ? "" : "s"} back.`);
      } else {
        toast.warning(
          `Put ${restored} back.` +
            (skippedLine ? ` Skipped: ${skippedLine}.` : "") +
            (failures.length > 0 ? ` ${failures.length} failed: ${failures[0]}` : ""),
          { duration: 14_000 },
        );
      }
    } catch (err) {
      toastError(err, "Undo failed.");
    } finally {
      setBusy(false);
    }
  }

  // US-1459: apply an arbitrary status to every selected item. Backward and
  // off-pipeline (archive / keeping / wearing) transitions are allowed — this is
  // the deliberate cleanup path. 'grading' is intentionally not offered (it's
  // owned by the submission+charge flow, same rule the board enforces).
  async function bulkSetStatus(next: ItemStatus) {
    if (selected.size === 0) return;
    setBusy(true);
    const errors: { message: string }[] = [];
    let done = 0;
    let liveSkipped = 0;
    const demote = DRAFT_LIKE_STATUSES.has(next);
    // US-2172: record where each row came from, so the batch is reversible.
    // Captured per row as it succeeds rather than up front, because a row whose
    // write failed never changed and must not be offered for undo.
    const undoEntries: StatusUndoEntry[] = [];
    for (const id of selected) {
      const it = items.find((i) => i.id === id);
      if (!it || it.status === next) continue;
      const { error } = await supabase
        .from("inventory_items")
        .update({ status: next } as never)
        .eq("id", it.id);
      if (error) {
        errors.push({ message: error.message });
        continue;
      }
      done++;
      const entry: StatusUndoEntry = {
        itemId: it.id,
        title: it.item_title,
        appliedStatus: next,
        previousStatus: it.status,
      };
      // Keep the listing row consistent so a re-drafted item stops showing as a
      // live listing (a genuinely live eBay offer is left alone + counted).
      if (demote) {
        try {
          const wasLive = await syncListingForDraftStatus(it);
          if (wasLive) liveSkipped++;
          // Only a row we actually REWROTE carries a listing half. A live eBay
          // offer was left alone, so undoing it must not touch the listing.
          undoEntries.push(
            wasLive || !it.listing_id
              ? entry
              : {
                ...entry,
                listing: {
                  id: it.listing_id,
                  previousStatus: it.listing_status,
                  // Derived, not read: is_active isn't in LISTINGS_COLUMNS, and
                  // a guessed boolean is worse than a rule. `active` is the only
                  // listing state that means live, so it is the only one that
                  // restores true — which is also what the demote wrote false.
                  previousIsActive: it.listing_status === "active",
                },
              },
          );
        } catch (e) {
          errors.push({ message: e instanceof Error ? e.message : String(e) });
        }
      } else {
        undoEntries.push(entry);
      }
    }
    setBusy(false);
    setSelected(new Set());
    setBulkStatusOpen(false);
    setBulkStatusValue("");
    await qc.invalidateQueries({ queryKey: ["items_full"] });

    // US-2172: undo. A bulk status change pushes nothing to a marketplace, so
    // there is no error to notice — the seller simply finds their selection in
    // the wrong stage with no record of where each row came from.
    const undoable = undoEntriesFor(undoEntries);
    const undoAction = undoable.length > 0
      ? { label: "Undo", onClick: () => void undoBulkStatus(undoable) }
      : undefined;

    if (errors.length === 0) {
      toast.success(
        `Set ${done} item${done === 1 ? "" : "s"} to ${ITEM_STATUS_LABELS[next]}.`,
        // Longer than a default toast: undo is only useful while it's on screen.
        { duration: 15_000, action: undoAction },
      );
    } else {
      toastWarning(
        errors[0],
        `Updated ${done}, ${errors.length} failed.`,
        { duration: 15_000, toastAction: undoAction },
      );
    }
    if (liveSkipped > 0) {
      toast.warning(
        `${liveSkipped} still live on eBay — use End to take ${
          liveSkipped === 1 ? "it" : "them"
        } down before drafting.`,
        { duration: 12_000 },
      );
    }
  }
  return {
    exportCsv,
    bulkCreateDrafts,
    updateTracking,
    markDelivered,
    updateListingPrice,
    patchItemColumn,
    updateItemStatus,
    updateItemMoney,
    updateItemNotes,
    endListing,
    bulkPriceDrop,
    bulkPublishToEbay,
    bulkDeleteItems,
    bulkEndListings,
    bulkResubmitToEbay,
    undoBulkStatus,
    bulkSetStatus,
  };
}

export type ListingsActions = ReturnType<typeof makeListingsActions>;
