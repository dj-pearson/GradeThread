import { useMemo, useState } from "react";
import { Link, useParams } from "react-router";
import { Award, Share2, Sparkles, Trophy, Zap, type LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorState } from "@/components/ui/error-state";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { MarketingLayout } from "@/components/marketing/marketing-layout";
import {
  type LeaderboardBoardResponse,
  type LeaderboardEntry,
  type LeaderboardHubResponse,
  type LeaderboardMetric,
  type LeaderboardMetricKey,
  type LeaderboardPeriod,
  useLeaderboard,
} from "@/hooks/use-leaderboards";

// US-1856: the public reward leaderboards — SPA renderer.
//
// Model B: in production a visitor gets the edge-SSR Pages Function
// (functions/leaderboards/[[path]].ts); this route is the in-app / dev renderer
// and the interactive one (window toggle, facet chips). BOTH read the SAME
// payload (/api/content/public/leaderboards.json), so neither can rank someone
// the other doesn't. Deliberately NOT registered in PUBLIC_ROUTES — rankings are
// dynamic, so the page is edge-rendered rather than prerendered at build.

// Catalog icon names → components. Explicit map (the rewards-page convention) so
// the bundle carries only what we ship and an unknown name degrades gracefully.
const ICONS: Record<string, LucideIcon> = { Award, Share2, Sparkles, Zap };

const PERIODS: { key: LeaderboardPeriod; label: string }[] = [
  { key: "weekly", label: "This week" },
  { key: "all_time", label: "All time" },
];

