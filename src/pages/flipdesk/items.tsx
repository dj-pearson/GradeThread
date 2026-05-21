import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  Search,
  Upload,
  Plus,
  ExternalLink,
  Filter,
  Pencil,
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
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { supabase } from "@/lib/supabase";
import { useAuthStore } from "@/stores/auth-store";
import {
  ITEM_STATUSES,
  ITEM_STATUS_LABELS,
  PERSONAL_STATUSES,
} from "@/lib/constants";
import { InlineCell } from "@/components/flipdesk/inline-cell";
import { ItemDetailDialog } from "@/components/flipdesk/item-detail-dialog";
import type { ItemFullRow, ItemStatus } from "@/types/database";

type ViewMode = "pipeline" | "personal" | "all";

function fmtMoney(n: number | null | undefined): string {
  if (n == null || isNaN(n)) return "";
  return `$${n.toFixed(2)}`;
}

function fmtDate(d: string | null | undefined): string {
  if (!d) return "";
  const date = new Date(d);
  if (isNaN(date.getTime())) return "";
  return date.toISOString().slice(0, 10);
}

const STATUS_BADGE_VARIANT: Record<
  string,
  "default" | "secondary" | "outline" | "destructive"
> = {
  sold: "default",
  shipped: "default",
  completed: "default",
  listed: "default",
  drafted: "secondary",
  photographed: "secondary",
  measured: "secondary",
  cataloged: "secondary",
  sourced: "secondary",
  acquired: "secondary",
  grading: "secondary",
  graded: "secondary",
  comped: "secondary",
  returned: "destructive",
  archived: "outline",
  keeping: "outline",
  wearing: "outline",
};

