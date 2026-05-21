import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import {
  Search,
  Upload,
  Plus,
  ExternalLink,
  Filter,
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

const STATUS_BADGE_VARIANT: Record<string, "default" | "secondary" | "outline" | "destructive"> = {
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
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<ItemStatus | "all">("all");
  const [view, setView] = useState<ViewMode>("pipeline");

  const { data: items, isLoading, error } = useQuery({
    queryKey: ["items_full", user?.id],
    enabled: !!user,
    queryFn: async () => {
      // items_full is a view (migration 00009); not in the generated Database type.
      // Cast through unknown so the Supabase client doesn't reject the table name.
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

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Items</h1>
          <p className="text-sm text-muted-foreground">
            Spreadsheet view of every inventory item with listing + sale data.
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

      {/* View tabs */}
      <div className="flex flex-wrap items-center gap-2">
        {(["pipeline", "personal", "all"] as const).map((v) => (
          <Button
            key={v}
            variant={view === v ? "default" : "outline"}
            size="sm"
            onClick={() => setView(v)}
          >
            {v === "pipeline" ? "Selling" : v === "personal" ? "Keeping / Wearing" : "All"}
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
            Mirrors your Google Sheet columns. Horizontal scroll for the full width.
          </CardDescription>
        </CardHeader>
        <CardContent>
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
                If you just imported, make sure migration 00010 has been applied
                to grant the view permissions.
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
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Container</TableHead>
                    <TableHead>Item #</TableHead>
                    <TableHead className="min-w-[200px]">Title</TableHead>
                    <TableHead>Brand</TableHead>
                    <TableHead>Style</TableHead>
                    <TableHead>Size</TableHead>
                    <TableHead>Category</TableHead>
                    <TableHead>Source</TableHead>
                    <TableHead>Sourced By</TableHead>
                    <TableHead className="text-right">Purchase $</TableHead>
                    <TableHead>Purchase Date</TableHead>
                    <TableHead>List Date</TableHead>
                    <TableHead className="text-right">List $</TableHead>
                    <TableHead>Link</TableHead>
                    <TableHead>Sale Date</TableHead>
                    <TableHead className="text-right">Sale $</TableHead>
                    <TableHead className="text-right">Fees</TableHead>
                    <TableHead className="text-right">Tax</TableHead>
                    <TableHead className="text-right">Ship $</TableHead>
                    <TableHead className="text-right">Net</TableHead>
                    <TableHead className="text-right">Payout</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="text-right">Days</TableHead>
                    <TableHead>Tracking</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filtered.map((it) => (
                    <TableRow key={it.id}>
                      <TableCell className="font-mono text-xs">{it.container ?? ""}</TableCell>
                      <TableCell className="font-mono text-xs">{it.item_number ?? ""}</TableCell>
                      <TableCell className="max-w-xs truncate font-medium">
                        <Link
                          to={`/dashboard/flipdesk/items/${it.id}`}
                          className="hover:underline"
                        >
                          {it.item_title}
                        </Link>
                      </TableCell>
                      <TableCell>{it.brand ?? ""}</TableCell>
                      <TableCell>{it.style ?? ""}</TableCell>
                      <TableCell>{it.size ?? ""}</TableCell>
                      <TableCell>{it.category ?? ""}</TableCell>
                      <TableCell>{it.source_name ?? ""}</TableCell>
                      <TableCell>{it.sourced_by ?? ""}</TableCell>
                      <TableCell className="text-right tabular-nums">
                        {fmtMoney(it.purchase_price)}
                      </TableCell>
                      <TableCell>{fmtDate(it.purchase_date)}</TableCell>
                      <TableCell>{fmtDate(it.list_date)}</TableCell>
                      <TableCell className="text-right tabular-nums">
                        {fmtMoney(it.list_price)}
                      </TableCell>
                      <TableCell>
                        {it.link ? (
                          <a
                            href={it.link}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center gap-1 text-brand-red hover:underline"
                          >
                            link <ExternalLink className="h-3 w-3" />
                          </a>
                        ) : (
                          ""
                        )}
                      </TableCell>
                      <TableCell>{fmtDate(it.sale_date)}</TableCell>
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
                        <Badge variant={STATUS_BADGE_VARIANT[it.status] ?? "secondary"}>
                          {ITEM_STATUS_LABELS[it.status]}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {it.days_to_sell ?? ""}
                      </TableCell>
                      <TableCell className="font-mono text-xs">
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
    </div>
  );
}
