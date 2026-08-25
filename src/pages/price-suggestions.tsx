import { useMemo } from "react";
import { Link } from "react-router";
import {
  Lightbulb,
  TrendingDown,
  TrendingUp,
  Clock,
  Minus,
  RefreshCw,
  Check,
  X,
  Loader2,
  ExternalLink,
} from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import { QueryBoundary } from "@/components/ui/query-boundary";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { cn } from "@/lib/utils";
import {
  useRepricingSuggestions,
  useScanRepricing,
  useApplyReprice,
  useDismissReprice,
  type ReasonCode,
  type RepriceSuggestion,
} from "@/hooks/use-repricing";
import { Term } from "@/components/help/term";

// US-2159: Price Suggestions now reads the ONE server pricing engine
// (/api/flipdesk/pricing/suggestions) — comp-driven, with reason codes — the same
// source the Repricing page uses, so the two screens can no longer compute
// different numbers from different data ("two engines that disagree").
//
// The old client-side heuristic (src/lib/price-suggestions.ts:
// calculateSuggestedPrice — own-sales-history comps × grade-tier multipliers ×
// fixed time-based % cuts) is retired. Deliberately DROPPED with it, and noted on
// the story: (a) suggestions for UNLISTED inventory — the server scans active
// listings against live comps, so items not yet listed have no comp-driven
// signal; and (b) the client-only "days listed" column. Staleness itself is not
// lost — it survives as the server's STALE reason code.

function money(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

const REASON_META: Record<
  ReasonCode,
  { label: string; icon: typeof TrendingUp; classes: string }
> = {
  UNDERPRICED: {
    label: "Underpriced",
    icon: TrendingUp,
    classes: "border-green-200 text-green-700 dark:text-green-300",
  },
  OVERPRICED: {
    label: "Overpriced",
    icon: TrendingDown,
    classes: "border-amber-200 text-amber-700 dark:text-amber-300",
  },
  STALE: {
    label: "Stale",
    icon: Clock,
    classes: "border-orange-200 text-orange-700 dark:text-orange-300",
  },
  OK: { label: "OK", icon: Minus, classes: "text-muted-foreground" },
  NO_COMPS: { label: "No comps", icon: X, classes: "text-muted-foreground" },
};

function changePercent(s: RepriceSuggestion): number | null {
  if (s.current_price_cents <= 0) return null;
  return Math.round(
    ((s.suggested_price_cents - s.current_price_cents) / s.current_price_cents) * 100,
  );
}

function SuggestionActions({ s }: { s: RepriceSuggestion }) {
  const confirm = useConfirm();
  const apply = useApplyReprice();
  const dismiss = useDismissReprice();
  // No comps / already-OK → nothing to apply; the row still renders (AC5).
  const canApply = s.reason_code !== "NO_COMPS" && s.reason_code !== "OK";

  async function onApply() {
    const ok = await confirm({
      title: "Apply this new price?",
      description: `Reprice "${s.inventory_items?.title ?? "this item"}" from ${money(
        s.current_price_cents,
      )} to ${money(s.suggested_price_cents)}. This updates the live eBay listing.`,
      confirmLabel: "Apply new price",
    });
    if (ok) apply.mutate(s.id);
  }

  return (
    <div className="flex justify-end gap-1">
      {canApply && (
        <Button
          size="sm"
          variant="outline"
          className="h-8"
          disabled={apply.isPending}
          onClick={onApply}
          aria-label="Apply suggested price"
        >
          {apply.isPending ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Check className="h-3.5 w-3.5" />
          )}
        </Button>
      )}
      <Button
        size="sm"
        variant="ghost"
        className="h-8"
        disabled={dismiss.isPending}
        aria-label="Dismiss suggestion"
        onClick={() =>
          dismiss.mutate(s.id, {
            onSuccess: () => toast.success("Suggestion dismissed."),
          })
        }
      >
        <X className="h-3.5 w-3.5" />
      </Button>
    </div>
  );
}

