import { useMemo, useState } from "react";
import { useSearchParams } from "react-router";
import {
  Search,
  Loader2,
  ExternalLink,
  TrendingUp,
  Sparkles,
  Info,
} from "lucide-react";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import {
  useScoutScan,
  type ScoutBuyingOption,
  type ScoutScanInput,
  type ScoutScored,
  type ScoutSort,
} from "@/hooks/use-scout";
import {
  DEFAULT_SOURCING_TARGET_PCT,
  SourcingTargetSetting,
} from "@/components/flipdesk/sourcing-target-setting";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/hooks/use-auth";
import { useQuery } from "@tanstack/react-query";
import { ForecastCard } from "@/components/flipdesk/forecast-card";
import { PageHeader } from "@/components/ui/page-header";
import { ValueBasisNote } from "@/components/value/value-basis-note";

function dollars(cents: number | null): string {
  if (cents == null) return "—";
  return `$${(cents / 100).toFixed(2)}`;
}

function gradeClasses(grade: number | null): string {
  if (grade == null) return "bg-muted text-muted-foreground";
  if (grade >= 8) return "bg-green-100 text-green-800 dark:bg-green-950/50 dark:text-green-300";
  if (grade >= 6) return "bg-yellow-100 text-yellow-800 dark:bg-yellow-950/50 dark:text-yellow-300";
  return "bg-red-100 text-red-800 dark:bg-red-950/50 dark:text-red-300";
}

type SortKey = "margin" | "grade" | "confidence";

