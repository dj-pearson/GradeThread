// US-1064: dashboard widget + reusable recommendation rows that turn the
// community benchmarks into actionable sourcing/pricing suggestions, surfaced on
// the FlipDesk overview (not only on the full Community Insights page).

import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import {
  ArrowRight,
  Lightbulb,
  PackageSearch,
  Tag,
  Users,
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
import { fetchCommunityBenchmarks } from "@/lib/community-benchmarks";
import {
  deriveRecommendations,
  type ConfidenceLevel,
  type Recommendation,
} from "@/lib/community-recommendations";

const COMMUNITY_ROUTE = "/dashboard/flipdesk/community";

// Widget always uses the trailing-12-months window — the most decision-relevant
// horizon for "what should I be sourcing now".
function last12moStart(): string {
  const from = new Date();
  from.setDate(from.getDate() - 365);
  return from.toISOString().slice(0, 10);
}

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

/** One recommendation, rendered as an actionable row. Reused on the full page. */
export function RecommendationRow({ rec }: { rec: Recommendation }) {
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
      <Button
        variant="outline"
        size="sm"
        asChild
        className="shrink-0 self-start sm:self-center"
      >
        <Link to={rec.deepLink}>
          {rec.deepLinkLabel}
          <ArrowRight className="ml-1 h-3 w-3" />
        </Link>
      </Button>
    </li>
  );
}

/**
 * Compact insights widget for the FlipDesk overview. Fetches the community
 * benchmarks, derives the top recommendations, and links through to the full
 * Community Insights page. Silent (renders nothing) when there is no signal.
 */
export function CommunityInsightsWidget({ limit = 3 }: { limit?: number }) {
  const { data, isLoading, isError } = useQuery({
    queryKey: ["community-benchmarks", last12moStart()],
    queryFn: () => fetchCommunityBenchmarks(last12moStart()),
    staleTime: 5 * 60 * 1000,
  });

  // Don't take up dashboard space on error — it's a non-critical surface.
  if (isError) return null;

  const recs = data ? deriveRecommendations(data).slice(0, limit) : [];

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