export function PriceSuggestionsPage() {
  const {
    data: suggestions = [],
    isLoading,
    isError,
    isFetching,
    refetch,
  } = useRepricingSuggestions();
  const scan = useScanRepricing();

  const counts = useMemo(() => {
    let raise = 0;
    let lower = 0;
    for (const s of suggestions) {
      if (s.reason_code === "UNDERPRICED") raise++;
      else if (s.reason_code === "OVERPRICED" || s.reason_code === "STALE") lower++;
    }
    return { raise, lower };
  }, [suggestions]);

  if (isLoading) {
    return (
      <div className="space-y-6">
        <div>
          <Skeleton className="h-8 w-64" />
          <Skeleton className="mt-2 h-4 w-96" />
        </div>
        <div className="grid gap-4 sm:grid-cols-3">
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-24 w-full" />
        </div>
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <PageHeader
          title="Price Suggestions"
          subtitle={
            <>
              <Term name="Comp" />-driven pricing from the shared repricing
              engine, the same numbers as the Repricing page, matched to each
              item's grade.
            </>
          }
        />
        <Button onClick={() => scan.mutate(undefined)} disabled={scan.isPending}>
          {scan.isPending ? (
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          ) : (
            <RefreshCw className="mr-2 h-4 w-4" />
          )}
          Scan now
        </Button>
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Suggestions</CardDescription>
            <CardTitle className="text-2xl">{suggestions.length}</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-xs text-muted-foreground">
              Active listings scanned against condition-matched comps
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Room to raise</CardDescription>
            <CardTitle className="text-2xl text-green-600 dark:text-green-400">
              {counts.raise}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-xs text-muted-foreground">
              Underpriced vs comparable sold-condition listings
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Consider lowering</CardDescription>
            <CardTitle className="text-2xl text-amber-600 dark:text-amber-400">
              {counts.lower}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-xs text-muted-foreground">
              Overpriced or stale listings that may need a nudge
            </p>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Lightbulb className="h-4 w-4" />
            Recommendations
          </CardTitle>
          <CardDescription>
            Apply a suggested price or dismiss it. Comps are active asking prices,
            so real sales usually land lower.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <QueryBoundary
            isLoading={false}
            isError={isError}
            isEmpty={suggestions.length === 0}
            onRetry={() => refetch()}
            isRetrying={isFetching}
            errorProps={{
              title: "Couldn't load price suggestions",
              description:
                "Something went wrong while loading your pricing recommendations. This is usually temporary.",
            }}
            empty={
              <div className="py-12 text-center">
                <Lightbulb className="mx-auto h-12 w-12 text-muted-foreground/40" />
                <h3 className="mt-4 text-lg font-medium">No suggestions yet</h3>
                <p className="mt-1 text-sm text-muted-foreground">
                  Run a scan to check your active listings against
                  condition-matched comps.
                </p>
              </div>
            }
          >
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Signal</TableHead>
                    <TableHead>Item</TableHead>
                    <TableHead>Grade</TableHead>
                    <TableHead className="text-right">Current</TableHead>
                    <TableHead className="text-right">Suggested</TableHead>
                    <TableHead className="text-right">Change</TableHead>
                    <TableHead>Comps</TableHead>
                    <TableHead className="text-right">Action</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {suggestions.map((s) => {
                    const meta = REASON_META[s.reason_code] ?? REASON_META.OK;
                    const Icon = meta.icon;
                    const change = changePercent(s);
                    return (
                      <TableRow key={s.id}>
                        <TableCell>
                          <Badge variant="outline" className={cn("gap-1", meta.classes)}>
                            <Icon className="h-3.5 w-3.5" />
                            {meta.label}
                          </Badge>
                        </TableCell>
                        <TableCell>
                          <Link
                            to={`/dashboard/inventory/${s.inventory_item_id}`}
                            className="block hover:underline"
                          >
                            <p className="font-medium">
                              {s.inventory_items?.title ?? "Untitled item"}
                            </p>
                            <p className="text-xs text-muted-foreground">
                              {s.inventory_items?.brand ?? "—"}
                            </p>
                          </Link>
                        </TableCell>
                        <TableCell>
                          {s.inventory_items?.grade_value != null ? (
                            <Badge variant="outline">
                              {s.inventory_items.grade_value.toFixed(1)}
                            </Badge>
                          ) : (
                            <span className="text-xs text-muted-foreground">N/A</span>
                          )}
                        </TableCell>
                        <TableCell className="text-right">
                          {money(s.current_price_cents)}
                        </TableCell>
                        <TableCell className="text-right font-medium">
                          {s.reason_code === "NO_COMPS"
                            ? "—"
                            : money(s.suggested_price_cents)}
                        </TableCell>
                        <TableCell className="text-right">
                          {change !== null && s.reason_code !== "NO_COMPS" ? (
                            <span
                              className={cn(
                                "inline-flex items-center gap-1 text-sm font-medium",
                                change > 0
                                  ? "text-green-600 dark:text-green-400"
                                  : "text-red-600 dark:text-red-400",
                              )}
                            >
                              {change > 0 ? (
                                <TrendingUp className="h-3 w-3" />
                              ) : (
                                <TrendingDown className="h-3 w-3" />
                              )}
                              {change > 0 ? "+" : ""}
                              {change}%
                            </span>
                          ) : (
                            <span className="text-xs text-muted-foreground">—</span>
                          )}
                        </TableCell>
                        <TableCell>
                          <span className="text-xs text-muted-foreground">
                            {s.comp_count} comps
                            {s.comp_median_cents != null &&
                              ` · med ${money(s.comp_median_cents)}`}
                            {s.listings?.listing_url && (
                              <a
                                href={s.listings.listing_url}
                                target="_blank"
                                rel="noreferrer"
                                className="ml-1 inline-flex items-center text-brand-navy hover:underline dark:text-foreground"
                              >
                                <ExternalLink className="h-3 w-3" />
                              </a>
                            )}
                          </span>
                        </TableCell>
                        <TableCell>
                          <SuggestionActions s={s} />
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          </QueryBoundary>
        </CardContent>
      </Card>
    </div>
  );
}
