import { useMemo, useState, useEffect } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import {
  Search,
  ChevronLeft,
  ChevronRight,
  Pencil,
  ExternalLink,
  Plus,
  Upload,
  Clock,
  AlertCircle,
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
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
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
import { ITEM_STATUS_LABELS } from "@/lib/constants";
import { ItemDetailDialog } from "@/components/flipdesk/item-detail-dialog";
import { cn } from "@/lib/utils";
import type { ItemFullRow, ItemStatus } from "@/types/database";

type TabId =
  | "all"
  | "to_list"
  | "drafts"
  | "active"
  | "sold"
  | "shipped"
  | "returned";

const TO_LIST_STATUSES: ReadonlySet<ItemStatus> = new Set([
  "graded",
  "comped",
  "photographed",
]);

interface TabDef {
  id: TabId;
  label: string;
  matches: (it: ItemFullRow) => boolean;
  // Date field used for the default sort
  sortKey: keyof ItemFullRow;
  sortDir: "asc" | "desc";
  emptyCta: { label: string; to: string };
}

const TABS: TabDef[] = [
  {
    id: "all",
    label: "All",
    matches: () => true,
    sortKey: "created_at",
    sortDir: "desc",
    emptyCta: { label: "Add an item", to: "/dashboard/flipdesk/intake" },
  },
  {
    id: "to_list",
    label: "To List",
    matches: (it) => TO_LIST_STATUSES.has(it.status),
    sortKey: "updated_at",
    sortDir: "asc", // oldest first — these have been waiting longest
    emptyCta: { label: "Add an item", to: "/dashboard/flipdesk/intake" },
  },
  {
    id: "drafts",
    label: "Drafts",
    matches: (it) => it.status === "drafted",
    sortKey: "updated_at",
    sortDir: "asc",
    emptyCta: { label: "View To-List queue", to: "?tab=to_list" },
  },
  {
    id: "active",
    label: "Active",
    matches: (it) => it.status === "listed",
    sortKey: "list_date",
    sortDir: "desc",
    emptyCta: { label: "View drafts", to: "?tab=drafts" },
  },
  {
    id: "sold",
    label: "Sold",
    matches: (it) => it.status === "sold",
    sortKey: "sale_date",
    sortDir: "desc",
    emptyCta: { label: "View active listings", to: "?tab=active" },
  },
  {
    id: "shipped",
    label: "Shipped",
    matches: (it) => it.status === "shipped",
    sortKey: "sale_date",
    sortDir: "desc",
    emptyCta: { label: "View sold items", to: "?tab=sold" },
  },
  {
    id: "returned",
    label: "Returned",
    matches: (it) => it.status === "returned",
    sortKey: "updated_at",
    sortDir: "desc",
    emptyCta: { label: "View completed", to: "?tab=all" },
  },
];

const DAY_MS = 24 * 60 * 60 * 1000;
const PAGE_SIZE_OPTIONS = [50, 100, 200] as const;

function fmtMoney(n: number | null | undefined): string {
  if (n == null || isNaN(n)) return "";
  return `$${n.toFixed(2)}`;
}

function daysSince(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (isNaN(t)) return null;
  return Math.floor((Date.now() - t) / DAY_MS);
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

export function FlipdeskListingsPage() {
  const user = useAuthStore((s) => s.user);
  const [searchParams, setSearchParams] = useSearchParams();
  const initialTab = (searchParams.get("tab") as TabId) ?? "to_list";
  const [tab, setTab] = useState<TabId>(
    TABS.some((t) => t.id === initialTab) ? initialTab : "to_list",
  );
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState<number>(100);
  const [detailItem, setDetailItem] = useState<ItemFullRow | null>(null);

  // Sync URL ?tab= when tab changes.
  useEffect(() => {
    const next = new URLSearchParams(searchParams);
    if (tab === "to_list") next.delete("tab");
    else next.set("tab", tab);
    if (next.toString() !== searchParams.toString()) {
      setSearchParams(next, { replace: true });
    }
    setPage(1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);

  useEffect(() => {
    setPage(1);
  }, [search, pageSize]);

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

  // Tab counts — derived from a single client-side filter pass.
  const tabCounts = useMemo(() => {
    const counts: Record<TabId, number> = {
      all: 0,
      to_list: 0,
      drafts: 0,
      active: 0,
      sold: 0,
      shipped: 0,
      returned: 0,
    };
    for (const it of items) {
      for (const t of TABS) {
        if (t.matches(it)) counts[t.id]++;
      }
    }
    return counts;
  }, [items]);

  const activeTab = TABS.find((t) => t.id === tab) ?? TABS[0]!;

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const rows = items.filter((it) => {
      if (!activeTab.matches(it)) return false;
      if (q) {
        const hay = [
          it.item_title,
          it.brand,
          it.style,
          it.item_number,
          it.container,
        ]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });

    const dir = activeTab.sortDir === "asc" ? 1 : -1;
    const key = activeTab.sortKey;
    rows.sort((a, b) => {
      const av = a[key];
      const bv = b[key];
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      if (typeof av === "number" && typeof bv === "number") {
        return (av - bv) * dir;
      }
      return String(av).localeCompare(String(bv)) * dir;
    });
    return rows;
  }, [items, activeTab, search]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const safePage = Math.min(page, totalPages);
  const pageStart = (safePage - 1) * pageSize;
  const pageRows = filtered.slice(pageStart, pageStart + pageSize);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Listings</h1>
          <p className="text-sm text-muted-foreground">
            Triage surface — focus on items by their selling stage.
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

      <Tabs value={tab} onValueChange={(v) => setTab(v as TabId)}>
        <TabsList className="flex flex-wrap">
          {TABS.map((t) => (
            <TabsTrigger key={t.id} value={t.id} className="gap-2">
              {t.label}
              <Badge
                variant={tab === t.id ? "default" : "secondary"}
                className="px-1.5 py-0 text-[10px] tabular-nums"
              >
                {tabCounts[t.id].toLocaleString()}
              </Badge>
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>

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
      </div>

      <Card>
        <CardHeader>
          <CardTitle>
            {filtered.length} item{filtered.length === 1 ? "" : "s"}{" "}
            <span className="text-sm font-normal text-muted-foreground">
              in {activeTab.label}
            </span>
          </CardTitle>
          <CardDescription>
            {activeTab.sortDir === "asc" ? "Oldest first" : "Most recent first"}
            . Click a row for full details.
          </CardDescription>
        </CardHeader>
        <CardContent className="px-0">
          {isLoading ? (
            <div className="py-12 text-center text-sm text-muted-foreground">
              Loading items…
            </div>
          ) : pageRows.length === 0 ? (
            <div className="space-y-3 py-12 text-center text-sm text-muted-foreground">
              <div>
                {tab === "to_list"
                  ? "Nothing ready to list."
                  : tab === "drafts"
                    ? "No drafts."
                    : tab === "active"
                      ? "No active listings."
                      : tab === "sold"
                        ? "No sold items waiting to ship."
                        : tab === "shipped"
                          ? "Nothing shipped."
                          : tab === "returned"
                            ? "No returns."
                            : "No items."}
              </div>
              {activeTab.emptyCta.to.startsWith("?") ? (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    const url = new URL(
                      activeTab.emptyCta.to,
                      window.location.href,
                    );
                    const t = url.searchParams.get("tab") as TabId | null;
                    if (t) setTab(t);
                  }}
                >
                  {activeTab.emptyCta.label}
                </Button>
              ) : (
                <Button variant="outline" size="sm" asChild>
                  <Link to={activeTab.emptyCta.to}>
                    {activeTab.emptyCta.label}
                  </Link>
                </Button>
              )}
            </div>
          ) : (
            <>
              <div className="overflow-x-auto">
                <Table className="text-xs">
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-10" />
                      <TableHead className="min-w-[220px]">Title</TableHead>
                      <TableHead className="w-32">Brand · Size</TableHead>
                      <TableHead className="w-20 text-right">Cost</TableHead>
                      <TableHead className="w-20 text-right">
                        Target / List
                      </TableHead>
                      <TableHead className="w-20 text-right">Sale</TableHead>
                      <TableHead className="w-20 text-right">Net</TableHead>
                      <TableHead className="w-24">Status</TableHead>
                      <TableHead className="w-16 text-right">Age</TableHead>
                      <TableHead className="w-8" />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {pageRows.map((it) => {
                      const age = daysSince(it.updated_at);
                      const aging = age != null && age >= 14;
                      return (
                        <TableRow
                          key={it.id}
                          className="cursor-pointer hover:bg-muted/30"
                          onClick={() => setDetailItem(it)}
                        >
                          <TableCell
                            className="px-2"
                            onClick={(e) => e.stopPropagation()}
                          >
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
                          <TableCell className="max-w-[280px] truncate font-medium">
                            {it.item_title}
                          </TableCell>
                          <TableCell className="max-w-[140px] truncate text-muted-foreground">
                            {[it.brand, it.size].filter(Boolean).join(" · ")}
                          </TableCell>
                          <TableCell className="text-right tabular-nums">
                            {fmtMoney(it.purchase_price)}
                          </TableCell>
                          <TableCell className="text-right tabular-nums">
                            {fmtMoney(it.target_price ?? it.list_price)}
                          </TableCell>
                          <TableCell className="text-right tabular-nums">
                            {fmtMoney(it.sale_price)}
                          </TableCell>
                          <TableCell
                            className={cn(
                              "text-right tabular-nums",
                              it.net_profit != null &&
                                it.net_profit < 0 &&
                                "text-destructive",
                            )}
                          >
                            {fmtMoney(it.net_profit)}
                          </TableCell>
                          <TableCell>
                            <Badge
                              variant={
                                STATUS_BADGE_VARIANT[it.status] ?? "secondary"
                              }
                              className="text-[10px]"
                            >
                              {ITEM_STATUS_LABELS[it.status]}
                            </Badge>
                          </TableCell>
                          <TableCell className="text-right">
                            {age != null && (
                              <span
                                className={cn(
                                  "inline-flex items-center gap-1 tabular-nums",
                                  aging
                                    ? "font-medium text-destructive"
                                    : "text-muted-foreground",
                                )}
                              >
                                {aging ? (
                                  <AlertCircle className="h-3 w-3" />
                                ) : (
                                  <Clock className="h-3 w-3" />
                                )}
                                {age}d
                              </span>
                            )}
                          </TableCell>
                          <TableCell>
                            {it.link && (
                              <a
                                href={it.link}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="inline-flex text-brand-red"
                                onClick={(e) => e.stopPropagation()}
                                aria-label="Open listing"
                              >
                                <ExternalLink className="h-3 w-3" />
                              </a>
                            )}
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>

              <div className="flex flex-wrap items-center justify-between gap-3 border-t px-4 py-3 text-xs">
                <div className="flex items-center gap-2">
                  <span className="text-muted-foreground">Rows per page:</span>
                  <Select
                    value={String(pageSize)}
                    onValueChange={(v) => setPageSize(Number(v))}
                  >
                    <SelectTrigger className="h-7 w-20">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {PAGE_SIZE_OPTIONS.map((n) => (
                        <SelectItem key={n} value={String(n)}>
                          {n}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
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

      <ItemDetailDialog item={detailItem} onClose={() => setDetailItem(null)} />
    </div>
  );
}
