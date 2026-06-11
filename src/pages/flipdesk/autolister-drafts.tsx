import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import {
  Boxes,
  Search,
  ArrowRight,
  CalendarClock,
  Sparkles,
  Loader2,
  Layers,
  Rocket,
  ExternalLink,
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
import { toast } from "sonner";
import { useBulkPublish } from "@/hooks/use-autolister";
import { useEbayConnection } from "@/hooks/use-ebay";
import { supabase } from "@/lib/supabase";
import { useAuthStore } from "@/stores/auth-store";

// US-548: persistent AutoLister "Drafts" cockpit. The generation queue lives
// only at a ?batch= URL, so a reseller who generates today and reviews tomorrow
// loses the cockpit. This is the durable home for every UNPUBLISHED AutoLister
// draft (listings with a batch_id, still in 'draft'), with search + a route to
// each draft's editor and to its batch's queue (where publish-all + bulk edit
// live). RLS scopes the reads to the active workspace via the parent item.

interface DraftRow {
  id: string;
  inventory_item_id: string;
  listing_title: string | null;
  listing_price: number | null;
  batch_id: string | null;
  created_at: string;
  scheduled_publish_at: string | null;
  price_is_estimated: boolean | null;
  platform_category_id: string | null;
  needs_review: boolean | null;
}

// US-548: sort options for the cockpit.
type SortKey = "created_desc" | "created_asc" | "price_desc" | "price_asc" | "title_asc";

function fmtRelative(iso: string): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "—";
  const min = Math.round((Date.now() - t) / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.round(hr / 24);
  if (day < 7) return `${day}d ago`;
  return new Date(t).toLocaleDateString();
}

function fmtMoney(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return `$${n.toFixed(2)}`;
}

export function FlipdeskAutolisterDraftsPage() {
  const user = useAuthStore((s) => s.user);
  const [search, setSearch] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("created_desc");
  const bulkPublish = useBulkPublish();
  const { data: ebayConnection } = useEbayConnection();

  const { data: drafts = [], isLoading } = useQuery({
    queryKey: ["autolister_drafts", user?.id],
    enabled: !!user,
    staleTime: 30_000,
    queryFn: async (): Promise<DraftRow[]> => {
      const { data, error } = await supabase
        .from("listings")
        .select(
          "id, inventory_item_id, listing_title, listing_price, batch_id, created_at, scheduled_publish_at, price_is_estimated, platform_category_id, needs_review",
        )
        .eq("listing_status", "draft")
        .not("batch_id", "is", null)
        .order("created_at", { ascending: false })
        .limit(500);
      if (error) throw error;
      return (data ?? []) as DraftRow[];
    },
  });

  // Titles fall back to the inventory item when the listing_title is blank.
  const itemIds = useMemo(
    () => drafts.map((d) => d.inventory_item_id),
    [drafts],
  );
  const { data: titles = {} } = useQuery<Record<string, string>>({
    queryKey: ["autolister_drafts_titles", user?.id, itemIds.length],
    enabled: itemIds.length > 0,
    queryFn: async () => {
      const { data: rows } = await supabase
        .from("inventory_items")
        .select("id, title")
        .in("id", itemIds);
      const map: Record<string, string> = {};
      for (const r of (rows ?? []) as Array<{ id: string; title: string }>) {
        map[r.id] = r.title;
      }
      return map;
    },
  });

  function titleFor(d: DraftRow): string {
    return (
      (d.listing_title && d.listing_title.trim()) ||
      titles[d.inventory_item_id] ||
      "Untitled draft"
    );
  }

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return drafts;
    return drafts.filter((d) => {
      const title =
        (d.listing_title && d.listing_title.trim()) ||
        titles[d.inventory_item_id] ||
        "Untitled draft";
      return title.toLowerCase().includes(q);
    });
  }, [drafts, search, titles]);

  // US-548: apply the chosen sort to the filtered set.
  const sorted = useMemo(() => {
    const rows = [...filtered];
    rows.sort((a, b) => {
      switch (sortKey) {
        case "created_asc":
          return a.created_at.localeCompare(b.created_at);
        case "price_desc":
          return (b.listing_price ?? 0) - (a.listing_price ?? 0);
        case "price_asc":
          return (a.listing_price ?? 0) - (b.listing_price ?? 0);
        case "title_asc":
          return titleFor(a).localeCompare(titleFor(b));
        case "created_desc":
        default:
          return b.created_at.localeCompare(a.created_at);
      }
    });
    return rows;
  }, [filtered, sortKey, titles]); // eslint-disable-line react-hooks/exhaustive-deps

  // US-548: a draft is "ready" to publish when it isn't flagged for review,
  // carries a real price + category, and isn't already on a schedule. Bulk
  // publish-all only touches these (the per-item pre-flight is still the gate).
  const readyDrafts = useMemo(
    () =>
      sorted.filter(
        (d) =>
          !d.needs_review &&
          (d.listing_price ?? 0) > 0 &&
          !!d.platform_category_id &&
          !d.scheduled_publish_at,
      ),
    [sorted],
  );

  async function publishReady() {
    if (readyDrafts.length === 0) return;
    await bulkPublish.run(
      readyDrafts.map((d) => ({ itemId: d.inventory_item_id, listingId: d.id })),
    );
    toast.success("Publish finished — see per-row status.");
  }

  const totalValue = useMemo(
    () => drafts.reduce((sum, d) => sum + (d.listing_price ?? 0), 0),
    [drafts],
  );
  // Distinct batches represented, for the "open queue" affordance.
  const batchCount = useMemo(
    () => new Set(drafts.map((d) => d.batch_id).filter(Boolean)).size,
    [drafts],
  );

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-brand-navy text-white">
            <Boxes className="h-5 w-5" />
          </div>
          <div>
            <h1 className="text-2xl font-bold tracking-tight">AutoLister drafts</h1>
            <p className="text-sm text-muted-foreground">
              Every unpublished draft, in one place — pick up where you left off.
            </p>
          </div>
        </div>
        <Button asChild>
          <Link to="/dashboard/flipdesk/autolister">
            <Sparkles className="mr-2 h-4 w-4" />
            New batch
          </Link>
        </Button>
      </div>

      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <CardTitle>
                {drafts.length} draft{drafts.length === 1 ? "" : "s"}
              </CardTitle>
              <CardDescription>
                Across {batchCount} batch{batchCount === 1 ? "" : "es"} ·{" "}
                {fmtMoney(totalValue)} total list value
              </CardDescription>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <div className="relative w-full max-w-xs">
                <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
                <Input
                  placeholder="Search drafts by title…"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  className="pl-8"
                />
              </div>
              <Select value={sortKey} onValueChange={(v) => setSortKey(v as SortKey)}>
                <SelectTrigger className="w-[150px]">
                  <SelectValue placeholder="Sort" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="created_desc">Newest first</SelectItem>
                  <SelectItem value="created_asc">Oldest first</SelectItem>
                  <SelectItem value="price_desc">Price: high → low</SelectItem>
                  <SelectItem value="price_asc">Price: low → high</SelectItem>
                  <SelectItem value="title_asc">Title: A → Z</SelectItem>
                </SelectContent>
              </Select>
              {/* US-548: publish-all from the cockpit (ready drafts only). */}
              {readyDrafts.length > 0 && (
                <Button
                  onClick={() => void publishReady()}
                  disabled={bulkPublish.running || !ebayConnection}
                  className="bg-emerald-600 hover:bg-emerald-700"
                  title={
                    !ebayConnection
                      ? "Connect eBay first on the Marketplaces page."
                      : "Validate and publish every ready draft (not flagged, priced, categorized, unscheduled)."
                  }
                >
                  {bulkPublish.running ? (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  ) : (
                    <Rocket className="mr-2 h-4 w-4" />
                  )}
                  Publish {readyDrafts.length} ready
                </Button>
              )}
            </div>
          </div>
        </CardHeader>
        <CardContent className="px-0">
          {isLoading ? (
            <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              Loading drafts…
            </div>
          ) : drafts.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-2 py-12 text-center">
              <Boxes className="h-8 w-8 text-muted-foreground/50" />
              <p className="text-sm font-medium">No unpublished drafts yet</p>
              <p className="max-w-sm text-sm text-muted-foreground">
                Generate listings in AutoLister and they'll wait here until you
                review and publish them.
              </p>
              <Button asChild size="sm" className="mt-1">
                <Link to="/dashboard/flipdesk/autolister">Open AutoLister</Link>
              </Button>
            </div>
          ) : filtered.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              No drafts match “{search}”.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Title</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="text-right">Price</TableHead>
                    <TableHead>Category</TableHead>
                    <TableHead>Scheduled</TableHead>
                    <TableHead>Created</TableHead>
                    <TableHead>Batch</TableHead>
                    <TableHead className="w-20" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {sorted.map((d) => {
                    const pub = bulkPublish.results[d.inventory_item_id];
                    return (
                    <TableRow key={d.id}>
                      <TableCell className="max-w-xs truncate font-medium">
                        {titleFor(d)}
                      </TableCell>
                      <TableCell>
                        {pub?.status === "publishing" ? (
                          <Badge variant="secondary" className="gap-1 text-[10px]">
                            <Loader2 className="h-3 w-3 animate-spin" />
                            Publishing
                          </Badge>
                        ) : pub?.status === "success" ? (
                          pub.listingUrl ? (
                            <a
                              href={pub.listingUrl}
                              target="_blank"
                              rel="noreferrer"
                              className="inline-flex items-center gap-1 text-[11px] text-emerald-600 hover:underline"
                            >
                              Live <ExternalLink className="h-3 w-3" />
                            </a>
                          ) : (
                            <Badge className="text-[10px]">Live</Badge>
                          )
                        ) : pub?.status === "failed" ? (
                          <Link
                            to={`/dashboard/flipdesk/items/${d.inventory_item_id}/draft`}
                            className="text-[11px] text-destructive underline-offset-2 hover:underline"
                            title={`${pub.error} — click to fix`}
                          >
                            Failed
                          </Link>
                        ) : d.needs_review ? (
                          <Badge
                            variant="outline"
                            className="border-amber-500/40 bg-amber-500/10 text-[10px] text-amber-700"
                          >
                            Needs review
                          </Badge>
                        ) : (
                          <Badge
                            variant="outline"
                            className="border-emerald-500/40 bg-emerald-500/10 text-[10px] text-emerald-700"
                          >
                            Ready
                          </Badge>
                        )}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {fmtMoney(d.listing_price)}
                        {d.price_is_estimated && (
                          <Badge
                            variant="outline"
                            className="ml-1.5 text-[10px]"
                            title="AI estimate — verify before publishing"
                          >
                            est.
                          </Badge>
                        )}
                      </TableCell>
                      <TableCell>
                        {d.platform_category_id ? (
                          <span className="text-xs text-muted-foreground">
                            {d.platform_category_id}
                          </span>
                        ) : (
                          <Badge
                            variant="outline"
                            className="border-amber-500/40 bg-amber-500/10 text-[10px] text-amber-700"
                          >
                            needs category
                          </Badge>
                        )}
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {d.scheduled_publish_at ? (
                          <span className="inline-flex items-center gap-1">
                            <CalendarClock className="h-3 w-3" />
                            {new Date(d.scheduled_publish_at).toLocaleDateString()}
                          </span>
                        ) : (
                          "—"
                        )}
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {fmtRelative(d.created_at)}
                      </TableCell>
                      <TableCell>
                        {d.batch_id && (
                          <Button
                            asChild
                            size="sm"
                            variant="ghost"
                            className="h-7 px-2 text-[11px]"
                          >
                            <Link
                              to={`/dashboard/flipdesk/autolister/queue?batch=${d.batch_id}`}
                              title="Open this batch (publish all / bulk edit)"
                            >
                              <Layers className="mr-1 h-3 w-3" />
                              Queue
                            </Link>
                          </Button>
                        )}
                      </TableCell>
                      <TableCell>
                        <Button asChild size="sm" variant="ghost">
                          <Link
                            to={`/dashboard/flipdesk/items/${d.inventory_item_id}/draft`}
                          >
                            Review
                            <ArrowRight className="ml-1 h-3 w-3" />
                          </Link>
                        </Button>
                      </TableCell>
                    </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
