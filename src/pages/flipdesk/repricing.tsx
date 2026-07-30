import { useEffect, useMemo, useState } from "react";
import {
  TrendingUp,
  TrendingDown,
  Clock,
  RefreshCw,
  Check,
  X,
  ExternalLink,
  Loader2,
  ChevronLeft,
  ChevronRight,
} from "lucide-react";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { ErrorState } from "@/components/ui/error-state";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { cn } from "@/lib/utils";
import {
  useRepricingSuggestions,
  useScanRepricing,
  useApplyReprice,
  useBulkRepriceApply,
  useDismissReprice,
  type ReasonCode,
  type RepriceSuggestion,
} from "@/hooks/use-repricing";

// US-2171: the queue can carry dozens of nudges. Paginate the client-side list
// so the page renders a bounded slice, and let the reseller filter/sort/bulk-act
// on the whole queue instead of one Apply click per row.
const PAGE_SIZE = 20;

// The reason codes a nudge can actually carry as an actionable suggestion. OK /
// NO_COMPS never reach the queue, so they're not offered as filters.
const FILTERABLE_REASONS: ReasonCode[] = ["UNDERPRICED", "OVERPRICED", "STALE"];

type ReasonFilter = ReasonCode | "ALL";
type SortKey = "delta_desc" | "delta_asc";

// Signed price delta in cents (positive = a raise, negative = a drop).
function repriceDelta(s: RepriceSuggestion): number {
  return s.suggested_price_cents - s.current_price_cents;
}

const REASON_META: Record<
  ReasonCode,
  { label: string; icon: typeof TrendingUp; classes: string }
> = {
  UNDERPRICED: {
    label: "Underpriced",
    icon: TrendingUp,
    classes: "bg-green-100 text-green-800 border-green-200 dark:bg-green-950/50 dark:text-green-300 dark:border-green-800",
  },
  OVERPRICED: {
    label: "Overpriced",
    icon: TrendingDown,
    classes: "bg-amber-100 text-amber-800 border-amber-200 dark:bg-amber-950/50 dark:text-amber-300 dark:border-amber-800",
  },
  STALE: {
    label: "Stale",
    icon: Clock,
    classes: "bg-orange-100 text-orange-800 border-orange-200 dark:bg-orange-950/50 dark:text-orange-300 dark:border-orange-800",
  },
  OK: { label: "OK", icon: Check, classes: "bg-muted text-muted-foreground" },
  NO_COMPS: { label: "No comps", icon: X, classes: "bg-muted text-muted-foreground" },
};