function titleCase(slug: string): string {
  return slug
    .split(/[-_]/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

function num(n: number): string {
  return Number.isInteger(n) ? n.toLocaleString() : n.toFixed(1);
}

/**
 * One board table. An alias links to a profile ONLY when the API resolved a
 * public verified handle for it — an alias without one is somebody who joined a
 * board but did not publish a profile, and there is nothing to link to.
 */
function BoardTable({
  metric,
  entries,
}: {
  metric: LeaderboardMetric;
  entries: LeaderboardEntry[];
}) {
  if (entries.length === 0) {
    return (
      <EmptyState
        icon={Trophy}
        title="Nobody is on this board yet"
        description="Sellers choose whether to appear. Opt in from your Rewards page to take the top spot."
      />
    );
  }
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead className="w-12">#</TableHead>
          <TableHead>Seller</TableHead>
          <TableHead className="text-right">{metric.scoreLabel}</TableHead>
          {metric.secondaryLabel ? (
            <TableHead className="text-right">{metric.secondaryLabel}</TableHead>
          ) : null}
        </TableRow>
      </TableHeader>
      <TableBody>
        {entries.map((e) => (
          <TableRow key={`${e.rank}-${e.alias}`}>
            <TableCell className="tabular-nums text-muted-foreground">
              {e.rank}
              {e.tied ? <span className="ml-0.5 text-xs">=</span> : null}
            </TableCell>
            <TableCell className="font-medium">
              {e.handle ? (
                <Link to={`/verified/${e.handle}`} className="hover:underline">
                  {e.alias}
                </Link>
              ) : (
                e.alias
              )}
            </TableCell>
            <TableCell className="text-right font-semibold tabular-nums">
              {num(e.score)}
            </TableCell>
            {metric.secondaryLabel ? (
              <TableCell className="text-right tabular-nums text-muted-foreground">
                {num(e.secondary)}
              </TableCell>
            ) : null}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function MetricNav({ metrics, active }: { metrics: LeaderboardMetric[]; active: string | null }) {
  if (metrics.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-2">
      <Button size="sm" variant={active ? "outline" : "default"} asChild>
        <Link to="/leaderboards">All boards</Link>
      </Button>
      {metrics.map((m) => {
        const Icon = ICONS[m.icon] ?? Trophy;
        return (
          <Button
            key={m.key}
            size="sm"
            variant={m.key === active ? "default" : "outline"}
            asChild
          >
            <Link to={`/leaderboards/${m.key}`}>
              <Icon className="h-4 w-4" aria-hidden="true" />
              {m.name}
            </Link>
          </Button>
        );
      })}
    </div>
  );
}

function OptInNote() {
  return (
    <p className="text-center text-sm text-muted-foreground">
      Sellers choose whether to appear here, and choose the name they appear
      under. Rankings count finished, verified work only.{" "}
      <Link to="/dashboard/rewards" className="font-medium hover:underline">
        Join from your Rewards page
      </Link>
    </p>
  );
}

function CrossLinks() {
  return (
    <p className="text-center text-sm text-muted-foreground">
      <Link to="/finds" className="font-medium hover:underline">
        The Finds feed
      </Link>{" "}
      ·{" "}
      <Link to="/verified" className="font-medium hover:underline">
        Verified sellers
      </Link>{" "}
      ·{" "}
      <Link to="/leaderboard" className="font-medium hover:underline">
        Top referrers
      </Link>
    </p>
  );
}

export function LeaderboardsPage() {
  // Facet routes mirror the SSR Pages Function's paths, so an SSR link always
  // lands somewhere the SPA can render.
  const {
    metric: metricParam = null,
    brandSlug = null,
    categorySlug = null,
  } = useParams();
  const [period, setPeriod] = useState<LeaderboardPeriod>("all_time");

  const metricKey = (metricParam ?? null) as LeaderboardMetricKey | null;
  const isHub = !metricKey;

  const query = useLeaderboard<LeaderboardHubResponse | LeaderboardBoardResponse>({
    metric: metricKey,
    period,
    brandSlug,
    category: categorySlug,
  });

  const data = query.data;
  const metrics = useMemo(() => data?.metrics ?? [], [data]);
  const board = !isHub && data && data.hub === false ? data : null;
  const hub = isHub && data && data.hub === true ? data : null;

  const facetLabel = brandSlug
    ? board?.facets.brands.find((b) => b.slug === brandSlug)?.label ?? titleCase(brandSlug)
    : categorySlug
      ? titleCase(categorySlug)
      : null;

  const heading = board
    ? facetLabel
      ? `${board.metric.name} leaderboard — ${facetLabel}`
      : `${board.metric.name} leaderboard`
    : "GradeThread leaderboards";

  const canonicalPath = !metricKey
    ? "/leaderboards"
    : brandSlug
      ? `/leaderboards/${metricKey}/b/${brandSlug}`
      : categorySlug
        ? `/leaderboards/${metricKey}/c/${categorySlug}`
        : `/leaderboards/${metricKey}`;

  return (
    <MarketingLayout
      title={board ? heading : "Leaderboards — top GradeThread sellers"}
      description="Opt-in leaderboards for GradeThread sellers: reward XP, certificates published, best finds and share-driven signups, ranked weekly and all-time."
      canonicalPath={canonicalPath}
    >
      <div className="bg-brand-navy py-10 text-white">
        <div className="mx-auto flex max-w-3xl flex-col items-center gap-3 px-6 text-center">
          <span className="inline-flex items-center gap-1.5 rounded-full bg-white/15 px-3 py-1 text-sm font-semibold">
            <Trophy className="h-4 w-4" />
            Leaderboards
          </span>
          <h1 className="text-3xl font-bold sm:text-4xl">{heading}</h1>
          <p className="max-w-xl text-sm text-white/80">
            {board?.metric.description ??
              "Four boards, ranked over this week and over all time: reward XP, certificates published, the finds that earned the most reactions, and the sellers whose shares actually brought people in."}
          </p>
        </div>
      </div>

      <div className="mx-auto max-w-4xl space-y-8 px-6 py-8">
        <MetricNav metrics={metrics} active={metricKey} />

        <div className="flex flex-wrap gap-2">
          {PERIODS.map((p) => (
            <Button
              key={p.key}
              size="sm"
              variant={period === p.key ? "default" : "outline"}
              onClick={() => setPeriod(p.key)}
            >
              {p.label}
            </Button>
          ))}
        </div>

        {/* Brand + category facets — only on the boards whose rows are garments. */}
        {board?.facet_supported &&
        (board.facets.brands.length > 0 || board.facets.categories.length > 0) ? (
          <div className="flex flex-wrap gap-2">
            {facetLabel ? (
              <Button size="sm" variant="outline" asChild>
                <Link to={`/leaderboards/${board.metric.key}`}>Everything</Link>
              </Button>
            ) : null}
            {board.facets.brands.slice(0, 12).map((b) => (
              <Button
                key={b.slug}
                size="sm"
                variant={b.slug === brandSlug ? "default" : "outline"}
                asChild
              >
                <Link to={`/leaderboards/${board.metric.key}/b/${b.slug}`}>
                  {b.label} <span className="ml-1 opacity-70">{b.count}</span>
                </Link>
              </Button>
            ))}
            {board.facets.categories.slice(0, 8).map((c) => (
              <Button
                key={c.slug}
                size="sm"
                variant={c.slug === categorySlug ? "default" : "outline"}
                asChild
              >
                <Link to={`/leaderboards/${board.metric.key}/c/${c.slug}`}>
                  {titleCase(c.label)}
                </Link>
              </Button>
            ))}
          </div>
        ) : null}

        {query.isError ? (
          <ErrorState
            title="Couldn't load the leaderboards"
            onRetry={() => query.refetch()}
          />
        ) : query.isLoading ? (
          <div className="space-y-3">
            {Array.from({ length: 6 }).map((_, i) => (
              <Skeleton key={i} className="h-10 w-full" />
            ))}
          </div>
        ) : board ? (
          <BoardTable metric={board.metric} entries={board.entries} />
        ) : hub ? (
          <div className="space-y-10">
            {hub.boards.map((b) => (
              <section key={b.metric.key} className="space-y-3">
                <h2 className="text-lg font-semibold">
                  <Link to={b.path} className="hover:underline">
                    {b.metric.name}
                  </Link>
                </h2>
                <p className="text-sm text-muted-foreground">{b.metric.description}</p>
                <BoardTable metric={b.metric} entries={b.entries} />
                <p className="text-sm">
                  <Link to={b.path} className="font-medium hover:underline">
                    See the full {b.metric.name.toLowerCase()} board
                  </Link>
                </p>
              </section>
            ))}
          </div>
        ) : null}

        <OptInNote />
        <CrossLinks />
      </div>
    </MarketingLayout>
  );
}
