import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { Loader2, Tags, TrendingUp } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/ui/page-header";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { useConfirm } from "@/components/ui/confirm-dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { supabase } from "@/lib/supabase";
import { fetchAllPages, READ_PAGE_SIZE } from "@/lib/paged-read";
import {
  useEbayBulkPriceQuantity,
  useEbayConnection,
  type BulkPriceQtyUpdate,
} from "@/hooks/use-ebay";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorState } from "@/components/ui/error-state";

interface BulkRow {
  id: string;
  title: string;
  brand: string | null;
  price: number;
  quantity: number | null;
  listedAt: string | null;
}

// US-2229: reduce drives prices down, increase drives them up, set is absolute.
type PriceMode = "none" | "set" | "reduce" | "increase";
type SortKey = "age_new" | "age_old" | "price_high" | "price_low" | "title";

// US-2229: load every active eBay listing in chunks so a seller past 500 rows
// can still reach and select the rest — no silent truncation.
const FETCH_CHUNK = READ_PAGE_SIZE;
const PAGE_SIZE = 50;

interface RawListingRow {
  id: string;
  listing_title: string | null;
  listing_price: number;
  quantity: number | null;
  listed_at: string | null;
  inventory_items: { brand: string | null } | { brand: string | null }[] | null;
}

function rawBrand(inv: RawListingRow["inventory_items"]): string | null {
  if (!inv) return null;
  return Array.isArray(inv) ? (inv[0]?.brand ?? null) : inv.brand;
}

