import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate } from "react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
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
  Keyboard,
  Check,
  X,
  Pencil,
  AlertTriangle,
} from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/ui/page-header";
import { TruncatedNotice } from "@/components/flipdesk/truncated-notice";
import { fetchCapped } from "@/lib/paged-read";
import { itemRowLabel } from "@/lib/item-row-label";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { LoadingRegion, SkeletonRows } from "@/components/ui/skeletons";
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
import { ClickableRow } from "@/components/clickable-row";
import { toast } from "sonner";
import { useBulkPublish } from "@/hooks/use-autolister";
import { useBulkAspectCoverage, useEbayConnection } from "@/hooks/use-ebay";
import { BulkAiEnrichDialog } from "@/components/flipdesk/bulk-ai-enrich-dialog";
import {
  QualityScoreChip,
  type QualityScoreSummary,
} from "@/components/flipdesk/quality-score-chip";
import { qualityRankOf, scoreMapFromRows } from "@/pages/flipdesk/draft-quality";
import { supabase } from "@/lib/supabase";
import { useAuthStore } from "@/stores/auth-store";
import { cn } from "@/lib/utils";
import { titleQuality } from "@/lib/title-quality";
import { estimateListingProfit } from "@/lib/listing-profit";
import type { AspectReviewEntry } from "@/types/database";

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
  price_comp_source: string | null;
  platform_category_id: string | null;
  needs_review: boolean | null;
  // US-828: per-aspect needs-review entries from generation reconciliation; its
  // length drives the "N to fix" count badge on the row.
  aspect_review: AspectReviewEntry[] | null;
}

// US-548: sort options for the cockpit.
type SortKey =
  | "created_desc"
  | "created_asc"
  | "price_desc"
  | "price_asc"
  | "title_asc"
  | "coverage_asc"
  | "quality_asc";

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

// US-549: a small "key — action" chip for the keyboard-review cheatsheet.
function Shortcut({ keys, label }: { keys: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1">
      <kbd className="rounded border bg-muted px-1.5 py-0.5 font-mono text-[10px] text-foreground">
        {keys}
      </kbd>
      <span>{label}</span>
    </span>
  );
}

