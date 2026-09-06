import { useEffect, useMemo, useState } from "react";
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
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { TableLoadingSkeleton } from "@/components/ui/skeletons";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorState } from "@/components/ui/error-state";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { changesFromItemDiff } from "@/lib/title-sync";
import { buildTitleSyncPatch } from "@/lib/title-sync-patch";
import { Button } from "@/components/ui/button";
import { supabase } from "@/lib/supabase";
import { useAuthStore } from "@/stores/auth-store";
import { cn } from "@/lib/utils";
import {
  useUrlParamState,
  useUrlSearchInput,
} from "@/hooks/use-url-param-state";
import { SortMenu } from "@/components/flipdesk/sort-menu";
import {
  columnSortForMode,
  resolveSortOptionForMode,
  sortOptionsForMode,
} from "@/pages/flipdesk/inventory-sort";
import { InventoryViewSwitcher } from "@/components/flipdesk/inventory-view-switcher";
import type { ItemFullRow } from "@/types/database";

// Editable grid columns. `field` is the inventory_items DB column to write.
interface GridCol {
  key: string;
  label: string;
  field: string;
  numeric: boolean;
  width: string;
  get: (it: ItemFullRow) => string;
}

const COLS: GridCol[] = [
  {
    key: "sku",
    label: "SKU",
    field: "sku",
    numeric: false,
    width: "w-28",
    get: (it) => it.item_number ?? "",
  },
  {
    key: "title",
    label: "Title",
    field: "title",
    numeric: false,
    width: "w-72",
    get: (it) => it.item_title ?? "",
  },
  {
    key: "brand",
    label: "Brand",
    field: "brand",
    numeric: false,
    width: "w-36",
    get: (it) => it.brand ?? "",
  },
  {
    key: "style",
    label: "Style",
    field: "style",
    numeric: false,
    width: "w-36",
    get: (it) => it.style ?? "",
  },
  {
    key: "size",
    label: "Size",
    field: "size",
    numeric: false,
    width: "w-20",
    get: (it) => it.size ?? "",
  },
  {
    key: "cost",
    label: "Cost",
    field: "acquired_price",
    numeric: true,
    width: "w-24",
    get: (it) => (it.purchase_price == null ? "" : String(it.purchase_price)),
  },
  {
    key: "target",
    label: "Target",
    field: "target_price",
    numeric: true,
    width: "w-24",
    get: (it) => (it.target_price == null ? "" : String(it.target_price)),
  },
  {
    // US-3122: who bought the item. The spreadsheet is the surface where a
    // seller assigns twenty of these at once, and it is what makes the new
    // "Sourced by" sort and filter worth having — both are useless while the
    // column is empty. It writes the NAME as text, exactly as intake and the
    // composer do; the 00672 roster picks the name, it does not replace it.
    key: "sourced_by",
    label: "Sourced by",
    field: "sourced_by",
    numeric: false,
    width: "w-32",
    get: (it) => it.sourced_by ?? "",
  },
  {
    key: "notes",
    label: "Notes",
    field: "condition_notes",
    numeric: false,
    width: "w-72",
    get: (it) => it.notes ?? "",
  },
];

const PAGE_SIZE = 100;