function CandidateRow({ c }: { c: ScoutScored }) {
  return (
    <Card className={cn(c.underpriced && "border-green-300 dark:border-green-800")}>
      <CardContent className="flex gap-4 p-4">
        {c.imageUrl ? (
          <img
            src={c.imageUrl}
            alt={c.title}
            className="h-24 w-24 flex-shrink-0 rounded-md object-cover"
            loading="lazy"
          />
        ) : (
          <div className="flex h-24 w-24 flex-shrink-0 items-center justify-center rounded-md bg-muted text-xs text-muted-foreground">
            No photo
          </div>
        )}

        <div className="min-w-0 flex-1 space-y-2">
          <div className="flex items-start justify-between gap-2">
            <p className="line-clamp-2 text-sm font-medium">{c.title}</p>
            {c.underpriced && (
              <Badge className="flex-shrink-0 bg-green-600 hover:bg-green-600">
                <TrendingUp className="mr-1 h-3 w-3" /> Underpriced
              </Badge>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span className={cn("rounded-full px-2 py-0.5 font-semibold", gradeClasses(c.shadowGrade))}>
              Shadow grade {c.shadowGrade != null ? c.shadowGrade.toFixed(1) : "—"}
            </span>
            {/* US-3098: what the buyer actually pays. Shown only when it
                differs from the asking price, so a free-shipping listing does
                not carry a second identical number. */}
            {c.totalCents != null && c.totalCents !== c.askingCents ? (
              <span className="text-muted-foreground">
                {dollars(c.totalCents)} with shipping
              </span>
            ) : null}
            <span className="text-muted-foreground">
              {Math.round(c.gradeConfidence * 100)}% confidence
            </span>
            {!c.actionable && (
              <Badge variant="outline" className="text-muted-foreground">
                Uncertain
              </Badge>
            )}
          </div>

          <div className="grid grid-cols-3 gap-2 text-sm">
            <div>
              <div className="text-xs text-muted-foreground">Asking</div>
              <div className="font-medium">{dollars(c.askingCents)}</div>
            </div>
            <div>
              <div className="text-xs text-muted-foreground">Est. value</div>
              <div className="font-medium">
                {c.valueMedianCents != null
                  ? `${dollars(c.valueLowCents)}–${dollars(c.valueHighCents)}`
                  : "Insufficient comps"}
              </div>
            </div>
            <div>
              <div className="text-xs text-muted-foreground">Est. margin</div>
              <div
                className={cn(
                  "font-semibold",
                  c.estMarginCents != null && c.estMarginCents > 0
                    ? "text-green-700 dark:text-green-300"
                    : "text-muted-foreground",
                )}
              >
                {c.estMarginCents != null
                  ? `${dollars(c.estMarginCents)}${c.estMarginPct != null ? ` (${Math.round(c.estMarginPct * 100)}%)` : ""}`
                  : "—"}
              </div>
            </div>
          </div>

          {/* US-2850: one line per row, headline only. Two sentences here would
              bury the price in a list a seller scans standing in a shop. */}
          <ValueBasisNote basis={c.valueBasis} variant="short" />

          {/* US-3098: the ceiling — the most to pay and still clear the target.
              Absent for most rows, because sourcingCeiling refuses to produce
              one without a measured curve. Shown only when it resolved; the
              per-row explanation for why it did not would be six identical
              sentences down a list. */}
          {c.ceiling?.maxPriceCents != null ? (
            <p className="text-xs font-medium">
              Pay at most {dollars(c.ceiling.maxPriceCents)} for{" "}
              {Math.round(c.ceiling.targetRoi * 100)}% ROI
            </p>
          ) : null}

          <div className="flex items-center justify-between gap-2">
            <p className="text-xs text-muted-foreground">{c.reason}</p>
            {c.itemWebUrl && (
              <a
                href={c.itemWebUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex flex-shrink-0 items-center gap-1 text-xs font-medium text-primary hover:underline"
              >
                View on eBay <ExternalLink className="h-3 w-3" />
              </a>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

export function FlipdeskScoutPage() {
  // US-1064: community-insights "Source more <brand>" recommendations deep-link
  // here with ?brand=<brand> so the comps scan is prefilled.
  const [searchParams, setSearchParams] = useSearchParams();
  const { user } = useAuth();
  const [keyword, setKeyword] = useState("");
  const [brand, setBrand] = useState(() => searchParams.get("brand") ?? "");
  const [categoryId, setCategoryId] = useState("11450"); // Clothing, Shoes & Accessories
  const [sortKey, setSortKey] = useState<SortKey>("margin");
  const [actionableOnly, setActionableOnly] = useState(false);

  // ── US-3098: the deal filter ────────────────────────────────────────────
  //
  // In the URL, not just in state, so a seller can bookmark "Patagonia under
  // $40 that makes me 40%" and open it next Saturday — which is how sourcing
  // actually works, a handful of searches run over and over.
  const [maxTotal, setMaxTotal] = useState(() => searchParams.get("maxTotal") ?? "");
  const [minMarginPctText, setMinMarginPctText] = useState(
    () => searchParams.get("minMarginPct") ?? "",
  );
  const [minMarginDollars, setMinMarginDollars] = useState(
    () => searchParams.get("minMargin") ?? "",
  );
  const [browseSort, setBrowseSort] = useState<ScoutSort>(
    () => (searchParams.get("sort") as ScoutSort | null) ?? "bestMatch",
  );
  const [buyItNowOnly, setBuyItNowOnly] = useState(
    () => searchParams.get("bin") === "1",
  );
  const [freeShippingOnly, setFreeShippingOnly] = useState(
    () => searchParams.get("freeShip") === "1",
  );
  const [showFilters, setShowFilters] = useState(
    () => Boolean(searchParams.get("maxTotal") ?? searchParams.get("minMarginPct")),
  );

  // The seller's standing target, so a number set once in Buy decision is not
  // typed again here. Read-only: the field below overrides it for this scan.
  const { data: storedTargetPct } = useQuery({
    queryKey: ["sourcing-target", user?.id],
    enabled: Boolean(user?.id),
    queryFn: async () => {
      const { data } = await supabase
        .from("flipdesk_settings")
        .select("sourcing_target_roi_pct")
        .eq("user_id", user?.id ?? "")
        .maybeSingle();
      return (data as { sourcing_target_roi_pct: number | null } | null)
        ?.sourcing_target_roi_pct ?? null;
    },
  });
  const targetPct = storedTargetPct ?? DEFAULT_SOURCING_TARGET_PCT;
  // The URL wins over the standing target: a link someone bookmarked said what
  // it meant, and silently replacing it with an account setting would make the
  // bookmark mean something different on a different day.
  const effectiveMinMarginPct = minMarginPctText.trim() || String(targetPct);

  const scan = useScoutScan();
  const result = scan.data;

  const canSearch = (keyword.trim() || brand.trim()) && categoryId.trim();

  const candidates = useMemo(() => {
    let list = result?.candidates ?? [];
    if (actionableOnly) list = list.filter((c) => c.actionable);
    const sorted = [...list].sort((a, b) => {
      if (sortKey === "margin") return (b.estMarginCents ?? -Infinity) - (a.estMarginCents ?? -Infinity);
      if (sortKey === "grade") return (b.shadowGrade ?? -Infinity) - (a.shadowGrade ?? -Infinity);
      return b.gradeConfidence - a.gradeConfidence;
    });
    return sorted;
  }, [result, actionableOnly, sortKey]);

  /** Dollars typed by a human to integer cents, or undefined for blank. */
  function centsFrom(text: string): number | undefined {
    const value = Number(text.trim());
    if (!text.trim() || !Number.isFinite(value) || value < 0) return undefined;
    return Math.round(value * 100);
  }

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSearch) return;

    // US-3098: mirror the filter into the URL so this scan is a link.
    const next = new URLSearchParams(searchParams);
    const setOrDrop = (key: string, value: string) => {
      if (value) next.set(key, value);
      else next.delete(key);
    };
    setOrDrop("maxTotal", maxTotal.trim());
    setOrDrop("minMarginPct", minMarginPctText.trim());
    setOrDrop("minMargin", minMarginDollars.trim());
    setOrDrop("sort", browseSort === "bestMatch" ? "" : browseSort);
    setOrDrop("bin", buyItNowOnly ? "1" : "");
    setOrDrop("freeShip", freeShippingOnly ? "1" : "");
    setSearchParams(next, { replace: true });

    // minMarginPct is a FRACTION on the wire (0.3 = 30%); the field is typed in
    // whole percent because that is how a seller says it.
    const pct = Number(effectiveMinMarginPct);
    const input: ScoutScanInput = {
      categoryId: categoryId.trim(),
      q: keyword.trim() || undefined,
      brand: brand.trim() || undefined,
      maxTotalCents: centsFrom(maxTotal),
      minMarginCents: centsFrom(minMarginDollars),
      minMarginPct:
        showFilters && Number.isFinite(pct) && pct > 0 ? pct / 100 : undefined,
      buyingOptions: buyItNowOnly
        ? (["FIXED_PRICE", "BEST_OFFER"] as ScoutBuyingOption[])
        : undefined,
      freeShippingOnly: freeShippingOnly || undefined,
      sort: browseSort === "bestMatch" ? undefined : browseSort,
    };
    scan.mutate(input);
  }

  return (
    <div className="mx-auto w-full max-w-4xl space-y-6 p-6">
      <PageHeader
        icon={Sparkles}
        title="ScoutAI"
        subtitle="Find underpriced gems. ScoutAI grades live eBay listings from their own photos and flags the ones priced like they are in worse shape than they are, so you buy low and flip with confidence."
      />

      <Card>
        <CardContent className="p-4">
          <form onSubmit={submit} className="grid gap-3 sm:grid-cols-4">
            <div className="space-y-1 sm:col-span-2">
              <Label htmlFor="scout-keyword">Search</Label>
              <Input
                id="scout-keyword"
                placeholder="e.g. Patagonia Better Sweater"
                value={keyword}
                onChange={(e) => setKeyword(e.target.value)}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="scout-brand">Brand (optional)</Label>
              <Input
                id="scout-brand"
                placeholder="Patagonia"
                value={brand}
                onChange={(e) => setBrand(e.target.value)}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="scout-category">eBay category ID</Label>
              <Input
                id="scout-category"
                value={categoryId}
                onChange={(e) => setCategoryId(e.target.value)}
              />
            </div>
            {/* US-3098: the deal filter. Collapsed by default — a seller who
                just wants to look does not need six more fields between them
                and the button, and one who is hunting a margin opens it once
                and then bookmarks the URL. */}
            <div className="sm:col-span-4">
              <button
                type="button"
                className="text-xs font-medium text-primary hover:underline"
                onClick={() => setShowFilters((open) => !open)}
                aria-expanded={showFilters}
              >
                {showFilters ? "Hide deal filter" : "Deal filter"}
              </button>
            </div>

            {showFilters ? (
              <>
                <div className="space-y-1">
                  <Label htmlFor="scout-max-total">Max I will pay</Label>
                  <Input
                    id="scout-max-total"
                    inputMode="decimal"
                    placeholder="40"
                    value={maxTotal}
                    onChange={(e) => setMaxTotal(e.target.value)}
                  />
                  <p className="text-[11px] text-muted-foreground">
                    Item plus shipping.
                  </p>
                </div>
                <div className="space-y-1">
                  <Label htmlFor="scout-min-margin-pct">Min return</Label>
                  <Input
                    id="scout-min-margin-pct"
                    inputMode="decimal"
                    placeholder={String(targetPct)}
                    value={minMarginPctText}
                    onChange={(e) => setMinMarginPctText(e.target.value)}
                  />
                  <p className="text-[11px] text-muted-foreground">
                    Percent after fees. Blank uses your {targetPct}% target.
                  </p>
                </div>
                <div className="space-y-1">
                  <Label htmlFor="scout-min-margin">Min profit</Label>
                  <Input
                    id="scout-min-margin"
                    inputMode="decimal"
                    placeholder="20"
                    value={minMarginDollars}
                    onChange={(e) => setMinMarginDollars(e.target.value)}
                  />
                  <p className="text-[11px] text-muted-foreground">
                    Dollars after fees.
                  </p>
                </div>
                <div className="space-y-1">
                  <Label htmlFor="scout-browse-sort">Look at</Label>
                  <select
                    id="scout-browse-sort"
                    className="h-9 w-full rounded-md border bg-background px-2 text-sm"
                    value={browseSort}
                    onChange={(e) => setBrowseSort(e.target.value as ScoutSort)}
                  >
                    <option value="bestMatch">Best match</option>
                    <option value="newlyListed">Newly listed</option>
                    <option value="endingSoonest">Ending soonest</option>
                    <option value="priceAsc">Cheapest first</option>
                  </select>
                </div>
                <div className="flex flex-wrap items-center gap-4 sm:col-span-4">
                  <label className="flex items-center gap-2 text-xs">
                    <input
                      type="checkbox"
                      checked={buyItNowOnly}
                      onChange={(e) => setBuyItNowOnly(e.target.checked)}
                    />
                    Buy It Now only (no auctions)
                  </label>
                  <label className="flex items-center gap-2 text-xs">
                    <input
                      type="checkbox"
                      checked={freeShippingOnly}
                      onChange={(e) => setFreeShippingOnly(e.target.checked)}
                    />
                    Free shipping only
                  </label>
                </div>
              </>
            ) : null}

            <div className="sm:col-span-4">
              <Button type="submit" disabled={!canSearch || scan.isPending}>
                {scan.isPending ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <Search className="mr-2 h-4 w-4" />
                )}
                Find deals
              </Button>
              <span className="ml-3 text-xs text-muted-foreground">
                Default category 11450 covers all apparel; narrow it for sharper comps.
              </span>
            </div>
          </form>
        </CardContent>
      </Card>

      {/* Estimate disclaimer (US-620) */}
      <div className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
        <Info className="mt-0.5 h-4 w-4 flex-shrink-0" />
        <span>
          {/* US-3107: the second sentence used to be missing. Values and ROI
              here are computed from ACTIVE listings — asking prices — because
              the Marketplace Insights grant that would make them sold prices has
              not landed. A seller reading "comps" cannot tell the two apart, and
              they price differently. */}
          Shadow grades are private AI estimates from each listing's photos — not
          a GradeThread certificate, and not visible to the seller. Values come
          from active eBay listings, so they are asking prices, not sold prices.
          Always verify condition before buying.
        </span>
      </div>

      {/* US-3098: the standing target the Min return field falls back to, set
          here rather than only on the Buy decision page — a seller who filters
          by it here is the one most likely to want to change it. */}
      {showFilters ? <SourcingTargetSetting /> : null}

      {/* US-1104: longitudinal resale-value & depreciation forecast from the
          reseller's own sale ledger. Seeds the brand from the search above. */}
      <ForecastCard brand={brand.trim() || undefined} />

      {/* Results */}
      {scan.isPending ? (
        <div className="space-y-3">
          <div className="h-32 w-full animate-pulse rounded-lg bg-muted" />
          <div className="h-32 w-full animate-pulse rounded-lg bg-muted" />
        </div>
      ) : scan.isError ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base text-destructive">Scan failed</CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground">
            {scan.error.message} — try again, or adjust your search terms.
          </CardContent>
        </Card>
      ) : result ? (
        result.candidates.length === 0 ? (
          <Card>
            <CardHeader>
              <CardTitle className="text-base">No candidates found</CardTitle>
            </CardHeader>
            <CardContent className="text-sm text-muted-foreground">
              {result.note ?? "No listings matched that search. Try broader terms or a different category."}
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-sm text-muted-foreground">
                {/* US-3098: the denominator. "Graded 8" alone is a number a
                    seller cannot judge; "looked at 42, graded 8" says the scan
                    searched wider than the eight rows in front of them. */}
                {result.considered != null
                  ? `Looked at ${result.considered} listing${result.considered === 1 ? "" : "s"}, graded ${result.graded ?? result.scanned}`
                  : `Scanned ${result.scanned} listing${result.scanned === 1 ? "" : "s"}`}
                {" · "}
                {candidates.length} shown
              </p>
              <div className="flex items-center gap-2 text-xs">
                <label className="flex items-center gap-1">
                  <input
                    type="checkbox"
                    checked={actionableOnly}
                    onChange={(e) => setActionableOnly(e.target.checked)}
                  />
                  Actionable only
                </label>
                <select
                  className="rounded-md border bg-background px-2 py-1"
                  value={sortKey}
                  onChange={(e) => setSortKey(e.target.value as SortKey)}
                  aria-label="Sort candidates"
                >
                  <option value="margin">Sort: margin</option>
                  <option value="grade">Sort: grade</option>
                  <option value="confidence">Sort: confidence</option>
                </select>
              </div>
            </div>
            {candidates.map((c) => (
              <CandidateRow key={c.itemId} c={c} />
            ))}
          </div>
        )
      ) : (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Search to find deals</CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground">
            Enter a keyword and/or brand above. ScoutAI will grade the matching
            listings and rank the best condition-adjusted flips first.
          </CardContent>
        </Card>
      )}
    </div>
  );
}
