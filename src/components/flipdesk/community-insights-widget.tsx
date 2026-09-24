// US-1064: dashboard widget + reusable recommendation rows that turn the
// community benchmarks into actionable sourcing/pricing suggestions, surfaced on
// the FlipDesk overview (not only on the full Community Insights page).

import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router";
import {
  ArrowRight,
  Lightbulb,
  PackageSearch,
  Tag,
  Users,
  X,
} from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import {
  communityBenchmarksKey,
  fetchCommunityBenchmarks,
} from "@/lib/community-benchmarks";
import {
  deriveRecommendations,
  loadDismissedRecs,
  type ConfidenceLevel,
  type Recommendation,
} from "@/lib/community-recommendations";
import { useTenantKey } from "@/hooks/use-tenant-key";
import { presetStart } from "@/lib/analytics-range";

// US-2161: Community Insights is an Analytics tab now. A10: it reads the
// page's ?preset=, so the link names the widget's own 12-month window and the
// tab opens on the same numbers (and the same cached fetch).
const COMMUNITY_ROUTE = "/dashboard/flipdesk/analytics/community?preset=12mo";

// Widget always uses the trailing-12-months window — the most decision-relevant
// horizon for "what should I be sourcing now". A8: the same presetStart and key
// builder as the Community tab, so opening the tab after the Overview reuses
// this fetch instead of running the cross-seller aggregate a second time.

const CONFIDENCE_BADGE: Record<ConfidenceLevel, string> = {
  high: "bg-emerald-100 text-emerald-700 hover:bg-emerald-100",
  medium: "bg-amber-100 text-amber-700 hover:bg-amber-100",
  low: "bg-muted text-muted-foreground hover:bg-muted",
};

const CONFIDENCE_LABEL: Record<ConfidenceLevel, string> = {
  high: "High confidence",
  medium: "Medium confidence",
  low: "Low confidence",
};

/** One recommendation, rendered as an actionable row. Reused on the full page.
 * US-2235: pass onDismiss to let the reseller clear a recommendation they've
 * acted on or don't want; omitted (e.g. the dashboard widget) hides the control. */
export function RecommendationRow({
  rec,
  onDismiss,
}: {
  rec: Recommendation;
  onDismiss?: (id: string) => void;
}) {
  const Icon = rec.kind === "source" ? PackageSearch : Tag;
  return (
    <li className="flex flex-col gap-2 rounded-md border p-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex min-w-0 items-start gap-3">
        <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-brand-navy/10 text-brand-navy dark:text-foreground">
          <Icon className="h-4 w-4" />
        </div>
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium">{rec.title}</span>
            <Badge
              variant="secondary"
              className={cn("text-[10px]", CONFIDENCE_BADGE[rec.confidenceLevel])}
            >
              {CONFIDENCE_LABEL[rec.confidenceLevel]}
            </Badge>
          </div>
          <p className="text-xs text-muted-foreground">{rec.detail}</p>
          <p className="mt-0.5 flex items-center gap-1 text-[11px] text-muted-foreground">
            <Users className="h-3 w-3" />
            {rec.cohortSize} sellers in this cohort
          </p>
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-1 self-start sm:self-center">
        <Button variant="outline" size="sm" asChild>
          <Link to={rec.deepLink}>
            {rec.deepLinkLabel}
            <ArrowRight className="ml-1 h-3 w-3" />
          </Link>
        </Button>
        {onDismiss && (
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8 text-muted-foreground"
            aria-label="Dismiss recommendation"
            onClick={() => onDismiss(rec.id)}
          >
            <X className="h-4 w-4" />
          </Button>
        )}
      </div>
    </li>
  );
}

/**
 * Compact insights widget for the FlipDesk overview. Fetches the community
 * benchmarks, derives the top recommendations, and links through to the full
 * Community Insights page. Silent (renders nothing) when there is no signal.
 */
export function CommunityInsightsWidget({ limit = 3 }: { limit?: number }) {
  const tenantKey = useTenantKey();
  const periodStart = presetStart("12mo");
  const { data, isLoading, isError } = useQuery({
    queryKey: communityBenchmarksKey(tenantKey, periodStart),
    queryFn: () => fetchCommunityBenchmarks(periodStart, tenantKey as string),
    enabled: !!tenantKey,
    staleTime: 5 * 60 * 1000,
  });

  // Don't take up dashboard space on error — it's a non-critical surface.
  if (isError) return null;

  // A10: a recommendation dismissed on the Community tab stays dismissed here.
  const dismissed = loadDismissedRecs();
  const recs = data
    ? deriveRecommendations(data)
        .filter((r) => !dismissed.has(r.id))
        .slice(0, limit)
    : [];

  // Once loaded, if there's nothing to recommend, stay out of the way.
  if (!isLoading && recs.length === 0) return null;

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <div>
            <CardTitle className="flex items-center gap-2 text-base">
              <Lightbulb className="h-4 w-4" /> Community recommendations
            </CardTitle>
            <CardDescription>
              What to source and how to price, from anonymized community data.
            </CardDescription>
          </div>
          <Button variant="ghost" size="sm" asChild>
            <Link to={COMMUNITY_ROUTE}>
              All insights
              <ArrowRight className="ml-1 h-3 w-3" />
            </Link>
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="space-y-2">
            {Array.from({ length: limit }).map((_, i) => (
              <Skeleton key={i} className="h-16 w-full rounded-md" />
            ))}
          </div>
        ) : (
          <ul className="space-y-2">
            {recs.map((rec) => (
              <RecommendationRow key={rec.id} rec={rec} />
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