export function FlipdeskAutolisterDraftsPage() {
  const user = useAuthStore((s) => s.user);
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [search, setSearch] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("created_desc");
  const bulkPublish = useBulkPublish();
  const { data: ebayConnection } = useEbayConnection();

  // US-2169: capped reads report their own truncation. `.limit(500)` rendered
  // as if it were everything meant a seller past 500 drafts published against a
  // queue they could not tell was cut short. fetchCapped asks for one row past
  // the cap, so `truncated` is a fact rather than a guess.
  const { data: draftsRead, isLoading } = useQuery({
    queryKey: ["autolister_drafts", user?.id],
    enabled: !!user,
    staleTime: 30_000,
    queryFn: () => fetchCapped<DraftRow>(async (limit) => {
      const { data, error } = await supabase
        .from("listings")
        .select(
          "id, inventory_item_id, listing_title, listing_price, batch_id, created_at, scheduled_publish_at, price_is_estimated, price_comp_source, platform_category_id, needs_review, aspect_review",
        )
        .eq("listing_status", "draft")
        .not("batch_id", "is", null)
        // US-1568: this cockpit is the 'AI-processed, not yet human-reviewed'
        // queue. A composer Save stamps reviewed_at and the draft drops off
        // here — its durable home is Inventory → Drafts until published.
        .is("reviewed_at", null)
        .order("created_at", { ascending: false })
        .limit(limit);
      if (error) throw error;
      return (data ?? []) as DraftRow[];
    }),
  });
  // Memoized so the `?? []` fallback does not mint a new array each render —
  // several useMemos below take it as a dependency.
  const drafts = useMemo<DraftRow[]>(() => draftsRead?.rows ?? [], [draftsRead]);

  // Titles fall back to the inventory item when the listing_title is blank.
  const itemIds = useMemo(
    () => drafts.map((d) => d.inventory_item_id),
    [drafts],
  );
  // US-1895: recommended-aspect coverage per draft, so a bulk session can sort
  // + fix low-coverage drafts before publishing (one de-duped edge call).
  const { data: coverageByItem = {} } = useBulkAspectCoverage(itemIds);

  // US-1897: the persisted Listing Quality Score per draft.
  //
  // Fetched SEPARATELY and FAIL-SOFT on purpose. quality_score lands in
  // migration 00476, which is held — adding it to the drafts query above would
  // make that query 42703 and take the WHOLE PAGE down the moment the frontend
  // deploys ahead of the SQL (the hazard CLAUDE.md's held-migration rule calls
  // out). Here a missing column just means no chips: every draft reads as
  // "not scored", which is exactly what it is.
  const listingIds = useMemo(() => drafts.map((d) => d.id), [drafts]);
  const { data: scoreByListing = {} } = useQuery({
    queryKey: ["draft-quality-scores", listingIds],
    enabled: listingIds.length > 0,
    staleTime: 30_000,
    queryFn: async (): Promise<Record<string, QualityScoreSummary>> => {
      const { data, error } = await supabase
        .from("listings")
        .select("id, quality_score, quality_blocked")
        .in("id", listingIds);
      // A missing column (00476 not applied yet) lands here as an error; an
      // empty map means "nothing scored", which is the honest answer.
      if (error) return {};
      return scoreMapFromRows(
        (data ?? []) as Array<{
          id: string;
          quality_score: number | null;
          quality_blocked: boolean | null;
        }>,
      );
    },
  });
  // See draft-quality.ts for why unscored sinks to the end.
  const qualityRank = (listingId: string): number => qualityRankOf(scoreByListing[listingId]);
  // Ratio (0..1) for sorting; unknown/no-recommended coverage sinks to the end.
  const coverageRatio = (itemId: string): number => {
    const c = coverageByItem[itemId];
    if (!c || c.total === 0) return 2;
    return c.filled / c.total;
  };
  // The draft lives on `listings`, but what you PAID lives on the inventory
  // item (inventory_items.acquired_price — surfaced as purchase_price by the
  // items_full view the Inventory table reads). Pull it alongside the title so
  // a draft can show cost + estimated return without a second round trip.
  const { data: itemMeta = {} } = useQuery<
    Record<string, { title: string; cost: number | null }>
  >({
    queryKey: ["autolister_drafts_items", user?.id, itemIds.length],
    enabled: itemIds.length > 0,
    queryFn: async () => {
      const { data: rows } = await supabase
        .from("inventory_items")
        .select("id, title, acquired_price")
        .in("id", itemIds);
      const map: Record<string, { title: string; cost: number | null }> = {};
      for (const r of (rows ?? []) as Array<{
        id: string;
        title: string;
        acquired_price: number | null;
      }>) {
        map[r.id] = { title: r.title, cost: r.acquired_price };
      }
      return map;
    },
  });

  function titleFor(d: DraftRow): string {
    return (
      (d.listing_title && d.listing_title.trim()) ||
      itemMeta[d.inventory_item_id]?.title ||
      "Untitled draft"
    );
  }

  function costFor(d: DraftRow): number | null {
    return itemMeta[d.inventory_item_id]?.cost ?? null;
  }

  // Forward-looking net for an UNSOLD draft: price − eBay fees − cost, via the
  // same estimator the AutoLister price input uses (US-553), so the two
  // surfaces can never quote different numbers for the same draft. Null when
  // there's no price to estimate from; cost is treated as 0 when unset, which
  // makes the return an upper bound rather than a blank.
  function returnFor(d: DraftRow): { net: number; marginPct: number } | null {
    const price = d.listing_price;
    if (price == null || !Number.isFinite(price) || price <= 0) return null;
    const { net, marginPct } = estimateListingProfit({
      price,
      costBasis: costFor(d),
    });
    return { net, marginPct };
  }

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return drafts;
    return drafts.filter((d) => {
      const title =
        (d.listing_title && d.listing_title.trim()) ||
        itemMeta[d.inventory_item_id]?.title ||
        "Untitled draft";
      return title.toLowerCase().includes(q);
    });
  }, [drafts, search, itemMeta]);

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
        case "coverage_asc":
          return (
            coverageRatio(a.inventory_item_id) -
            coverageRatio(b.inventory_item_id)
          );
        case "quality_asc":
          return qualityRank(a.id) - qualityRank(b.id);
        case "created_desc":
        default:
          return b.created_at.localeCompare(a.created_at);
      }
    });
    return rows;
  }, [filtered, sortKey, itemMeta, coverageByItem, scoreByListing]); // eslint-disable-line react-hooks/exhaustive-deps

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

  // US-549: keyboard-first review. j/k move the active row, e expands an inline
  // editor, Enter = Save & next (stays in the cockpit — never the item canvas),
  // x toggles multi-select, p publishes the selection, / focuses the find box.
  const [activeIndex, setActiveIndex] = useState(0);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState("");
  const [editPrice, setEditPrice] = useState("");
  const [editCost, setEditCost] = useState("");
  const [saving, setSaving] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  // US-2817: re-run identification over the selected drafts. Old stock was
  // catalogued by an older model; this reads the photos again and corrects what
  // the AI itself wrote, leaving anything the seller typed alone.
  const [reidentifyOpen, setReidentifyOpen] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const rowRefs = useRef<Record<string, HTMLTableRowElement | null>>({});
  const editTitleRef = useRef<HTMLInputElement>(null);

  // Keep the active index inside the visible (filtered + sorted) list.
  useEffect(() => {
    if (sorted.length === 0) {
      if (activeIndex !== 0) setActiveIndex(0);
    } else if (activeIndex > sorted.length - 1) {
      setActiveIndex(sorted.length - 1);
    }
  }, [sorted.length, activeIndex]);

  // Scroll the active row into view as the user navigates with j/k.
  useEffect(() => {
    const row = sorted[activeIndex];
    if (row) rowRefs.current[row.id]?.scrollIntoView({ block: "nearest" });
  }, [activeIndex, sorted]);

  // Focus the title field whenever the inline editor opens.
  useEffect(() => {
    if (editingId) editTitleRef.current?.focus();
  }, [editingId]);

  const openEditor = useCallback((d: DraftRow) => {
    setEditingId(d.id);
    setEditTitle(
      (d.listing_title && d.listing_title.trim()) ||
        itemMeta[d.inventory_item_id]?.title ||
        "",
    );
    setEditPrice(d.listing_price != null ? String(d.listing_price) : "");
    const cost = itemMeta[d.inventory_item_id]?.cost;
    setEditCost(cost != null ? String(cost) : "");
  }, [itemMeta]);

  // Persist the inline edits, patching the cached row in place so the list
  // doesn't re-sort/jump mid-review.
  const persistEdit = useCallback(
    async (row: DraftRow): Promise<boolean> => {
      const title = editTitle.trim();
      const parsed = editPrice.trim() === "" ? null : Number(editPrice);
      const price = parsed != null && Number.isFinite(parsed) ? parsed : null;
      const parsedCost = editCost.trim() === "" ? null : Number(editCost);
      const cost =
        parsedCost != null && Number.isFinite(parsedCost) && parsedCost >= 0
          ? parsedCost
          : null;
      setSaving(true);
      try {
        const { error } = await supabase
          .from("listings")
          .update({ listing_title: title || null, listing_price: price } as never)
          .eq("id", row.id);
        if (error) {
          toast.error(`Couldn't save: ${error.message}`);
          return false;
        }
        // Cost lives on the ITEM, not the listing — a separate write, and only
        // when it actually changed so the keyboard review loop doesn't issue a
        // pointless update per draft. A failure here is reported but does NOT
        // fail the save: the title/price edit already landed, and silently
        // rolling the user back to the previous draft would lose it.
        const prevCost = itemMeta[row.inventory_item_id]?.cost ?? null;
        if (cost !== prevCost) {
          const { error: costErr } = await supabase
            .from("inventory_items")
            .update({ acquired_price: cost } as never)
            .eq("id", row.inventory_item_id);
          if (costErr) {
            toast.error(`Saved, but the cost didn't stick: ${costErr.message}`);
          } else {
            queryClient.setQueryData<
              Record<string, { title: string; cost: number | null }>
            >(
              ["autolister_drafts_items", user?.id, itemIds.length],
              (old) => ({
                ...(old ?? {}),
                [row.inventory_item_id]: {
                  title: old?.[row.inventory_item_id]?.title ?? "",
                  cost,
                },
              }),
            );
          }
        }
        queryClient.setQueryData<DraftRow[]>(
          ["autolister_drafts", user?.id],
          (old) =>
            (old ?? []).map((d) =>
              d.id === row.id
                ? { ...d, listing_title: title || null, listing_price: price }
                : d,
            ),
        );
        return true;
      } finally {
        setSaving(false);
      }
    },
    [editTitle, editPrice, editCost, itemMeta, itemIds.length, queryClient, user?.id],
  );

  // Enter inside the editor: save the current row, then advance and keep the
  // editor open on the next row so the seller can fly through the batch.
  const saveAndNext = useCallback(async () => {
    const row = sorted[activeIndex];
    if (!row) return;
    const ok = await persistEdit(row);
    if (!ok) return;
    const next = activeIndex + 1;
    if (next < sorted.length) {
      setActiveIndex(next);
      openEditor(sorted[next]!);
    } else {
      setEditingId(null);
      toast.success("Reviewed the last draft.");
    }
  }, [sorted, activeIndex, persistEdit, openEditor]);

  const toggleSelect = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  // Select-all applies to what is on screen, not to every draft in the account
  // — the search box is how a seller narrows "the old ones" down, so honouring
  // the filter is the whole point of the control.
  const allVisibleSelected =
    sorted.length > 0 && sorted.every((d) => selectedIds.has(d.id));

  const toggleSelectAllVisible = useCallback(() => {
    setSelectedIds((prev) => {
      const visible = sorted.map((d) => d.id);
      const everySelected =
        visible.length > 0 && visible.every((id) => prev.has(id));
      if (everySelected) {
        const next = new Set(prev);
        for (const id of visible) next.delete(id);
        return next;
      }
      return new Set([...prev, ...visible]);
    });
  }, [sorted]);

  // The AI works on inventory items; a draft row is the listing attached to one.
  const selectedItemIds = useMemo(
    () =>
      Array.from(
        new Set(
          sorted
            .filter((d) => selectedIds.has(d.id))
            .map((d) => d.inventory_item_id),
        ),
      ),
    [sorted, selectedIds],
  );

  async function publishSelected() {
    const chosen = sorted.filter((d) => selectedIds.has(d.id));
    if (chosen.length === 0) {
      toast.error("Select drafts first (press x on a row).");
      return;
    }
    if (!ebayConnection) {
      toast.error("Connect eBay first on the Marketplaces page.");
      return;
    }
    await bulkPublish.run(
      chosen.map((d) => ({ itemId: d.inventory_item_id, listingId: d.id })),
    );
    toast.success("Publish finished — see per-row status.");
  }

  // Global key handler for the cockpit. Typing in the search/editor inputs is
  // respected; only the documented shortcuts are intercepted.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      const el = e.target as HTMLElement | null;
      const tag = el?.tagName;
      const typing = tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
      const inEditor =
        editingId !== null && !!el?.closest("[data-draft-editor]");

      // "/" focuses the find box from anywhere we're not already typing.
      if (e.key === "/" && !typing) {
        e.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
        return;
      }

      if (inEditor) {
        if (e.key === "Enter") {
          e.preventDefault();
          void saveAndNext();
        } else if (e.key === "Escape") {
          e.preventDefault();
          setEditingId(null);
        }
        return;
      }

      // Don't hijack normal typing in the search box (but let Esc blur it).
      if (typing) {
        if (e.key === "Escape") (el as HTMLElement).blur();
        return;
      }

      if (sorted.length === 0) return;
      const active = sorted[activeIndex];
      switch (e.key) {
        case "j":
        case "ArrowDown":
          e.preventDefault();
          setActiveIndex((i) => Math.min(i + 1, sorted.length - 1));
          break;
        case "k":
        case "ArrowUp":
          e.preventDefault();
          setActiveIndex((i) => Math.max(i - 1, 0));
          break;
        case "e":
        case "Enter":
          if (active) {
            e.preventDefault();
            openEditor(active);
          }
          break;
        case "x":
          if (active) {
            e.preventDefault();
            toggleSelect(active.id);
          }
          break;
        case "p":
          e.preventDefault();
          void publishSelected();
          break;
        default:
          break;
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
    // publishSelected is intentionally not memoized; it closes over current state.
  }, [sorted, activeIndex, editingId, saveAndNext, openEditor, toggleSelect]); // eslint-disable-line react-hooks/exhaustive-deps

  const totalValue = useMemo(
    () => drafts.reduce((sum, d) => sum + (d.listing_price ?? 0), 0),
    [drafts],
  );
  // What this pile of drafts cost you, and what it nets if every one sells at
  // its current price. `costKnown` is reported alongside so a partial total
  // can't read as a complete one.
  const costTotals = useMemo(() => {
    let cost = 0;
    let net = 0;
    let costKnown = 0;
    for (const d of drafts) {
      const c = itemMeta[d.inventory_item_id]?.cost ?? null;
      if (c != null) {
        cost += c;
        costKnown++;
      }
      const price = d.listing_price;
      if (price != null && Number.isFinite(price) && price > 0) {
        net += estimateListingProfit({ price, costBasis: c }).net;
      }
    }
    return { cost, net, costKnown };
  }, [drafts, itemMeta]);
  // Distinct batches represented, for the "open queue" affordance.
  const batchCount = useMemo(
    () => new Set(drafts.map((d) => d.batch_id).filter(Boolean)).size,
    [drafts],
  );

  return (
    <div className="space-y-6">
      <PageHeader
        icon={Boxes}
        title="AutoLister drafts"
        subtitle="Every unpublished draft, in one place — pick up where you left off."
        actions={
          <Button asChild>
            <Link to="/dashboard/flipdesk/autolister">
              <Sparkles className="mr-2 h-4 w-4" />
              New batch
            </Link>
          </Button>
        }
      />

      {draftsRead?.truncated && (
        <TruncatedNotice
          limit={draftsRead.limit}
          noun="drafts"
          action="Publish or review some to see the rest."
        />
      )}

      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <CardTitle>
                {drafts.length} draft{drafts.length === 1 ? "" : "s"}
              </CardTitle>
              <CardDescription>
                Across {batchCount} batch{batchCount === 1 ? "" : "es"} ·{" "}
                {fmtMoney(totalValue)} total list value ·{" "}
                {fmtMoney(costTotals.cost)} cost
                {costTotals.costKnown < drafts.length && (
                  <span
                    className="text-muted-foreground"
                    title={`${drafts.length - costTotals.costKnown} draft(s) have no purchase price recorded`}
                  >
                    {" "}
                    ({costTotals.costKnown}/{drafts.length} priced)
                  </span>
                )}{" "}
                · {fmtMoney(costTotals.net)} est. return
              </CardDescription>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <div className="relative w-full max-w-xs">
                <Search
                  aria-hidden="true"
                  className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground"
                />
                <Input
                  ref={searchRef}
                  aria-label="Search drafts"
                  placeholder="Search drafts by title…  ( / )"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  className="pl-8"
                />
              </div>
              <Select value={sortKey} onValueChange={(v) => setSortKey(v as SortKey)}>
                <SelectTrigger className="w-[150px]" aria-label="Sort drafts">
                  <SelectValue placeholder="Sort" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="created_desc">Newest first</SelectItem>
                  <SelectItem value="created_asc">Oldest first</SelectItem>
                  <SelectItem value="price_desc">Price: high → low</SelectItem>
                  <SelectItem value="price_asc">Price: low → high</SelectItem>
                  <SelectItem value="title_asc">Title: A → Z</SelectItem>
                  <SelectItem value="coverage_asc">Coverage: low first</SelectItem>
                  <SelectItem value="quality_asc">Quality: low first</SelectItem>
                </SelectContent>
              </Select>
              {/* US-2817: re-run identification over the selected drafts. */}
              {selectedIds.size > 0 && (
                <Button
                  variant="outline"
                  onClick={() => setReidentifyOpen(true)}
                  title="Read the photos again with the current AI and correct what it got wrong before. Values you typed are kept."
                >
                  <Sparkles className="mr-2 h-4 w-4" />
                  Re-run AI on {selectedIds.size}
                </Button>
              )}
              {/* US-549: publish the keyboard-selected subset. */}
              {selectedIds.size > 0 && (
                <Button
                  variant="outline"
                  onClick={() => void publishSelected()}
                  disabled={bulkPublish.running || !ebayConnection}
                  title={
                    !ebayConnection
                      ? "Connect eBay first on the Marketplaces page."
                      : "Validate and publish the selected drafts (p)."
                  }
                >
                  {bulkPublish.running ? (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  ) : (
                    <Rocket className="mr-2 h-4 w-4" />
                  )}
                  Publish {selectedIds.size} selected
                </Button>
              )}
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
            <LoadingRegion label="Loading drafts" className="px-4">
              <SkeletonRows rows={5} />
            </LoadingRegion>
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
              {/* US-549: keyboard-first review cheatsheet. */}
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 pb-3 text-[11px] text-muted-foreground">
                <span className="inline-flex items-center gap-1 font-medium text-foreground">
                  <Keyboard className="h-3.5 w-3.5" />
                  Keyboard review
                </span>
                <Shortcut keys="j / k" label="move" />
                <Shortcut keys="e" label="edit" />
                <Shortcut keys="Enter" label="save & next" />
                <Shortcut keys="x" label="select" />
                <Shortcut keys="p" label="publish selected" />
                <Shortcut keys="/" label="find" />
              </div>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-8">
                      <input
                        type="checkbox"
                        className="h-4 w-4 accent-emerald-600"
                        checked={allVisibleSelected}
                        onChange={toggleSelectAllVisible}
                        aria-label={
                          allVisibleSelected
                            ? "Clear selection"
                            : "Select all drafts shown"
                        }
                      />
                    </TableHead>
                    <TableHead>Title</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="text-right">Price</TableHead>
                    <TableHead className="text-right">Cost</TableHead>
                    <TableHead className="text-right">Est. return</TableHead>
                    <TableHead>Category</TableHead>
                    {/* US-1895: recommended-aspect coverage. */}
                    <TableHead>Specifics</TableHead>
                    <TableHead>Scheduled</TableHead>
                    <TableHead>Created</TableHead>
                    <TableHead>Batch</TableHead>
                    <TableHead className="w-20" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {sorted.map((d, idx) => {
                    const pub = bulkPublish.results[d.inventory_item_id];
                    const isActive = idx === activeIndex;
                    const isSelected = selectedIds.has(d.id);
                    // US-2450. titleFor() is the VISIBLE title and falls back to
                    // "Untitled draft" — correct to print and wrong to speak,
                    // because a screen of fresh drafts would all be called that.
                    // itemRowLabel refuses that placeholder and falls through to an
                    // id fragment: ugly to hear, distinguishing, which is the job.
                    const draftName = itemRowLabel({
                      item_title: titleFor(d),
                      id: d.id,
                    });
                    const isEditing = editingId === d.id;
                    return (
                    <Fragment key={d.id}>
                    <ClickableRow
                      ref={(node) => {
                        rowRefs.current[d.id] = node;
                      }}
                      aria-selected={isActive}
                      data-active={isActive || undefined}
                      onActivate={() => setActiveIndex(idx)}
                      activateLabel={`Select draft ${titleFor(d)}`}
                      className={cn(
                        "scroll-mt-16",
                        isActive &&
                          "bg-accent/60 outline outline-2 -outline-offset-2 outline-primary",
                        isSelected && "bg-emerald-500/5",
                      )}
                    >
                      <TableCell className="w-8 align-middle">
                        <input
                          type="checkbox"
                          className="h-4 w-4 accent-emerald-600"
                          checked={isSelected}
                          onClick={(e) => e.stopPropagation()}
                          onChange={() => toggleSelect(d.id)}
                          aria-label={`Select ${titleFor(d)}`}
                        />
                      </TableCell>
                      <TableCell className="max-w-xs font-medium">
                        <span className="flex items-center gap-1.5">
                          <span className="min-w-0 truncate">{titleFor(d)}</span>
                          {/* US-1897 AC2: the quality score, so a bulk session
                              can see at a glance which drafts are weak — and
                              which cannot be listed at all. */}
                          <QualityScoreChip score={scoreByListing[d.id]} />
                        </span>
                        {/* US-1892: flag weak titles (<60 chars or a lint
                            finding) so a bulk session catches them pre-publish. */}
                        {titleQuality({ title: titleFor(d) }).weak && (
                          <Badge
                            variant="outline"
                            className="mt-0.5 gap-1 border-amber-500/50 text-[10px] text-amber-600 dark:text-amber-400"
                          >
                            <AlertTriangle className="h-3 w-3" />
                            Weak title
                          </Badge>
                        )}
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
                              className="inline-flex items-center gap-1 text-[11px] text-emerald-600 hover:underline dark:text-emerald-400"
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
                            className="border-amber-500/40 bg-amber-500/10 text-[10px] text-amber-700 dark:text-amber-300"
                            title={
                              d.aspect_review && d.aspect_review.length > 0
                                ? `eBay specifics to fix: ${d.aspect_review
                                    .map((a) => a.aspect)
                                    .join(", ")}`
                                : undefined
                            }
                          >
                            {/* US-828: show how many specifics need reconciling. */}
                            {d.aspect_review && d.aspect_review.length > 0
                              ? `${d.aspect_review.length} to fix`
                              : "Needs review"}
                          </Badge>
                        ) : (
                          <Badge
                            variant="outline"
                            className="border-emerald-500/40 bg-emerald-500/10 text-[10px] text-emerald-700 dark:text-emerald-300"
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
                            title={
                              d.price_comp_source === "active_asking"
                                ? "Based on active asking prices (not sold comps) — may run high. Verify before publishing."
                                : "AI estimate — verify before publishing"
                            }
                          >
                            est.
                          </Badge>
                        )}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {costFor(d) == null ? (
                          <span
                            className="text-muted-foreground"
                            title="No purchase price recorded — press e to add it"
                          >
                            —
                          </span>
                        ) : (
                          fmtMoney(costFor(d))
                        )}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {(() => {
                          const r = returnFor(d);
                          if (!r) return <span className="text-muted-foreground">—</span>;
                          return (
                            <span
                              className={cn(
                                r.net < 0 && "text-destructive",
                                r.net >= 0 &&
                                  "text-emerald-700 dark:text-emerald-400",
                              )}
                              title={
                                costFor(d) == null
                                  ? "No cost recorded — this is the ceiling, not your actual return"
                                  : `${fmtMoney(d.listing_price)} − eBay fees − ${fmtMoney(costFor(d))} cost`
                              }
                            >
                              {fmtMoney(r.net)}
                              <span className="ml-1 text-[11px] text-muted-foreground">
                                {r.marginPct.toFixed(0)}%
                              </span>
                              {costFor(d) == null && (
                                <span
                                  className="ml-1 text-[11px] text-muted-foreground"
                                  aria-hidden
                                >
                                  max
                                </span>
                              )}
                            </span>
                          );
                        })()}
                      </TableCell>
                      <TableCell>
                        {d.platform_category_id ? (
                          <span className="text-xs text-muted-foreground">
                            {d.platform_category_id}
                          </span>
                        ) : (
                          <Badge
                            variant="outline"
                            className="border-amber-500/40 bg-amber-500/10 text-[10px] text-amber-700 dark:text-amber-300"
                          >
                            needs category
                          </Badge>
                        )}
                      </TableCell>
                      {/* US-1895: recommended-aspect coverage N/M. */}
                      <TableCell>
                        {(() => {
                          const cov = coverageByItem[d.inventory_item_id];
                          if (!cov || cov.total === 0) {
                            return (
                              <span className="text-xs text-muted-foreground">
                                —
                              </span>
                            );
                          }
                          return (
                            <span
                              className={cn(
                                "text-xs tabular-nums",
                                cov.filled >= cov.total
                                  ? "text-emerald-600 dark:text-emerald-400"
                                  : cov.filled / cov.total < 0.5
                                    ? "text-amber-600 dark:text-amber-400"
                                    : "text-muted-foreground",
                              )}
                              title={
                                cov.missing.length > 0
                                  ? `Missing: ${cov.missing.slice(0, 6).join(", ")}`
                                  : "All recommended specifics filled"
                              }
                            >
                              {cov.filled}/{cov.total}
                            </span>
                          );
                        })()}
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
                              aria-label={`Open the AutoLister batch for ${draftName}`}
                              title="Open this batch (publish all / bulk edit)"
                            >
                              <Layers className="mr-1 h-3 w-3" />
                              Queue
                            </Link>
                          </Button>
                        )}
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center justify-end gap-1">
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-7 px-2"
                            aria-label={`Edit ${draftName}`}
                            title="Edit inline (e)"
                            onClick={(e) => {
                              e.stopPropagation();
                              setActiveIndex(idx);
                              if (isEditing) setEditingId(null);
                              else openEditor(d);
                            }}
                          >
                            <Pencil className="h-3.5 w-3.5" />
                          </Button>
                          <Button asChild size="sm" variant="ghost">
                            <Link
                              to={`/dashboard/flipdesk/items/${d.inventory_item_id}/draft`}
                              onClick={(e) => e.stopPropagation()}
                            >
                              Review
                              <ArrowRight className="ml-1 h-3 w-3" />
                            </Link>
                          </Button>
                        </div>
                      </TableCell>
                    </ClickableRow>
                    {isEditing && (
                      <TableRow data-draft-editor className="bg-muted/40 hover:bg-muted/40">
                        <TableCell colSpan={12} className="py-3">
                          <div className="flex flex-wrap items-end gap-3">
                            <div className="min-w-[16rem] flex-1 space-y-1">
                              <label
                                htmlFor={`edit-title-${d.id}`}
                                className="text-xs font-medium text-muted-foreground"
                              >
                                Title
                              </label>
                              <Input
                                id={`edit-title-${d.id}`}
                                ref={editTitleRef}
                                value={editTitle}
                                onChange={(e) => setEditTitle(e.target.value)}
                                maxLength={80}
                                className="h-9"
                              />
                            </div>
                            <div className="w-32 space-y-1">
                              <label
                                htmlFor={`edit-price-${d.id}`}
                                className="text-xs font-medium text-muted-foreground"
                              >
                                Price ($)
                              </label>
                              <Input
                                id={`edit-price-${d.id}`}
                                type="number"
                                min="0"
                                step="0.01"
                                value={editPrice}
                                onChange={(e) => setEditPrice(e.target.value)}
                                className="h-9 tabular-nums"
                              />
                            </div>
                            <div className="w-32 space-y-1">
                              <label
                                htmlFor={`edit-cost-${d.id}`}
                                className="text-xs font-medium text-muted-foreground"
                              >
                                Cost ($)
                              </label>
                              <Input
                                id={`edit-cost-${d.id}`}
                                type="number"
                                min="0"
                                step="0.01"
                                value={editCost}
                                onChange={(e) => setEditCost(e.target.value)}
                                className="h-9 tabular-nums"
                                placeholder="paid"
                              />
                            </div>
                            <div className="flex items-center gap-2">
                              <Button
                                size="sm"
                                onClick={() => void saveAndNext()}
                                disabled={saving}
                                title="Save & next (Enter)"
                              >
                                {saving ? (
                                  <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                                ) : (
                                  <Check className="mr-1 h-3.5 w-3.5" />
                                )}
                                Save &amp; next
                              </Button>
                              <Button
                                size="sm"
                                variant="ghost"
                                onClick={() => setEditingId(null)}
                                title="Cancel (Esc)"
                              >
                                <X className="mr-1 h-3.5 w-3.5" />
                                Cancel
                              </Button>
                            </div>
                          </div>
                        </TableCell>
                      </TableRow>
                    )}
                    </Fragment>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* US-2817: re-identify the selected drafts. The drafts themselves are
          listings, but the AI writes to the parent inventory item — so the
          refetch has to invalidate the item read too, not just the draft list,
          or a corrected brand would sit in the DB behind a stale title. */}
      <BulkAiEnrichDialog
        open={reidentifyOpen}
        onOpenChange={setReidentifyOpen}
        itemIds={selectedItemIds}
        mode="reidentify"
        onReviewItem={(itemId) =>
          void navigate(`/dashboard/flipdesk/items/${itemId}/draft`)
        }
        onDone={() => {
          void queryClient.invalidateQueries({
            queryKey: ["autolister_drafts"],
          });
          void queryClient.invalidateQueries({
            queryKey: ["autolister_drafts_items"],
          });
          void queryClient.invalidateQueries({ queryKey: ["items_full"] });
        }}
      />
    </div>
  );
}