// US-1046 + US-2229: select active eBay listings and update price and/or
// quantity in one bulk call, with search / filter / sort over the full set.
export function FlipdeskBulkPricingPage() {
  const confirm = useConfirm();
  const { data: connection, isLoading: connLoading } = useEbayConnection();
  const connected = !!connection;

  const {
    data: rows = [],
    isLoading,
    refetch,
    // US-2867: the queryFn throws on a PostgREST error, so without reading
    // `error` here the `rows = []` fallback renders "No active eBay listings"
    // during an outage -- telling a seller with two hundred live listings that
    // they have none. US-436's rule: a failed read is an ErrorState.
    error,
    isFetching,
  } = useQuery({
    queryKey: ["bulk_pricing_listings"],
    enabled: connected,
    queryFn: async (): Promise<BulkRow[]> => {
      // US-2169: this loop used to advance by FETCH_CHUNK and stop on a short
      // page, which silently truncates the moment PostgREST's `db-max-rows` is
      // lower than the chunk. On THIS page that means a bulk markdown quietly
      // skipping listings the seller believes they just repriced. fetchAllPages
      // advances by the rows actually returned and stops only on an empty one.
      const all = await fetchAllPages<RawListingRow>(async (from, to) => {
        const { data, error } = await supabase
          .from("listings")
          .select(
            "id, listing_title, listing_price, quantity, listed_at, platform_offer_id, inventory_items(brand)",
          )
          .eq("platform", "ebay")
          .eq("listing_status", "active")
          .not("platform_offer_id", "is", null)
          .order("listed_at", { ascending: false })
          .range(from, to);
        if (error) throw error;
        return (data ?? []) as unknown as RawListingRow[];
      }, FETCH_CHUNK);
      return all.map((l) => ({
        id: l.id,
        title: l.listing_title || "Untitled listing",
        brand: rawBrand(l.inventory_items),
        price: l.listing_price,
        quantity: l.quantity,
        listedAt: l.listed_at,
      }));
    },
  });

  const bulk = useEbayBulkPriceQuantity();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [priceMode, setPriceMode] = useState<PriceMode>("none");
  const [priceValue, setPriceValue] = useState("");
  const [qtyValue, setQtyValue] = useState("");
  const [roundTo99, setRoundTo99] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});

  // Filter / sort / pagination state.
  const [search, setSearch] = useState("");
  const [brandFilter, setBrandFilter] = useState("all");
  const [minPrice, setMinPrice] = useState("");
  const [maxPrice, setMaxPrice] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("age_new");
  const [page, setPage] = useState(0);

  const brands = useMemo(() => {
    const set = new Set<string>();
    for (const r of rows) if (r.brand) set.add(r.brand);
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [rows]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const min = minPrice.trim() === "" ? null : Number(minPrice);
    const max = maxPrice.trim() === "" ? null : Number(maxPrice);
    const out = rows.filter((r) => {
      if (q && !r.title.toLowerCase().includes(q)) return false;
      if (brandFilter !== "all" && r.brand !== brandFilter) return false;
      if (min != null && Number.isFinite(min) && r.price < min) return false;
      if (max != null && Number.isFinite(max) && r.price > max) return false;
      return true;
    });
    out.sort((a, b) => {
      switch (sortKey) {
        case "price_high":
          return b.price - a.price;
        case "price_low":
          return a.price - b.price;
        case "title":
          return a.title.localeCompare(b.title);
        case "age_old":
          return (a.listedAt ?? "").localeCompare(b.listedAt ?? "");
        case "age_new":
        default:
          return (b.listedAt ?? "").localeCompare(a.listedAt ?? "");
      }
    });
    return out;
  }, [rows, search, brandFilter, minPrice, maxPrice, sortKey]);

  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const safePage = Math.min(page, pageCount - 1);
  const pageRows = filtered.slice(safePage * PAGE_SIZE, safePage * PAGE_SIZE + PAGE_SIZE);

  const allFilteredSelected =
    filtered.length > 0 && filtered.every((r) => selected.has(r.id));

  function resetPage() {
    setPage(0);
  }

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  // US-2229: select-all acts on the whole FILTERED set, not just the visible
  // page, so a "select all under $20" bulk action selects every match.
  function toggleAllFiltered() {
    setSelected((prev) => {
      const next = new Set(prev);
      if (allFilteredSelected) {
        for (const r of filtered) next.delete(r.id);
      } else {
        for (const r of filtered) next.add(r.id);
      }
      return next;
    });
  }

  const qtyNum = qtyValue.trim() === "" ? undefined : Number(qtyValue);
  const priceNum = priceValue.trim() === "" ? undefined : Number(priceValue);
  const isPct = priceMode === "reduce" || priceMode === "increase";
  // A reduce percent outside 1–99 would drive computed prices to $0 or below; an
  // increase just needs a positive percent.
  const percentInvalid =
    isPct &&
    priceNum != null &&
    Number.isFinite(priceNum) &&
    (priceMode === "reduce" ? priceNum < 1 || priceNum > 99 : priceNum < 1);
  const priceActive =
    priceMode !== "none" &&
    priceNum != null &&
    Number.isFinite(priceNum) &&
    priceNum > 0 &&
    !percentInvalid;
  const qtyActive = qtyNum != null && Number.isInteger(qtyNum) && qtyNum >= 0;
  const canApply = selected.size > 0 && (priceActive || qtyActive) && !bulk.isPending;

  // Round to the nearest .99 when the seller opts in (psychological pricing).
  function applyRounding(p: number): number {
    if (!roundTo99) return Number(p.toFixed(2));
    return Math.max(0.99, Math.round(p) - 0.01);
  }

  /// Resolve the target price for a row given the chosen mode.
  function targetPrice(row: BulkRow): number | undefined {
    if (!priceActive || priceNum == null) return undefined;
    let p: number;
    if (priceMode === "set") p = priceNum;
    else if (priceMode === "reduce") p = row.price * (1 - priceNum / 100);
    else p = row.price * (1 + priceNum / 100); // increase
    return applyRounding(p);
  }

  async function apply() {
    const updates: BulkPriceQtyUpdate[] = [];
    for (const row of rows) {
      if (!selected.has(row.id)) continue;
      const price = targetPrice(row);
      const quantity = qtyActive ? qtyNum : undefined;
      if (price == null && quantity == null) continue;
      updates.push({ listing_id: row.id, price, quantity });
    }
    if (updates.length === 0) return;

    const priceOp = !priceActive || priceNum == null
      ? null
      : priceMode === "set"
        ? `set the price to $${priceNum.toFixed(2)}`
        : priceMode === "reduce"
          ? `reduce the price by ${priceNum}%`
          : `increase the price by ${priceNum}%`;
    const qtyOp = qtyActive ? `set quantity to ${qtyNum}` : null;
    const roundOp = priceActive && roundTo99 ? "round to .99" : null;
    const op = [priceOp, roundOp, qtyOp].filter(Boolean).join(", ");
    const ok = await confirm({
      title: `Apply changes to ${updates.length} listing${updates.length === 1 ? "" : "s"}?`,
      description: `This will ${op} on ${updates.length} live eBay listing${updates.length === 1 ? "" : "s"} immediately.`,
      confirmLabel: "Apply changes",
    });
    if (!ok) return;

    try {
      const res = await bulk.mutateAsync({ updates });
      const failed = res.results.filter((r) => !r.ok);
      setErrors(Object.fromEntries(failed.map((r) => [r.listing_id, r.error ?? "Failed"])));
      if (failed.length === 0) {
        toast.success(`Updated ${res.succeeded} listing${res.succeeded === 1 ? "" : "s"}.`);
        setSelected(new Set());
      } else {
        toast.warning(`Updated ${res.succeeded}/${res.total}. ${failed.length} failed.`);
      }
      await refetch();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Bulk update failed.");
    }
  }

  const previewPrice = useMemo(() => {
    if (!priceActive || priceNum == null) return null;
    const base =
      priceMode === "set"
        ? `Set price to $${priceNum.toFixed(2)}`
        : priceMode === "reduce"
          ? `Reduce price by ${priceNum}%`
          : `Increase price by ${priceNum}%`;
    return roundTo99 ? `${base}, rounded to .99` : base;
  }, [priceActive, priceMode, priceNum, roundTo99]);

  if (connLoading) {
    return (
      <div className="mx-auto max-w-4xl space-y-4 p-2">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }
  if (!connected) {
    return (
      <div className="mx-auto max-w-4xl space-y-3 py-12 text-center">
        <h2 className="text-xl font-semibold">Bulk pricing</h2>
        <p className="text-sm text-muted-foreground">
          Connect your eBay account to bulk-update listing prices and quantities.
        </p>
        <Button asChild variant="outline">
          <a href="/dashboard/flipdesk/marketplaces">Go to Marketplaces</a>
        </Button>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <PageHeader
          title="Bulk pricing"
          subtitle="Select active eBay listings and update their price and/or quantity in one go. Changes push straight to eBay."
        />
        <Button asChild variant="outline" size="sm">
          <a href="/dashboard/flipdesk/pricing?tab=repricing">
            <TrendingUp className="mr-2 h-4 w-4" />
            Condition-aware repricing
          </a>
        </Button>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Tags className="h-4 w-4" />
            Apply to {selected.size} selected
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap items-end gap-3">
            <div className="space-y-1">
              <Label htmlFor="bulk-price-mode">Price</Label>
              <Select value={priceMode} onValueChange={(v) => setPriceMode(v as PriceMode)}>
                <SelectTrigger className="w-40" id="bulk-price-mode">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">No change</SelectItem>
                  <SelectItem value="set">Set price to…</SelectItem>
                  <SelectItem value="reduce">Reduce by %…</SelectItem>
                  <SelectItem value="increase">Increase by %…</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {priceMode !== "none" && (
              <div className="space-y-1">
                <Label htmlFor="bulk-price-amount">
                  {priceMode === "set" ? "New price ($)" : "Percent (%)"}
                </Label>
                <Input
                  id="bulk-price-amount"
                  type="number"
                  min={priceMode === "set" ? 0.01 : 1}
                  max={priceMode === "reduce" ? 99 : undefined}
                  step={priceMode === "set" ? 0.5 : 1}
                  value={priceValue}
                  onChange={(e) => {
                    let v = e.target.value;
                    // A reduce >99% would produce a $0/negative price — clamp it.
                    if (priceMode === "reduce" && v !== "" && Number(v) > 99) v = "99";
                    setPriceValue(v);
                  }}
                  className="w-32"
                  aria-invalid={percentInvalid || undefined}
                />
                {percentInvalid && (
                  <p className="text-xs text-destructive">
                    {priceMode === "reduce"
                      ? "Enter a percentage between 1 and 99."
                      : "Enter a percentage of 1 or more."}
                  </p>
                )}
              </div>
            )}
            <div className="space-y-1">
              <Label htmlFor="bp-set-quantity-optional">Set quantity (optional)</Label>
              <Input id="bp-set-quantity-optional"
                type="number"
                min={0}
                step={1}
                value={qtyValue}
                onChange={(e) => setQtyValue(e.target.value)}
                placeholder="—"
                className="w-32"
              />
            </div>
            <Button onClick={apply} disabled={!canApply}>
              {bulk.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
              Apply
            </Button>
          </div>
          {priceMode !== "none" && (
            <div className="flex w-fit items-center gap-2">
              <Checkbox
                id="round-to-99"
                checked={roundTo99}
                onCheckedChange={(v) => setRoundTo99(v === true)}
              />
              <Label htmlFor="round-to-99" className="text-sm text-muted-foreground">
                Round to nearest .99
              </Label>
            </div>
          )}
          {(previewPrice || qtyActive) && (
            <p className="text-xs text-muted-foreground">
              {[previewPrice, qtyActive ? `Set quantity to ${qtyNum}` : null]
                .filter(Boolean)
                .join(" · ")}
            </p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="space-y-3">
          <CardTitle className="flex items-center justify-between text-base">
            <span>Active eBay listings</span>
            {filtered.length > 0 && (
              <button
                type="button"
                onClick={toggleAllFiltered}
                className="text-sm font-normal text-muted-foreground hover:underline"
              >
                {allFilteredSelected
                  ? "Clear selection"
                  : `Select all ${filtered.length} filtered`}
              </button>
            )}
          </CardTitle>
          <div className="flex flex-wrap items-end gap-2">
            <div className="min-w-[12rem] flex-1 space-y-1">
              <Label htmlFor="bp-search-title" className="text-xs">Search title</Label>
              <Input id="bp-search-title"
                value={search}
                onChange={(e) => {
                  setSearch(e.target.value);
                  resetPage();
                }}
                placeholder="Search…"
                className="h-9"
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs" htmlFor="bulk-price-brand-filter">Brand</Label>
              <Select
                value={brandFilter}
                onValueChange={(v) => {
                  setBrandFilter(v);
                  resetPage();
                }}
              >
                <SelectTrigger className="h-9 w-40" id="bulk-price-brand-filter">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All brands</SelectItem>
                  {brands.map((b) => (
                    <SelectItem key={b} value={b}>
                      {b}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label htmlFor="bp-min" className="text-xs">Min $</Label>
              <Input id="bp-min"
                type="number"
                min={0}
                value={minPrice}
                onChange={(e) => {
                  setMinPrice(e.target.value);
                  resetPage();
                }}
                className="h-9 w-20"
                placeholder="—"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="bp-max" className="text-xs">Max $</Label>
              <Input id="bp-max"
                type="number"
                min={0}
                value={maxPrice}
                onChange={(e) => {
                  setMaxPrice(e.target.value);
                  resetPage();
                }}
                className="h-9 w-20"
                placeholder="—"
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs" htmlFor="bulk-price-sort">Sort</Label>
              <Select value={sortKey} onValueChange={(v) => setSortKey(v as SortKey)}>
                <SelectTrigger className="h-9 w-40" id="bulk-price-sort">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="age_new">Newest first</SelectItem>
                  <SelectItem value="age_old">Oldest first</SelectItem>
                  <SelectItem value="price_high">Price: high to low</SelectItem>
                  <SelectItem value="price_low">Price: low to high</SelectItem>
                  <SelectItem value="title">Title A–Z</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-1">
          {isLoading ? (
            <Skeleton className="h-40 w-full" />
          ) : error ? (
            <ErrorState
              title="Couldn't load your listings"
              description={(error as Error).message}
              onRetry={() => refetch()}
              retrying={isFetching}
            />
          ) : rows.length === 0 ? (
            <EmptyState
              icon={Tags}
              title="No active eBay listings"
              description="Bulk pricing works on listings that are already live on eBay. Publish something and it will show up here."
              action={{
                label: "Open your inventory",
                to: "/dashboard/flipdesk/inventory",
              }}
            />
          ) : filtered.length === 0 ? (
            // US-2867: a different sentence and a different action. Telling a
            // seller with two hundred live listings to go and publish one is
            // wrong, and it is what the zero-data state above says.
            <EmptyState
              icon={Tags}
              title="No listings match your filters"
              description="You have active listings, none of them matching what you have selected."
              secondaryAction={{
                label: "Clear filters",
                // ALL of them, not just the brand. A "clear filters" that
                // leaves a price range set is worse than none: the list stays
                // empty and the button now looks broken.
                onClick: () => {
                  setSearch("");
                  setBrandFilter("all");
                  setMinPrice("");
                  setMaxPrice("");
                  resetPage();
                },
              }}
            />
          ) : (
            <>
              {pageRows.map((row) => (
                <div
                  key={row.id}
                  className="flex items-center gap-3 rounded-md border p-2"
                >
                  <Checkbox
                    aria-label={`Select ${row.title}`}
                    checked={selected.has(row.id)}
                    onCheckedChange={() => toggle(row.id)}
                  />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{row.title}</p>
                    {row.brand && (
                      <p className="truncate text-xs text-muted-foreground">
                        {row.brand}
                      </p>
                    )}
                    {errors[row.id] && (
                      <p className="truncate text-xs text-destructive">{errors[row.id]}</p>
                    )}
                  </div>
                  <Badge variant="secondary">${row.price.toFixed(2)}</Badge>
                  {row.quantity != null && (
                    <span className="text-xs text-muted-foreground">qty {row.quantity}</span>
                  )}
                </div>
              ))}
              {pageCount > 1 && (
                <div className="flex items-center justify-between pt-2 text-sm">
                  <span className="text-muted-foreground">
                    {safePage * PAGE_SIZE + 1}–
                    {Math.min(filtered.length, safePage * PAGE_SIZE + PAGE_SIZE)} of{" "}
                    {filtered.length}
                  </span>
                  <div className="flex gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={safePage === 0}
                      onClick={() => setPage(safePage - 1)}
                    >
                      Previous
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={safePage >= pageCount - 1}
                      onClick={() => setPage(safePage + 1)}
                    >
                      Next
                    </Button>
                  </div>
                </div>
              )}
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
