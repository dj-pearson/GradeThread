import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  keepPreviousData,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { toast } from "sonner";
import { toastWarning } from "@/lib/toast-error";
import {
  Grid3x3,
  Search,
  ChevronLeft,
  ChevronRight,
  Check,
  X,
  Loader2,
  Undo2,
} from "lucide-react";
import { SearchInput } from "@/components/search-input";
import { TableLoadingSkeleton } from "@/components/ui/skeletons";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorState } from "@/components/ui/error-state";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { changesFromItemDiff } from "@/lib/title-sync";
import { buildTitleSyncPatch } from "@/lib/title-sync-patch";
import { Button } from "@/components/ui/button";
import { supabase } from "@/lib/supabase";
import { useNavigationGuard } from "@/hooks/use-navigation-guard";
import { UnsavedChangesDialog } from "@/components/unsaved-changes-dialog";
import { useAuthStore } from "@/stores/auth-store";
import { cn } from "@/lib/utils";
import { useUrlPageState, useUrlParamState, useUrlSearchInput } from "@/hooks/use-url-param-state";
import { SortMenu } from "@/components/flipdesk/sort-menu";
import {
  columnSortForMode,
  resolveSortOptionForMode,
  sortOptionsForMode,
} from "@/pages/flipdesk/inventory-sort";
import { InventoryViewSwitcher } from "@/components/flipdesk/inventory-view-switcher";
import type { ItemFullRow } from "@/types/database";
import { GridSheet } from "./grid-sheet";
import { GRID_COLS as COLS, COMMON_ASPECTS, DEFAULT_GRID_KEYS, aspectColumn, cellLock, isListingColumn, validateGridValue, type GridCol, type GridRow } from "./grid-columns";
import { useGridListings, useSaveGridListing } from "./use-grid-listings";
import { GridReview } from "./grid-review";

const PAGE_SIZE = 100;

// Only the columns this spreadsheet renders/edits — the items_full view is wide
// (jsonb comps/measurements, per-row photo subqueries) and loading all of it
// per page is wasteful (US-404). Selecting a slim projection lets Postgres
// prune the unused view columns from the plan.
const GRID_COLUMNS =
  "id,item_number,item_title,brand,style,size,purchase_price,target_price," +
  "sourced_by,notes,status,color,material,location_bin,floor_price,listing_id,listing_platform,listing_status";

// Minimal typed view of the PostgREST builder for the (untyped) items_full
// view — supports the count + search + range chain this page needs.
interface ItemsFullPageBuilder {
  or: (filter: string) => ItemsFullPageBuilder;
  order: (
    col: string,
    opts?: { ascending?: boolean; nullsFirst?: boolean },
  ) => ItemsFullPageBuilder;
  range: (
    from: number,
    to: number,
  ) => Promise<{
    data: ItemFullRow[] | null;
    error: Error | null;
    count: number | null;
  }>;
}

function itemsFullPage() {
  return (
    supabase.from as unknown as (name: "items_full") => {
      select: (
        cols: string,
        opts: { count: "exact" },
      ) => ItemsFullPageBuilder;
    }
  )("items_full");
}

// PostgREST `.or()` is a comma/parenthesis-delimited grammar, so strip the
// characters that would break the filter out of the user's search term.
function sanitizeSearch(raw: string): string {
  return raw.trim().replace(/[,():*\\%]/g, " ").replace(/\s+/g, " ").trim();
}

type Staged = Map<string, Record<string, string>>; // itemId → { field: value }
interface EditLog {
  itemId: string;
  field: string;
  prev: string | undefined;
}

