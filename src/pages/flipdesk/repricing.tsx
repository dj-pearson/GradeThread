import {
  TrendingUp,
  TrendingDown,
  Clock,
  RefreshCw,
  Check,
  X,
  ExternalLink,
  Loader2,
} from "lucide-react";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import {
  useRepricingSuggestions,
  useScanRepricing,
  useApplyReprice,
  useDismissReprice,
  type ReasonCode,
  type RepriceSuggestion,
} from "@/hooks/use-repricing";

const REASON_META: Record<
  ReasonCode,
  { label: string; icon: typeof TrendingUp; classes: string }
> = {
  UNDERPRICED: {
    label: "Underpriced",
    icon: TrendingUp,
    classes: "bg-green-100 text-green-800 border-green-200",
  },
  OVERPRICED: {
    label: "Overpriced",
    icon: TrendingDown,
    classes: "bg-amber-100 text-amber-800 border-amber-200",
  },
  STALE: {
    label: "Stale",
    icon: Clock,
    classes: "bg-orange-100 text-orange-800 border-orange-200",
  },
  OK: { label: "OK", icon: Check, classes: "bg-muted text-muted-foreground" },
  NO_COMPS: { label: "No comps", icon: X, classes: "bg-muted text-muted-foreground" },
};

function money(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

function SuggestionRow({ s }: { s: RepriceSuggestion }) {
  const apply = useApplyReprice();
  const dismiss = useDismissReprice();
  const meta = REASON_META[s.reason_code] ?? REASON_META.OK;
  const Icon = meta.icon;
  const up = s.suggested_price_cents >= s.current_price_cents;

  return (
    <Card>
      <CardContent className="flex flex-col gap-3 pt-6 sm:flex-row sm:items-center sm:justify-between">
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
            <span className={cn("font-semibold", up ? "text-green-600" : "text-amber-600")}>
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
                className="inline-flex items-center gap-1 text-xs text-brand-navy hover:underline"
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
            onClick={() => apply.mutate(s.id)}
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
            onClick={() => dismiss.mutate(s.id)}
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
  const { data: suggestions = [], isLoading } = useRepricingSuggestions();
  const scan = useScanRepricing();

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

      {isLoading ? (
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
      ) : (
        <div className="space-y-3">
          {suggestions.map((s) => (
            <SuggestionRow key={s.id} s={s} />
          ))}
        </div>
      )}
    </div>
  );
}