function money(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

function SuggestionRow({
  s,
  selected,
  onToggleSelect,
}: {
  s: RepriceSuggestion;
  selected: boolean;
  onToggleSelect: (id: string) => void;
}) {
  const confirm = useConfirm();
  const apply = useApplyReprice();
  const dismiss = useDismissReprice();
  const meta = REASON_META[s.reason_code] ?? REASON_META.OK;
  const Icon = meta.icon;
  const up = s.suggested_price_cents >= s.current_price_cents;

  async function onApply() {
    const ok = await confirm({
      title: "Apply this new price?",
      description: `Reprice "${s.inventory_items?.title ?? "this item"}" from ${money(
        s.current_price_cents,
      )} to ${money(s.suggested_price_cents)}. This updates the live eBay listing.`,
      confirmLabel: "Apply new price",
    });
    if (!ok) return;
    apply.mutate(s.id);
  }

  return (
    <Card>
      <CardContent className="flex flex-col gap-3 pt-6 sm:flex-row sm:items-center sm:justify-between">
        <Checkbox
          checked={selected}
          onCheckedChange={() => onToggleSelect(s.id)}
          aria-label={`Select ${s.inventory_items?.title ?? "item"} for bulk repricing`}
          className="mt-1 sm:mt-0"
        />
        <div className="min-w-0 flex-1 space-y-1.5">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="outline" className={cn("gap-1", meta.classes)}>
              <Icon className="h-3.5 w-3.5" />
              {meta.label}
            </Badge>
            {s.inventory_items?.grade_label && (
              <Badge variant="outline" className="text-xs">
                {s.inventory_items.grade_label}
                {s.inventory_items.grade_value != null &&
                  ` · ${s.inventory_items.grade_value.toFixed(1)}`}
              </Badge>
            )}
            <span className="truncate font-medium">
              {s.inventory_items?.title ?? "Untitled item"}
            </span>
          </div>
          <p className="text-sm text-muted-foreground">{s.message}</p>
          <div className="flex items-center gap-2 text-sm">
            <span className="text-muted-foreground line-through">
              {money(s.current_price_cents)}
            </span>
            <span className={cn("font-semibold", up ? "text-green-600 dark:text-green-400" : "text-amber-600 dark:text-amber-400")}>
              {money(s.suggested_price_cents)}
            </span>
            <span className="text-xs text-muted-foreground">
              · {s.comp_count} comps
              {s.comp_median_cents != null && ` · median ${money(s.comp_median_cents)}`}
            </span>
            {s.listings?.listing_url && (
              <a
                href={s.listings.listing_url}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 text-xs text-brand-navy hover:underline dark:text-foreground"
              >
                <ExternalLink className="h-3 w-3" />
                view
              </a>
            )}
          </div>
        </div>
        <div className="flex flex-shrink-0 gap-2">
          <Button
            size="sm"
            onClick={onApply}
            disabled={apply.isPending}
          >
            {apply.isPending ? (
              <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
            ) : (
              <Check className="mr-1.5 h-4 w-4" />
            )}
            Apply
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() =>
              dismiss.mutate(s.id, {
                onSuccess: () => toast.success("Suggestion dismissed."),
              })
            }
            disabled={dismiss.isPending}
          >
            <X className="h-4 w-4" />
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

export function FlipdeskRepricingPage() {
  const {
    data: suggestions = [],
    isLoading,
    isError,
    refetch,
    isFetching,
  } = useRepricingSuggestions();
  const scan = useScanRepricing();
  const bulkApply = useBulkRepriceApply();
  const confirm = useConfirm();

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [reason, setReason] = useState<ReasonFilter>("ALL");
  const [sort, setSort] = useState<SortKey>("delta_desc");
  const [page, setPage] = useState(0);

  // Filter by reason, then sort by the magnitude of the suggested change so the
  // biggest moves lead — sign is shown per row, so ranking by absolute delta
  // answers "where does acting change the most money".
  const filtered = useMemo(() => {
    const rows =
      reason === "ALL"
        ? suggestions
        : suggestions.filter((s) => s.reason_code === reason);
    return [...rows].sort((a, b) => {
      const diff = Math.abs(repriceDelta(b)) - Math.abs(repriceDelta(a));
      return sort === "delta_desc" ? diff : -diff;
    });
  }, [suggestions, reason, sort]);

  // A changed filter/sort can shrink the list below the current page — clamp.
  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const safePage = Math.min(page, pageCount - 1);
  const pageRows = filtered.slice(safePage * PAGE_SIZE, safePage * PAGE_SIZE + PAGE_SIZE);

  useEffect(() => {
    setPage(0);
  }, [reason, sort]);

  const filteredIds = filtered.map((s) => s.id);
  const allFilteredSelected =
    filteredIds.length > 0 && filteredIds.every((id) => selected.has(id));
  const selectedCount = filtered.filter((s) => selected.has(s.id)).length;

  function toggleSelect(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleSelectAllFiltered() {
    setSelected((prev) => {
      if (filteredIds.every((id) => prev.has(id))) {
        const next = new Set(prev);
        filteredIds.forEach((id) => next.delete(id));
        return next;
      }
      return new Set([...prev, ...filteredIds]);
    });
  }

  // Bulk apply, cents-safe: reuse useBulkRepriceApply (US-962), whose payload is
  // already {listing_id, price_cents} — no unit conversion, no per-row round trip.
  async function applyRows(rows: RepriceSuggestion[]) {
    if (rows.length === 0) return;
    const ok = await confirm({
      title: `Apply ${rows.length} new price${rows.length === 1 ? "" : "s"}?`,
      description:
        `This updates ${rows.length} live eBay listing${rows.length === 1 ? "" : "s"} to their ` +
        `condition-matched suggested prices. Rows below the margin floor or with no ` +
        `comps are skipped server-side.`,
      confirmLabel: "Apply prices",
    });
    if (!ok) return;
    const items = rows.map((s) => ({
      listing_id: s.listing_id,
      price_cents: s.suggested_price_cents,
    }));
    bulkApply.mutate(items, {
      onSuccess: (res) => {
        setSelected(new Set());
        const parts = [`${res.applied} applied`];
        if (res.skipped.length) parts.push(`${res.skipped.length} skipped`);
        if (res.errors.length) parts.push(`${res.errors.length} failed`);
        toast.success(`Repricing: ${parts.join(" · ")}.`);
      },
    });
  }

  const hasSuggestions = suggestions.length > 0;

  return (
    <div className="mx-auto w-full max-w-4xl space-y-6 p-6">
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-1">
          <h1 className="text-2xl font-bold">Repricing</h1>
          <p className="text-muted-foreground">
            Condition-aware price nudges. We compare each active listing against
            comps matched to its grade — so a grade-9 isn't priced like a grade-6.
          </p>
          {/* US-460: comps are active asking prices, not sold prices. */}
          <p className="text-xs text-muted-foreground">
            Comps are <strong>active</strong> asking prices, not sold prices —
            real sale prices are usually lower, so nudges trend toward a ceiling.
          </p>
        </div>
        <Button onClick={() => scan.mutate(undefined)} disabled={scan.isPending}>
          {scan.isPending ? (
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          ) : (
            <RefreshCw className="mr-2 h-4 w-4" />
          )}
          Scan now
        </Button>
      </div>

      {/* US-2171: queue controls — filter, sort, bulk select + apply. */}
      {hasSuggestions && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border bg-muted/30 p-2">
          <Checkbox
            checked={allFilteredSelected}
            onCheckedChange={toggleSelectAllFiltered}
            aria-label="Select all shown suggestions"
          />
          <span className="text-sm text-muted-foreground">
            {selectedCount > 0 ? `${selectedCount} selected` : `${filtered.length} nudges`}
          </span>
          <Select value={reason} onValueChange={(v) => setReason(v as ReasonFilter)}>
            <SelectTrigger className="h-8 w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="ALL">All reasons</SelectItem>
              {FILTERABLE_REASONS.map((r) => (
                <SelectItem key={r} value={r}>
                  {REASON_META[r].label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={sort} onValueChange={(v) => setSort(v as SortKey)}>
            <SelectTrigger className="h-8 w-44">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="delta_desc">Biggest change first</SelectItem>
              <SelectItem value="delta_asc">Smallest change first</SelectItem>
            </SelectContent>
          </Select>
          <div className="ml-auto flex gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={selectedCount === 0 || bulkApply.isPending}
              onClick={() => applyRows(filtered.filter((s) => selected.has(s.id)))}
            >
              {bulkApply.isPending ? (
                <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
              ) : (
                <Check className="mr-1.5 h-4 w-4" />
              )}
              Apply selected
            </Button>
            <Button
              size="sm"
              disabled={filtered.length === 0 || bulkApply.isPending}
              onClick={() => applyRows(filtered)}
            >
              Apply all ({filtered.length})
            </Button>
          </div>
        </div>
      )}

      {isError ? (
        <ErrorState
          title="Couldn't load repricing suggestions"
          onRetry={() => refetch()}
          retrying={isFetching}
        />
      ) : isLoading ? (
        <div className="space-y-3">
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-24 w-full" />
        </div>
      ) : suggestions.length === 0 ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">No repricing nudges right now</CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground">
            Run a scan to check your active eBay listings against condition-matched
            comps. We'll surface anything underpriced, overpriced, or stale here.
          </CardContent>
        </Card>
      ) : filtered.length === 0 ? (
        <Card>
          <CardContent className="pt-6 text-sm text-muted-foreground">
            No {reason === "ALL" ? "" : REASON_META[reason].label.toLowerCase() + " "}
            nudges match this filter.
          </CardContent>
        </Card>
      ) : (
        <>
          <div className="space-y-3">
            {pageRows.map((s) => (
              <SuggestionRow
                key={s.id}
                s={s}
                selected={selected.has(s.id)}
                onToggleSelect={toggleSelect}
              />
            ))}
          </div>
          {pageCount > 1 && (
            <div className="flex items-center justify-center gap-3">
              <Button
                size="sm"
                variant="outline"
                disabled={safePage === 0}
                onClick={() => setPage(safePage - 1)}
              >
                <ChevronLeft className="h-4 w-4" />
              </Button>
              <span className="text-sm text-muted-foreground">
                Page {safePage + 1} of {pageCount}
              </span>
              <Button
                size="sm"
                variant="outline"
                disabled={safePage >= pageCount - 1}
                onClick={() => setPage(safePage + 1)}
              >
                <ChevronRight className="h-4 w-4" />
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