export function FlipdeskGridPage() {
  const user = useAuthStore((s) => s.user);
  const qc = useQueryClient();
  const ownerId = useAuthStore((s) => s.activeWorkspaceOwnerId) ?? user?.id;
  const saveListing = useSaveGridListing();
  const confirm = useConfirm();
  // US-958: search lives in the URL (`?q=`) so it carries across view-mode
  // switches (shared with the table + kanban views).
  // `draft` drives the box (instant), `value` drives the filtering (on a
  // pause). Swapping the two reintroduces the dropped-characters bug.
  const {
    value: search,
    draft: searchDraft,
    setDraft: setSearch,
  } = useUrlSearchInput("q", "");
  // US-3122: the spreadsheet had no sort at all — it was created_at desc and
  // nothing else. Same `?sort=` param the table uses, so an order survives a
  // view switch; the menu is the All tab's, since the grid has no tabs.
  const [sortParam, setSortParam] = useUrlParamState("sort", "default");
  const sortOption = resolveSortOptionForMode(sortParam, "grid");
  const sortColumn = columnSortForMode(sortOption, "grid");
  // US-3207: same as the table — the page lives in `?page=` so it survives the
  // round trip through an item, and so switching view mode does not silently
  // move the seller back to the top of a list they were halfway down.
  const [page, setPage] = useUrlPageState();
  const [staged, setStaged] = useState<Staged>(new Map());
  const [history, setHistory] = useState<EditLog[]>([]);
  const [saving, setSaving] = useState(false);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [failures, setFailures] = useState<{ itemId: string; title: string; message: string }[]>([]);
  const [progress, setProgress] = useState(0);
  const originals = useRef(new Map<string, GridRow>());
  const [columnKeys, setColumnKeys] = useState<string[]>(() => {
    try {
      const saved: unknown = JSON.parse(localStorage.getItem("flipdesk-grid-columns-v1") ?? "null");
      if (Array.isArray(saved) && saved.length && saved.every(key => typeof key === "string")) return saved;
    } catch { /* Storage may be unavailable. Defaults still work. */ }
    return DEFAULT_GRID_KEYS;
  });
  function chooseColumns(keys: string[]) {
    setColumnKeys(keys);
    try { localStorage.setItem("flipdesk-grid-columns-v1", JSON.stringify(keys)); } catch { /* Device storage is optional. */ }
  }

  // US-3207: skips its FIRST run, so an inbound `?page=3` is not thrown away on
  // the render that was meant to honour it. A real search or sort change after
  // that still resets — page 3 of a re-sorted list is an arbitrary slice of an
  // answer the seller just asked to see from the top.
  const criteriaMountedRef = useRef(false);
  useEffect(() => {
    if (!criteriaMountedRef.current) {
      criteriaMountedRef.current = true;
      return;
    }
    setPage(1);
  }, [search, sortParam, setPage]);

  // US-404: server-side pagination. Only the current page (PAGE_SIZE rows) of a
  // slim column projection is ever loaded, with a grouped exact count for the
  // total — so a 5k+ item account stays responsive instead of transferring the
  // entire wide view on every render. Search is pushed to the server too.
  const { data, isLoading, isError, isPlaceholderData, refetch, isFetching } =
    useQuery({
    queryKey: [
      "items_full",
      "grid",
      ownerId,
      page,
      search.trim(),
      sortColumn.field,
      sortColumn.dir,
    ],
    enabled: !!user,
    // 15-min freshness — mutations invalidate items_full explicitly (US-735).
    staleTime: 15 * 60 * 1000,
    placeholderData: keepPreviousData,
    queryFn: async (): Promise<{ rows: ItemFullRow[]; total: number }> => {
      const q = sanitizeSearch(search);
      const from = (page - 1) * PAGE_SIZE;
      let builder = itemsFullPage().select(GRID_COLUMNS, { count: "exact" });
      if (q) {
        builder = builder.or(
          `item_title.ilike.*${q}*,brand.ilike.*${q}*,` +
            `item_number.ilike.*${q}*,style.ilike.*${q}*`,
        );
      }
      const {
        data: rows,
        error,
        count,
      } = await builder
        // NULLS LAST in BOTH directions, which is what flipdesk_listing_page
        // does for the table and what the client comparator does for the
        // Kanban. Postgres' own default puts NULLs FIRST on a descending sort,
        // so leaving this off would order the same items differently in two
        // views of the same list.
        .order(sortColumn.field, {
          ascending: sortColumn.dir === "asc",
          nullsFirst: false,
        })
        .range(from, from + PAGE_SIZE - 1);
      if (error) throw error;
      return { rows: rows ?? [], total: count ?? 0 };
    },
  });

  const inventoryRows = data?.rows ?? [];
  const listingQuery = useGridListings(inventoryRows, ownerId);
  const pageRows: GridRow[] = inventoryRows.map(row => ({
    ...row,
    listing: row.listing_id ? listingQuery.data?.get(row.listing_id) : undefined,
    listingError: row.listing_id && !listingQuery.data?.has(row.listing_id)
      ? (listingQuery.isLoading ? "Loading listing fields..." : "Listing fields could not load. Reload to try again.") : undefined,
  }));
  const aspectNames = [...new Set([...COMMON_ASPECTS, ...pageRows.flatMap(row => Object.keys(row.listing?.item_specifics_override ?? {})), ...columnKeys.filter(key => key.startsWith("aspect.")).map(key => key.slice(7))])];
  const allColumns = [...COLS, ...aspectNames.map(aspectColumn)];
  const selectedColumns = allColumns.filter(col => columnKeys.includes(col.key));
  const visibleColumns = selectedColumns.length ? selectedColumns : COLS.filter(col => DEFAULT_GRID_KEYS.includes(col.key));
  const total = data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const pageStart = (safePage - 1) * PAGE_SIZE;

  // Clamp the page when a search shrinks the result set below the current page.
  //
  // US-3207: gated on the query having resolved. `total` reads `data?.total ??
  // 0`, so before the first fetch lands totalPages is 1 and an ungated clamp
  // rewrites a restored `?page=3` to 1 while the request for page 3 is still in
  // flight.
  useEffect(() => {
    if (!data) return;
    if (page > totalPages) setPage(totalPages);
  }, [page, totalPages, data, setPage]);

  // See US-3243. Declared below dirtyCount.
  const dirtyCount = useMemo(() => {
    let n = 0;
    for (const rec of staged.values()) n += Object.keys(rec).length;
    return n;
  }, [staged]);

  // US-3243. Same shape as the bulk grid: these cell edits live only in
  // component state until Save all writes them, and the page already confirmed
  // before an explicit Discard while saying nothing when you simply navigated
  // away. Not blocked while saving -- the save clears the staged edits.
  const guard = useNavigationGuard(dirtyCount > 0 && !saving);

  function cellValue(it: GridRow, col: GridCol): string {
    const s = staged.get(it.id);
    if (s && col.field in s) return s[col.field] ?? "";
    return col.get(it);
  }

  function isCellDirty(itemId: string, field: string): boolean {
    return staged.get(itemId)?.[field] !== undefined;
  }

  // Stage one cell. Records the prior value for undo.
  function stageCell(
    it: GridRow,
    col: GridCol,
    value: string,
    log = true,
  ) {
    if (saving || cellLock(it, col)) return;
    if (!originals.current.has(it.id)) originals.current.set(it.id, it);
    const original = col.get(originals.current.get(it.id)!);
    setStaged((prev) => {
      const next = new Map(prev);
      const rec = { ...(next.get(it.id) ?? {}) };
      const priorStaged = rec[col.field];
      if (value === original) {
        delete rec[col.field];
      } else {
        rec[col.field] = value;
      }
      if (Object.keys(rec).length === 0) next.delete(it.id);
      else next.set(it.id, rec);
      if (log) {
        setHistory((h) => [
          ...h,
          { itemId: it.id, field: col.field, prev: priorStaged },
        ]);
      }
      return next;
    });
  }

  const undo = useCallback(() => {
    if (saving) return;
    setHistory((h) => {
      if (h.length === 0) return h;
      const last = h[h.length - 1]!;
      setStaged((prev) => {
        const next = new Map(prev);
        const rec = { ...(next.get(last.itemId) ?? {}) };
        if (last.prev === undefined) delete rec[last.field];
        else rec[last.field] = last.prev;
        if (Object.keys(rec).length === 0) next.delete(last.itemId);
        else next.set(last.itemId, rec);
        return next;
      });
      return h.slice(0, -1);
    });
  }, [saving]);

  // Cmd/Ctrl-Z undo.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        undo();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [undo]);

  function focusCell(rowIdx: number, colIdx: number) {
    const el = document.querySelector<HTMLInputElement | HTMLSelectElement>(
      `[data-grid-row="${rowIdx}"][data-grid-col="${colIdx}"]`,
    );
    el?.focus();
    if (el instanceof HTMLInputElement) el.select();
  }

  function handleKeyDown(
    e: React.KeyboardEvent<HTMLInputElement | HTMLSelectElement>,
    rowIdx: number,
    colIdx: number,
    it: GridRow,
    col: GridCol,
  ) {
    if (e.key === "Enter" || e.key === "ArrowDown") {
      e.preventDefault();
      focusCell(rowIdx + 1, colIdx);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      focusCell(rowIdx - 1, colIdx);
    } else if (e.key === "Escape") {
      e.preventDefault();
      // Revert this cell to its original value.
      stageCell(it, col, col.get(it), false);
      (e.target as HTMLInputElement).blur();
    }
  }

  // Multi-cell paste: TSV from a spreadsheet fills cells down/right.
  function handlePaste(
    e: React.ClipboardEvent<HTMLInputElement | HTMLSelectElement>,
    rowIdx: number,
    colIdx: number,
  ) {
    if (saving) return;
    const text = e.clipboardData.getData("text/plain");
    if (!text || (!text.includes("\n") && !text.includes("\t"))) {
      return; // single value — let the default paste happen
    }
    e.preventDefault();
    const grid = text
      .replace(/\r/g, "")
      .split("\n")
      .filter((line, i, arr) => line !== "" || i < arr.length - 1)
      .map((line) => line.split("\t"));

    setStaged((prev) => {
      const next = new Map(prev);
      const logs: EditLog[] = [];
      grid.forEach((cells, dr) => {
        cells.forEach((raw, dc) => {
          const targetItem = pageRows[rowIdx + dr];
          const targetCol = visibleColumns[colIdx + dc];
          if (!targetItem || !targetCol || cellLock(targetItem, targetCol)) return;
          if (!originals.current.has(targetItem.id)) originals.current.set(targetItem.id, targetItem);
          const original = targetCol.get(targetItem);
          const rec = { ...(next.get(targetItem.id) ?? {}) };
          logs.push({
            itemId: targetItem.id,
            field: targetCol.field,
            prev: rec[targetCol.field],
          });
          if (raw === original) delete rec[targetCol.field];
          else rec[targetCol.field] = raw;
          if (Object.keys(rec).length === 0) next.delete(targetItem.id);
          else next.set(targetItem.id, rec);
        });
      });
      setHistory((h) => [...h, ...logs]);
      return next;
    });
    toast.info(`Pasted ${grid.length} row${grid.length === 1 ? "" : "s"}.`);
  }

  // The item columns this grid edits that a listing title can quote. `color` and
  // `department` are syncable fields too but this grid has no column for either,
  // so listing them would only widen the read for values that cannot change here.
  const TITLE_SYNC_COLS = ["brand", "style", "size", "color"] as const;

  interface TitleSyncListing {
    id: string;
    inventory_item_id: string | null;
    listing_title: string | null;
    title_variants: unknown;
    listing_origin: string | null;
    ai_generated_snapshot: { title?: string | null } | null;
  }

  // Best effort for the ROW, deliberately: the item write is what the seller
  // asked for and it has already succeeded, so failing the row because its title
  // could not follow would report a save that DID happen as an error, and the
  // recovery (re-saving) would then re-apply nothing. The substitution is
  // idempotent (US-1995), so a later edit on any surface picks it up.
  //
  // US-3376: best-effort is not the same as silent. This used to drop its
  // result, so a refused title write left the item showing the new brand and the
  // live listing still naming the old one, in the field buyers search hardest,
  // with nothing on screen. It now RETURNS the failure and saveAll says so in a
  // second warning, separately from the row count.
  //
  // Returns null on success or when there is nothing to write.
  async function syncListingTitle(
    itemId: string,
    patch: Record<string, unknown>,
    lst: TitleSyncListing | undefined,
  ): Promise<unknown | null> {
    if (!lst) return null;
    const before = originals.current.get(itemId);
    if (!before) return null;
    const changes = changesFromItemDiff(
      { brand: before.brand, style: before.style, size: before.size, color: before.color },
      {
        brand: "brand" in patch ? patch.brand : before.brand,
        style: "style" in patch ? patch.style : before.style,
        size: "size" in patch ? patch.size : before.size,
        color: "color" in patch ? patch.color : before.color,
      },
    );
    const titlePatch = buildTitleSyncPatch({
      baseTitle: lst.listing_title,
      variants: lst.title_variants,
      changes,
      snapshotTitle: lst.ai_generated_snapshot?.title ?? null,
      listingOrigin: lst.listing_origin,
    });
    if (Object.keys(titlePatch).length === 0) return null;
    const { error } = await supabase
      .from("listings")
      .update(titlePatch as never)
      .eq("id", lst.id);
    return error ?? null;
  }

  async function discardAll() {
    // Confirm before wiping a non-trivial batch of unsaved edits — a stray
    // click here would otherwise silently destroy the whole staging buffer.
    if (staged.size > 3) {
      const ok = await confirm({
        title: "Discard unsaved changes?",
        description: `You have edits across ${staged.size} rows that haven't been saved. Discarding can't be undone.`,
        confirmLabel: "Discard changes",
        destructive: true,
      });
      if (!ok) return;
    }
    setStaged(new Map());
    setHistory([]);
    setFailures([]);
    originals.current.clear();
  }

  async function saveAll() {
    if (staged.size === 0) return;
    setSaving(true);
    setProgress(0);
    const errors: { message: string }[] = [];
    let savedCount = 0;

    // US-1995: this grid edits Brand, Style and Size directly, so the listing
    // TITLE has to follow — a seller who fixes a brand across twenty rows here
    // otherwise gets twenty titles still naming the old one.
    //
    // The listing columns the substitution needs are NOT on items_full: it
    // carries listing_id and listing_title but not listing_origin,
    // title_variants or the AI snapshot. Read them once for the affected items
    // rather than per row. listing_origin especially is not optional — an
    // ebay-origin listing's title belongs to eBay
    // (vault/20-domain/sync-source-of-truth.md), and without the column the only
    // safe default would be to skip every row.
    const syncCandidates = Array.from(staged.entries())
      .filter(([, rec]) => TITLE_SYNC_COLS.some((f) => f in rec))
      .map(([id]) => id);
    const listingByItem = new Map<string, TitleSyncListing>();
    // US-3376: how many listing titles could NOT be made to follow, and the
    // first reason. Counted separately from `errors` because the row itself
    // saved: these are two different things to tell the seller.
    let titleSyncFailed = 0;
    let titleSyncError: unknown = null;
    if (syncCandidates.length > 0) {
      const { data: lst, error: lstErr } = await supabase
        .from("listings")
        .select(
          "id, inventory_item_id, listing_title, title_variants, listing_origin, ai_generated_snapshot",
        )
        .in("inventory_item_id", syncCandidates);
      // A dropped read here is the worst version of this bug: the map comes back
      // empty, every syncListingTitle call returns early on `!lst`, and NO title
      // follows anywhere while the save reports a clean success.
      if (lstErr) {
        titleSyncError = lstErr;
        titleSyncFailed = syncCandidates.length;
      }
      for (const row of (lst ?? []) as TitleSyncListing[]) {
        if (row.inventory_item_id) listingByItem.set(row.inventory_item_id, row);
      }
    }

    const savedIds = new Set<string>();
    const failed: typeof failures = [];
    // Keep requests sequential: a row may need several eBay calls.
    for (const [itemId, rec] of staged.entries()) {
      const original = originals.current.get(itemId);
      try {
        if (!original) throw new Error("Reload this item before saving.");
        const itemPatch: Record<string, unknown> = {};
        const listingEdits: Record<string, string> = {};
        for (const [field, value] of Object.entries(rec)) {
          const col = allColumns.find(candidate => candidate.field === field);
          if (!col) throw new Error("A column is no longer available.");
          const invalid = validateGridValue(col, value, { ...original, floor_price: rec.floor_price ? Number(rec.floor_price) : original.floor_price });
          if (invalid) throw new Error(`${col.label}: ${invalid}`);
          if (isListingColumn(col)) listingEdits[field] = value;
          else itemPatch[field] = value.trim() === "" ? null : col.numeric ? Number(value) : value;
        }
        await saveListing(original, listingEdits, allColumns);
        if (Object.keys(itemPatch).length > 0) {
          const { error } = await supabase.from("inventory_items").update(itemPatch as never).eq("id", itemId);
          if (error) throw error;
          // An explicit listing title must win over automatic substitutions.
          if (!("listing.listing_title" in rec)) {
            const titleErr = await syncListingTitle(itemId, itemPatch, listingByItem.get(itemId));
            if (titleErr) { titleSyncFailed += 1; titleSyncError ??= titleErr; }
          }
        }
        savedCount++;
        savedIds.add(itemId);
      } catch (err) {
        const message = err instanceof Error ? err.message : "This row could not be saved. Try again.";
        errors.push({ message });
        failed.push({ itemId, title: original?.item_title ?? "Item", message });
      }
      setProgress(count => count + 1);
    }
    setFailures(failed);
    setStaged(prev => new Map([...prev].filter(([id]) => !savedIds.has(id))));
    setHistory(prev => prev.filter(edit => !savedIds.has(edit.itemId)));
    savedIds.forEach(id => originals.current.delete(id));
    setSaving(false);
    setReviewOpen(false);
    await Promise.all([
      qc.invalidateQueries({ queryKey: ["items_full"] }),
      qc.invalidateQueries({ queryKey: ["grid-listings"] }),
    ]);
    if (errors.length === 0) {
      toast.success(`Saved ${savedCount} row${savedCount === 1 ? "" : "s"}.`);
    } else {
      toastWarning(errors[0], `Saved ${savedCount}, ${errors.length} failed.`, { duration: 12_000 });
    }
    // Its own toast, after the row result. The row saved; the live listing did
    // not follow, and that is what a buyer searching the old brand still sees.
    if (titleSyncFailed > 0) {
      toastWarning(
        titleSyncError,
        `${titleSyncFailed} live listing title${titleSyncFailed === 1 ? "" : "s"} may still name the old value.`,
        {
          action: "sync listing title",
          duration: 12_000,
          nextStep:
            "Open those items and save again to update the live listing.",
        },
      );
    }
  }

  return (
    <div className={cn("min-w-0 max-w-full space-y-4", staged.size > 0 && "pb-32")}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-3">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-brand-navy text-white">
              <Grid3x3 className="h-5 w-5" />
            </div>
            <div>
              <h1 className="text-2xl font-bold tracking-tight">Inventory</h1>
              <p className="text-sm text-muted-foreground">
                Edit inventory and eBay listings in bulk. Choose columns, make changes, then review and save.
              </p>
            </div>
          </div>
          <InventoryViewSwitcher current="grid" />
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <SearchInput
          label="Search inventory"
          value={searchDraft}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search title, brand, SKU…"
          className="w-full sm:w-64"
        />
        <SortMenu
          options={sortOptionsForMode("grid")}
          value={sortOption.id}
          onChange={setSortParam}
          className="w-52"
          label="Sort rows by"
        />
        {history.length > 0 && (
          <Button variant="ghost" size="sm" onClick={undo} disabled={saving}>
            <Undo2 className="mr-2 h-4 w-4" />
            Undo
          </Button>
        )}
      </div>

      {listingQuery.isError && <p role="alert" className="text-sm text-destructive">Listing fields could not load. Inventory fields are still available. <button className="underline" onClick={() => void listingQuery.refetch()}>Retry</button></p>}
      {failures.length > 0 && <div role="alert" className="space-y-2 rounded-lg border p-3 text-sm">
        <p className="font-medium">{failures.length} rows still need attention. Their changes are kept for retry.</p>
        {failures.map(failure => <p key={failure.itemId}><span className="font-medium">{failure.title}:</span> {failure.message}</p>)}
      </div>}
      {isLoading ? <TableLoadingSkeleton rows={10} columns={8} /> : isError ? (
        <ErrorState title="Couldn't load your inventory" description="Something went wrong while loading these items." onRetry={() => refetch()} retrying={isFetching} />
      ) : pageRows.length === 0 ? (
        <EmptyState icon={Search} title={search.trim() ? "No rows match your search" : "No inventory yet"} description="Add items or change your search to start editing." />
      ) : <div className={cn("min-w-0", isPlaceholderData && "pointer-events-none opacity-60")}>
        <GridSheet rows={pageRows} columns={visibleColumns} allColumns={allColumns} onColumns={chooseColumns} pageStart={pageStart} saving={saving || isPlaceholderData}
          value={cellValue} dirty={isCellDirty} onChange={stageCell} onKeyDown={handleKeyDown} onPaste={handlePaste} />
        <div className="flex flex-wrap items-center justify-between gap-3 py-3 text-sm">
          <span className="text-muted-foreground">{pageStart + 1}-{pageStart + pageRows.length} of {total.toLocaleString()} items</span>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={() => setPage(p => Math.max(1, p - 1))} disabled={saving || isPlaceholderData || safePage <= 1}><ChevronLeft className="mr-1 h-4 w-4" />Prev</Button>
            <span>Page {safePage} of {totalPages}</span>
            <Button variant="outline" size="sm" onClick={() => setPage(p => Math.min(totalPages, p + 1))} disabled={saving || isPlaceholderData || safePage >= totalPages}>Next<ChevronRight className="ml-1 h-4 w-4" /></Button>
          </div>
        </div>
      </div>}
      <GridReview open={reviewOpen} onOpenChange={setReviewOpen} staged={staged} originals={originals.current} columns={allColumns} saving={saving} progress={progress} onSave={() => void saveAll()} />

      {staged.size > 0 && (
        <div className="sticky bottom-[calc(4rem+env(safe-area-inset-bottom))] z-30 rounded-lg border bg-background md:bottom-0">
          <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-3 px-4 py-3">
            <div className="text-sm">
              <span className="font-semibold text-amber-700 dark:text-amber-400">
                {dirtyCount} cell{dirtyCount === 1 ? "" : "s"} changed
              </span>{" "}
              <span className="text-muted-foreground">
                across {staged.size} row{staged.size === 1 ? "" : "s"}
              </span>
            </div>
            <div className="flex gap-2">
              <Button
                variant="ghost"
                onClick={undo}
                disabled={saving || history.length === 0}
              >
                <Undo2 className="mr-2 h-4 w-4" />
                Undo
              </Button>
              <Button
                variant="outline"
                onClick={discardAll}
                disabled={saving}
              >
                <X className="mr-2 h-4 w-4" />
                Discard
              </Button>
              <Button onClick={() => setReviewOpen(true)} disabled={saving}>
                {saving ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <Check className="mr-2 h-4 w-4" />
                )}
                Review changes
              </Button>
            </div>
          </div>
        </div>
      )}

      <UnsavedChangesDialog guard={guard} noun="change" count={dirtyCount} />
    </div>
  );
}
