import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
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
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { supabase } from "@/lib/supabase";
import { useAuthStore } from "@/stores/auth-store";
import { cn } from "@/lib/utils";
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
    key: "notes",
    label: "Notes",
    field: "condition_notes",
    numeric: false,
    width: "w-72",
    get: (it) => it.notes ?? "",
  },
];

const PAGE_SIZE = 100;

type Staged = Map<string, Record<string, string>>; // itemId → { field: value }
interface EditLog {
  itemId: string;
  field: string;
  prev: string | undefined;
}

export function FlipdeskGridPage() {
  const user = useAuthStore((s) => s.user);
  const qc = useQueryClient();
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [staged, setStaged] = useState<Staged>(new Map());
  const [history, setHistory] = useState<EditLog[]>([]);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setPage(1);
  }, [search]);

  const { data: items = [], isLoading } = useQuery({
    queryKey: ["items_full", user?.id],
    enabled: !!user,
    staleTime: 5 * 60 * 1000,
    queryFn: async (): Promise<ItemFullRow[]> => {
      const { data, error } = await (
        supabase.from as unknown as (
          name: "items_full",
        ) => {
          select: (cols: string) => {
            order: (
              col: string,
              opts?: { ascending?: boolean },
            ) => Promise<{ data: ItemFullRow[] | null; error: Error | null }>;
          };
        }
      )("items_full")
        .select("*")
        .order("created_at", { ascending: false });
      if (error) throw error;
      return data ?? [];
    },
  });

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return items;
    return items.filter((it) => {
      const hay = [it.item_title, it.brand, it.item_number, it.style]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return hay.includes(q);
    });
  }, [items, search]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const pageStart = (safePage - 1) * PAGE_SIZE;
  const pageRows = filtered.slice(pageStart, pageStart + PAGE_SIZE);

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

  function discardAll() {
    setStaged(new Map());
    setHistory([]);
  }

  async function saveAll() {
    if (staged.size === 0) return;
    setSaving(true);
    const errors: { message: string }[] = [];
    let savedCount = 0;
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
      toast.warning(
        `Saved ${savedCount}, ${errors.length} failed. First: ${errors[0]?.message}`,
        { duration: 12_000 },
      );
    }
  }

  return (
    <div className={cn("space-y-4", staged.size > 0 && "pb-24")}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-brand-navy text-white">
            <Grid3x3 className="h-5 w-5" />
          </div>
          <div>
            <h1 className="text-2xl font-bold tracking-tight">Grid edit</h1>
            <p className="text-sm text-muted-foreground">
              Spreadsheet-style bulk editing. Tab between cells, paste columns
              from Sheets, Cmd-Z to undo.
            </p>
          </div>
        </div>
        <Button variant="outline" asChild>
          <Link to="/dashboard/flipdesk/items">Back to Items</Link>
        </Button>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search title, brand, SKU…"
            className="w-64 pl-9"
          />
        </div>
        {history.length > 0 && (
          <Button variant="ghost" size="sm" onClick={undo}>
            <Undo2 className="mr-2 h-4 w-4" />
            Undo
          </Button>
        )}
      </div>

      <Card>
        <CardHeader>
          <CardTitle>{filtered.length} rows</CardTitle>
          <CardDescription>
            Click a cell to edit. Enter / ↑ ↓ move between rows; Esc reverts a
            cell. Changed cells turn amber.
          </CardDescription>
        </CardHeader>
        <CardContent className="px-0">
          {isLoading ? (
            <div className="py-12 text-center text-sm text-muted-foreground">
              Loading…
            </div>
          ) : pageRows.length === 0 ? (
            <div className="py-12 text-center text-sm text-muted-foreground">
              No rows.
            </div>
          ) : (
            <>
              <div className="overflow-x-auto">
                <table className="w-full border-collapse text-xs">
                  <thead>
                    <tr className="border-b bg-muted/40">
                      <th className="w-10 px-2 py-2 text-left font-medium text-muted-foreground">
                        #
                      </th>
                      {COLS.map((col) => (
                        <th
                          key={col.key}
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
                    {pageRows.map((it, rowIdx) => (
                      <tr key={it.id} className="border-b">
                        <td className="px-2 py-0 text-[10px] text-muted-foreground">
                          {pageStart + rowIdx + 1}
                        </td>
                        {COLS.map((col, colIdx) => {
                          const dirty = isCellDirty(it.id, col.field);
                          return (
                            <td key={col.key} className="p-0">
                              <input
                                data-grid-row={rowIdx}
                                data-grid-col={colIdx}
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
                                  "h-8 w-full border-0 bg-transparent px-2 outline-none focus:bg-brand-navy/10 focus:ring-1 focus:ring-inset focus:ring-brand-navy",
                                  col.numeric && "text-right tabular-nums",
                                  dirty &&
                                    "bg-amber-100 dark:bg-amber-950/40",
                                )}
                              />
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div className="flex flex-wrap items-center justify-between gap-3 border-t px-4 py-3 text-xs">
                <div className="text-muted-foreground">
                  {pageStart + 1}–{pageStart + pageRows.length} of{" "}
                  {filtered.length}
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