// Only the columns this spreadsheet renders/edits — the items_full view is wide
// (jsonb comps/measurements, per-row photo subqueries) and loading all of it
// per page is wasteful (US-404). Selecting a slim projection lets Postgres
// prune the unused view columns from the plan.
const GRID_COLUMNS =
  "id,item_number,item_title,brand,style,size,purchase_price,target_price," +
  "sourced_by,notes,status";

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
  const [page, setPage] = useState(1);
  const [staged, setStaged] = useState<Staged>(new Map());
  const [history, setHistory] = useState<EditLog[]>([]);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setPage(1);
  }, [search, sortParam]);

  // US-404: server-side pagination. Only the current page (PAGE_SIZE rows) of a
  // slim column projection is ever loaded, with a grouped exact count for the
  // total — so a 5k+ item account stays responsive instead of transferring the
  // entire wide view on every render. Search is pushed to the server too.
  const { data, isLoading, isError, isPlaceholderData, refetch, isFetching } =
    useQuery({
    queryKey: [
      "items_full",
      "grid",
      user?.id,
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

  const pageRows = data?.rows ?? [];
  const total = data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const pageStart = (safePage - 1) * PAGE_SIZE;

  // Clamp the page when a search shrinks the result set below the current page.
  useEffect(() => {
    if (page > totalPages) setPage(totalPages);
  }, [page, totalPages]);

  const dirtyCount = useMemo(() => {
    let n = 0;
    for (const rec of staged.values()) n += Object.keys(rec).length;
    return n;
  }, [staged]);

  function cellValue(it: ItemFullRow, col: GridCol): string {
    const s = staged.get(it.id);
    if (s && col.field in s) return s[col.field] ?? "";
    return col.get(it);
  }

  function isCellDirty(itemId: string, field: string): boolean {
    return staged.get(itemId)?.[field] !== undefined;
  }

  // Stage one cell. Records the prior value for undo.
  function stageCell(
    it: ItemFullRow,
    col: GridCol,
    value: string,
    log = true,
  ) {
    const original = col.get(it);
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

  function undo() {
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
  }

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
  }, []);

  function focusCell(rowIdx: number, colIdx: number) {
    const el = document.querySelector<HTMLInputElement>(
      `[data-grid-row="${rowIdx}"][data-grid-col="${colIdx}"]`,
    );
    el?.focus();
    el?.select();
  }

  function handleKeyDown(
    e: React.KeyboardEvent<HTMLInputElement>,
    rowIdx: number,
    colIdx: number,
    it: ItemFullRow,
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
    e: React.ClipboardEvent<HTMLInputElement>,
    rowIdx: number,
    colIdx: number,
  ) {
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
          const targetCol = COLS[colIdx + dc];
          if (!targetItem || !targetCol) return;
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
  const TITLE_SYNC_COLS = ["brand", "style", "size"] as const;

  interface TitleSyncListing {
    id: string;
    inventory_item_id: string | null;
    listing_title: string | null;
    title_variants: unknown;
    listing_origin: string | null;
    ai_generated_snapshot: { title?: string | null } | null;
  }

  // Best effort, deliberately. The item write is what the seller asked for and it
  // has already succeeded; failing the row because its title could not follow
  // would report a save that DID happen as an error, and the recovery — re-saving
  // — would then re-apply nothing. The substitution is idempotent (US-1995), so a
  // later edit on any surface picks it up.
  async function syncListingTitle(
    itemId: string,
    patch: Record<string, unknown>,
    lst: TitleSyncListing | undefined,
  ) {
    if (!lst) return;
    const before = pageRows.find((r) => r.id === itemId);
    if (!before) return;
    const changes = changesFromItemDiff(
      { brand: before.brand, style: before.style, size: before.size },
      {
        brand: "brand" in patch ? patch.brand : before.brand,
        style: "style" in patch ? patch.style : before.style,
        size: "size" in patch ? patch.size : before.size,
      },
    );
    const titlePatch = buildTitleSyncPatch({
      baseTitle: lst.listing_title,
      variants: lst.title_variants,
      changes,
      snapshotTitle: lst.ai_generated_snapshot?.title ?? null,
      listingOrigin: lst.listing_origin,
    });
    if (Object.keys(titlePatch).length === 0) return;
    await supabase.from("listings").update(titlePatch as never).eq("id", lst.id);
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
  }

  async function saveAll() {
    if (staged.size === 0) return;
    setSaving(true);
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
    if (syncCandidates.length > 0) {
      const { data: lst } = await supabase
        .from("listings")
        .select(
          "id, inventory_item_id, listing_title, title_variants, listing_origin, ai_generated_snapshot",
        )
        .in("inventory_item_id", syncCandidates);
      for (const row of (lst ?? []) as TitleSyncListing[]) {
        if (row.inventory_item_id) listingByItem.set(row.inventory_item_id, row);
      }
    }

    await Promise.all(
      Array.from(staged.entries()).map(async ([itemId, rec]) => {
        try {
          const patch: Record<string, unknown> = {};
          for (const [field, value] of Object.entries(rec)) {
            const col = COLS.find((c) => c.field === field);
            if (col?.numeric) {
              patch[field] = value.trim() === "" ? null : Number(value);
            } else {
              patch[field] = value.trim() === "" ? null : value;
            }
          }
          const { error } = await supabase
            .from("inventory_items")
            .update(patch as never)
            .eq("id", itemId);
          if (error) throw error;
          await syncListingTitle(itemId, patch, listingByItem.get(itemId));
          savedCount++;
        } catch (err) {
          errors.push({
            message: err instanceof Error ? err.message : String(err),
          });
        }
      }),
    );
    setSaving(false);
    await qc.invalidateQueries({ queryKey: ["items_full"] });
    if (errors.length === 0) {
      setStaged(new Map());
      setHistory([]);
      toast.success(`Saved ${savedCount} row${savedCount === 1 ? "" : "s"}.`);
    } else {
      toastWarning(
        errors[0],
        `Saved ${savedCount}, ${errors.length} failed.`,
        { duration: 12_000 },
      );
    }
  }

  return (
    <div className={cn("space-y-4", staged.size > 0 && "pb-24")}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-3">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-brand-navy text-white">
              <Grid3x3 className="h-5 w-5" />
            </div>
            <div>
              <h1 className="text-2xl font-bold tracking-tight">Inventory</h1>
              <p className="text-sm text-muted-foreground">
                Spreadsheet-style bulk editing. Tab between cells, paste
                columns from Sheets, Cmd-Z to undo.
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
          className="w-64"
        />
        <SortMenu
          options={sortOptionsForMode("grid")}
          value={sortOption.id}
          onChange={setSortParam}
          className="w-52"
          label="Sort rows by"
        />
        {history.length > 0 && (
          <Button variant="ghost" size="sm" onClick={undo}>
            <Undo2 className="mr-2 h-4 w-4" />
            Undo
          </Button>
        )}
      </div>

      <Card>
        <CardHeader>
          <CardTitle>{total.toLocaleString()} rows</CardTitle>
          <CardDescription>
            Sorted by {sortOption.label.toLowerCase()}. Click a cell to edit.
            Enter / ↑ ↓ move between rows; Esc reverts a cell. Changed cells
            turn amber.
          </CardDescription>
        </CardHeader>
        <CardContent className="px-0">
          {isLoading ? (
            <TableLoadingSkeleton rows={10} columns={8} />
          ) : isError ? (
            <ErrorState
              title="Couldn't load your inventory"
              description="Something went wrong while loading these items."
              onRetry={() => refetch()}
              retrying={isFetching}
            />
          ) : pageRows.length === 0 ? (
            search.trim() ? (
              <EmptyState
                icon={Search}
                title="No rows match your search"
                description={`Nothing matched "${search.trim()}". Try a different title, brand, or SKU.`}
                secondaryAction={{
                  label: "Clear search",
                  onClick: () => setSearch(""),
                }}
              />
            ) : (
              <EmptyState
                icon={Grid3x3}
                title="No inventory yet"
                description="Add or import items to start editing them spreadsheet-style here."
                action={{ label: "Add item", to: "/dashboard/flipdesk/intake" }}
              />
            )
          ) : (
            <>
              <div
                className={cn(
                  "overflow-x-auto transition-opacity",
                  isPlaceholderData && "opacity-60",
                )}
              >
                <table
                  className="w-full border-collapse text-xs"
                  role="grid"
                  aria-label="Editable inventory grid"
                  aria-rowcount={total}
                  aria-colcount={COLS.length + 1}
                >
                  <thead>
                    <tr className="border-b bg-muted/40" role="row" aria-rowindex={1}>
                      <th
                        role="columnheader"
                        aria-colindex={1}
                        className="w-10 px-2 py-2 text-left font-medium text-muted-foreground"
                      >
                        #
                      </th>
                      {COLS.map((col, colIdx) => (
                        <th
                          key={col.key}
                          role="columnheader"
                          aria-colindex={colIdx + 2}
                          className={cn(
                            "px-2 py-2 text-left font-medium text-muted-foreground",
                            col.width,
                          )}
                        >
                          {col.label}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {pageRows.map((it, rowIdx) => {
                      const rowNumber = pageStart + rowIdx + 1;
                      return (
                        <tr
                          key={it.id}
                          className="border-b"
                          role="row"
                          aria-rowindex={pageStart + rowIdx + 2}
                        >
                          <td
                            role="rowheader"
                            aria-colindex={1}
                            className="px-2 py-0 text-[10px] text-muted-foreground"
                          >
                            {rowNumber}
                          </td>
                          {COLS.map((col, colIdx) => {
                            const dirty = isCellDirty(it.id, col.field);
                            return (
                              <td
                                key={col.key}
                                role="gridcell"
                                aria-colindex={colIdx + 2}
                                className="p-0"
                              >
                                <input
                                  data-grid-row={rowIdx}
                                  data-grid-col={colIdx}
                                  aria-label={`${col.label}, row ${rowNumber}`}
                                  value={cellValue(it, col)}
                                  onChange={(e) =>
                                    stageCell(it, col, e.target.value)
                                  }
                                  onKeyDown={(e) =>
                                    handleKeyDown(e, rowIdx, colIdx, it, col)
                                  }
                                  onPaste={(e) =>
                                    handlePaste(e, rowIdx, colIdx)
                                  }
                                  onFocus={(e) => e.currentTarget.select()}
                                  inputMode={col.numeric ? "decimal" : "text"}
                                  className={cn(
                                    // AA-contrast active-cell indicator (US-449):
                                    // a 2px brand-red inset ring (≥3:1 against the
                                    // light gray AND dark night surfaces) plus a
                                    // tint, lifted above the row borders with z-10.
                                    "h-8 w-full border-0 bg-transparent px-2 outline-none focus:relative focus:z-10 focus:bg-brand-red/10 focus:ring-2 focus:ring-inset focus:ring-brand-red dark:focus:bg-brand-red/20",
                                    col.numeric && "text-right tabular-nums",
                                    dirty &&
                                      "bg-amber-100 dark:bg-amber-950/40",
                                  )}
                                />
                              </td>
                            );
                          })}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              <div className="flex flex-wrap items-center justify-between gap-3 border-t px-4 py-3 text-xs">
                <div className="text-muted-foreground">
                  {pageStart + 1}–{pageStart + pageRows.length} of{" "}
                  {total.toLocaleString()}
                </div>
                <div className="flex items-center gap-1">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setPage((p) => Math.max(1, p - 1))}
                    disabled={safePage <= 1}
                  >
                    <ChevronLeft className="h-4 w-4" />
                    Prev
                  </Button>
                  <span className="px-2">
                    Page {safePage} of {totalPages}
                  </span>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                    disabled={safePage >= totalPages}
                  >
                    Next
                    <ChevronRight className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      {staged.size > 0 && (
        <div className="fixed inset-x-0 bottom-0 z-40 border-t bg-card/95 backdrop-blur supports-[backdrop-filter]:bg-card/80">
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
              <Button onClick={saveAll} disabled={saving}>
                {saving ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <Check className="mr-2 h-4 w-4" />
                )}
                Save all
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
