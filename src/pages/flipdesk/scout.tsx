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
  type ScoutScored,
} from "@/hooks/use-scout";
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
  const [searchParams] = useSearchParams();
  const [keyword, setKeyword] = useState("");
  const [brand, setBrand] = useState(() => searchParams.get("brand") ?? "");
  const [categoryId, setCategoryId] = useState("11450"); // Clothing, Shoes & Accessories
  const [sortKey, setSortKey] = useState<SortKey>("margin");
  const [actionableOnly, setActionableOnly] = useState(false);

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

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSearch) return;
    scan.mutate({
      categoryId: categoryId.trim(),
      q: keyword.trim() || undefined,
      brand: brand.trim() || undefined,
    });
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
          Shadow grades are private AI estimates from each listing's photos — not
          a GradeThread certificate, and not visible to the seller. Always verify
          condition before buying.
        </span>
      </div>

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
                Scanned {result.scanned} listing{result.scanned === 1 ? "" : "s"} ·{" "}
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