export function FlipdeskItemsPage() {
  const user = useAuthStore((s) => s.user);
  const qc = useQueryClient();
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<ItemStatus | "all">("all");
  const [view, setView] = useState<ViewMode>("pipeline");
  const [detailItem, setDetailItem] = useState<ItemFullRow | null>(null);

  const { data: items, isLoading, error } = useQuery({
    queryKey: ["items_full", user?.id],
    enabled: !!user,
    queryFn: async () => {
      const { data, error: qErr } = await (
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
      if (qErr) throw qErr;
      return data ?? [];
    },
  });

  const filtered = useMemo(() => {
    if (!items) return [];
    const personalSet = new Set<string>(PERSONAL_STATUSES);
    return items.filter((it) => {
      if (view === "pipeline" && personalSet.has(it.status)) return false;
      if (view === "personal" && !personalSet.has(it.status)) return false;
      if (statusFilter !== "all" && it.status !== statusFilter) return false;
      if (search) {
        const q = search.toLowerCase();
        const hay = [
          it.item_title,
          it.brand,
          it.style,
          it.item_number,
          it.container,
          it.source_name,
        ]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [items, view, statusFilter, search]);

  async function updateField(
    id: string,
    patch: Record<string, string | number | null>,
  ) {
    try {
      const { error: uErr } = await supabase
        .from("inventory_items")
        .update(patch as never)
        .eq("id", id);
      if (uErr) throw uErr;
      await qc.invalidateQueries({ queryKey: ["items_full"] });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      toast.error(`Save failed: ${msg}`);
    }
  }

  async function updateStatus(id: string, status: ItemStatus) {
    await updateField(id, { status });
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Items</h1>
          <p className="text-sm text-muted-foreground">
            Click any cell to edit. Click <Pencil className="inline h-3 w-3" />{" "}
            to open the full editor.
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" asChild>
            <Link to="/dashboard/flipdesk/import">
              <Upload className="mr-2 h-4 w-4" />
              Import
            </Link>
          </Button>
          <Button asChild>
            <Link to="/dashboard/flipdesk/intake">
              <Plus className="mr-2 h-4 w-4" />
              New item
            </Link>
          </Button>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {(["pipeline", "personal", "all"] as const).map((v) => (
          <Button
            key={v}
            variant={view === v ? "default" : "outline"}
            size="sm"
            onClick={() => setView(v)}
          >
            {v === "pipeline"
              ? "Selling"
              : v === "personal"
                ? "Keeping / Wearing"
                : "All"}
          </Button>
        ))}
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search title, brand, SKU…"
              className="w-64 pl-9"
            />
          </div>
          <Select
            value={statusFilter}
            onValueChange={(v) => setStatusFilter(v as ItemStatus | "all")}
          >
            <SelectTrigger className="w-44">
              <Filter className="mr-2 h-4 w-4" />
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All statuses</SelectItem>
              {ITEM_STATUSES.map((s) => (
                <SelectItem key={s} value={s}>
                  {ITEM_STATUS_LABELS[s]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>{filtered.length} items</CardTitle>
          <CardDescription>
            Click a cell to edit; press Enter to save, Esc to cancel.
          </CardDescription>
        </CardHeader>
        <CardContent className="px-0">
          {isLoading ? (
            <div className="py-12 text-center text-sm text-muted-foreground">
              Loading items…
            </div>
          ) : error ? (
            <div className="space-y-2 py-12 text-center">
              <div className="text-sm font-medium text-destructive">
                Failed to load items
              </div>
              <div className="font-mono text-xs text-muted-foreground">
                {error instanceof Error ? error.message : String(error)}
              </div>
              <div className="text-xs text-muted-foreground">
                If you just imported, apply migration 00010 (view permissions).
              </div>
            </div>
          ) : filtered.length === 0 ? (
            <div className="py-12 text-center text-sm text-muted-foreground">
              No items yet.{" "}
              <Link
                to="/dashboard/flipdesk/import"
                className="font-medium text-brand-red underline"
              >
                Import from spreadsheet
              </Link>
              {" "}or{" "}
              <Link
                to="/dashboard/flipdesk/intake"
                className="font-medium text-brand-red underline"
              >
                add one manually
              </Link>
              .
            </div>
          ) : (
            <div className="overflow-x-auto">
              <Table className="text-xs">
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-10" />
                    <TableHead className="w-16">Bin</TableHead>
                    <TableHead className="w-20">SKU</TableHead>
                    <TableHead className="min-w-[180px]">Title</TableHead>
                    <TableHead className="w-24">Brand</TableHead>
                    <TableHead className="w-24">Style</TableHead>
                    <TableHead className="w-14">Size</TableHead>
                    <TableHead className="w-20">Category</TableHead>
                    <TableHead className="w-24">Source</TableHead>
                    <TableHead className="w-20">By</TableHead>
                    <TableHead className="w-16 text-right">Cost</TableHead>
                    <TableHead className="w-20">Bought</TableHead>
                    <TableHead className="w-20">Listed</TableHead>
                    <TableHead className="w-16 text-right">List $</TableHead>
                    <TableHead className="w-8">Link</TableHead>
                    <TableHead className="w-20">Sold</TableHead>
                    <TableHead className="w-16 text-right">Sale $</TableHead>
                    <TableHead className="w-14 text-right">Fees</TableHead>
                    <TableHead className="w-14 text-right">Tax</TableHead>
                    <TableHead className="w-14 text-right">Ship</TableHead>
                    <TableHead className="w-16 text-right">Net</TableHead>
                    <TableHead className="w-16 text-right">Payout</TableHead>
                    <TableHead className="w-28">Status</TableHead>
                    <TableHead className="w-10 text-right">Days</TableHead>
                    <TableHead className="w-24">Tracking</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filtered.map((it) => (
                    <TableRow key={it.id} className="hover:bg-muted/30">
                      <TableCell className="px-2">
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-6 w-6"
                          onClick={() => setDetailItem(it)}
                          aria-label="Open full editor"
                        >
                          <Pencil className="h-3 w-3" />
                        </Button>
                      </TableCell>
                      <TableCell className="font-mono text-[10px]">
                        <InlineCell
                          value={it.container}
                          onCommit={(v) =>
                            updateField(it.id, { container: v || null })
                          }
                        />
                      </TableCell>
                      <TableCell className="font-mono text-[10px]">
                        <InlineCell
                          value={it.item_number}
                          onCommit={(v) =>
                            updateField(it.id, { sku: v || null })
                          }
                        />
                      </TableCell>
                      <TableCell className="max-w-[220px] truncate font-medium">
                        <InlineCell
                          value={it.item_title}
                          onCommit={(v) =>
                            updateField(it.id, { title: v || it.item_title })
                          }
                          className="truncate"
                        />
                      </TableCell>
                      <TableCell className="max-w-[100px] truncate">
                        <InlineCell
                          value={it.brand}
                          onCommit={(v) =>
                            updateField(it.id, { brand: v || null })
                          }
                          className="truncate"
                        />
                      </TableCell>
                      <TableCell className="max-w-[100px] truncate">
                        <InlineCell
                          value={it.style}
                          onCommit={(v) =>
                            updateField(it.id, { style: v || null })
                          }
                          className="truncate"
                        />
                      </TableCell>
                      <TableCell className="max-w-[60px] truncate">
                        <InlineCell
                          value={it.size}
                          onCommit={(v) =>
                            updateField(it.id, { size: v || null })
                          }
                          className="truncate"
                        />
                      </TableCell>
                      <TableCell className="text-[10px]">
                        {it.category ?? ""}
                      </TableCell>
                      <TableCell className="max-w-[100px] truncate">
                        {it.source_name ?? ""}
                      </TableCell>
                      <TableCell className="max-w-[80px] truncate">
                        <InlineCell
                          value={it.sourced_by}
                          onCommit={(v) =>
                            updateField(it.id, { sourced_by: v || null })
                          }
                          className="truncate"
                        />
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        <InlineCell
                          value={it.purchase_price}
                          type="number"
                          align="right"
                          onCommit={(v) =>
                            updateField(it.id, {
                              acquired_price: v === "" ? null : Number(v),
                            })
                          }
                        />
                      </TableCell>
                      <TableCell className="text-[10px]">
                        {fmtDate(it.purchase_date)}
                      </TableCell>
                      <TableCell className="text-[10px]">
                        {fmtDate(it.list_date)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {fmtMoney(it.list_price)}
                      </TableCell>
                      <TableCell>
                        {it.link ? (
                          <a
                            href={it.link}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex text-brand-red"
                            aria-label="Open listing"
                          >
                            <ExternalLink className="h-3 w-3" />
                          </a>
                        ) : null}
                      </TableCell>
                      <TableCell className="text-[10px]">
                        {fmtDate(it.sale_date)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {fmtMoney(it.sale_price)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {fmtMoney(it.fees)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {fmtMoney(it.tax)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {fmtMoney(it.shipping_cost)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {fmtMoney(it.net_profit)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {fmtMoney(it.payout)}
                      </TableCell>
                      <TableCell>
                        <Select
                          value={it.status}
                          onValueChange={(v) =>
                            updateStatus(it.id, v as ItemStatus)
                          }
                        >
                          <SelectTrigger className="h-7 border-0 bg-transparent px-2 text-xs hover:bg-muted/60">
                            <Badge
                              variant={
                                STATUS_BADGE_VARIANT[it.status] ?? "secondary"
                              }
                              className="text-[10px]"
                            >
                              {ITEM_STATUS_LABELS[it.status]}
                            </Badge>
                          </SelectTrigger>
                          <SelectContent>
                            {ITEM_STATUSES.map((s) => (
                              <SelectItem key={s} value={s}>
                                {ITEM_STATUS_LABELS[s]}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {it.days_to_sell ?? ""}
                      </TableCell>
                      <TableCell className="max-w-[120px] truncate font-mono text-[10px]">
                        {it.tracking ?? ""}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      <ItemDetailDialog item={detailItem} onClose={() => setDetailItem(null)} />
    </div>
  );
}
