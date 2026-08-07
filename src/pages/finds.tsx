import { useMemo, useState } from "react";
import { Link, useParams } from "react-router";
import { Sparkles, Trophy } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorState } from "@/components/ui/error-state";
import { Skeleton } from "@/components/ui/skeleton";
import { MarketingLayout } from "@/components/marketing/marketing-layout";
import { FindCard } from "@/components/showcase/find-card";
import {
  type FindsSort,
  useFinds,
  useMyReactions,
  useToggleReaction,
} from "@/hooks/use-showcase";
import { useAuthStore } from "@/stores/auth-store";

// US-1855: the public Showcase / "Finds" feed — SPA renderer.
//
// Model B: in production a visitor gets the edge-SSR Pages Function
// (functions/finds/[[path]].ts); this route is the in-app / dev renderer and the
// interactive one (filters + reactions). BOTH read the SAME payload
// (/api/content/public/finds.json), so neither can show a feed the other can't.
// Deliberately NOT registered in PUBLIC_ROUTES — the feed is dynamic, so it is
// edge-rendered rather than prerendered at build (same as /cert/:id).

const SORTS: { key: FindsSort; label: string }[] = [
  { key: "trending", label: "Trending" },
  { key: "recent", label: "Newest" },
  { key: "top_graded", label: "Highest graded" },
];

const MIN_GRADES: { value: number | null; label: string }[] = [
  { value: null, label: "Any grade" },
  { value: 7, label: "7.0+" },
  { value: 8, label: "8.0+" },
  { value: 9, label: "9.0+" },
];

function titleCase(slug: string): string {
  return slug
    .split(/[-_]/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

export function FindsPage() {
  // Facet routes: /finds/b/:brandSlug and /finds/c/:categorySlug, matching the
  // SSR Pages Function's paths so an SSR link lands somewhere the SPA can render.
  const { brandSlug = null, categorySlug = null } = useParams();
  const user = useAuthStore((s) => s.user);

  const [sort, setSort] = useState<FindsSort>("trending");
  const [minGrade, setMinGrade] = useState<number | null>(null);

  const query = useFinds({
    sort,
    brandSlug,
    category: categorySlug,
    minGrade,
  });
  const finds = useMemo(() => query.data?.finds ?? [], [query.data]);
  const myReactions = useMyReactions(finds.map((f) => f.id));
  const toggle = useToggleReaction();

  const facetLabel = brandSlug
    ? query.data?.facets.brands.find((b) => b.slug === brandSlug)?.label ??
      finds[0]?.brand ??
      titleCase(brandSlug)
    : categorySlug
      ? titleCase(categorySlug)
      : null;

  const canonicalPath = brandSlug
    ? `/finds/b/${brandSlug}`
    : categorySlug
      ? `/finds/c/${categorySlug}`
      : "/finds";

  return (
    <MarketingLayout
      title={facetLabel ? `${facetLabel} finds` : "Finds — condition-graded thrift finds"}
      description="A public feed of pre-owned clothing finds, each independently condition-graded 1.0–10.0 with a shareable certificate."
      canonicalPath={canonicalPath}
    >
      <div className="bg-brand-navy py-10 text-white">
        <div className="mx-auto flex max-w-3xl flex-col items-center gap-3 px-6 text-center">
          <span className="inline-flex items-center gap-1.5 rounded-full bg-white/15 px-3 py-1 text-sm font-semibold">
            <Sparkles className="h-4 w-4" />
            The Finds feed
          </span>
          <h1 className="text-3xl font-bold sm:text-4xl">
            {facetLabel ? `${facetLabel} finds, condition-graded` : "Graded finds worth seeing"}
          </h1>
          <p className="max-w-xl text-sm text-white/80">
            Real pieces resellers were proud enough to publish. Every one was
            independently condition-graded on GradeThread's 1.0–10.0 standard,
            and every card links to the full certificate.
          </p>
        </div>
      </div>

      <div className="mx-auto max-w-6xl space-y-8 px-6 py-8">
        {/* Controls */}
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex flex-wrap gap-2">
            {SORTS.map((s) => (
              <Button
                key={s.key}
                size="sm"
                variant={sort === s.key ? "default" : "outline"}
                onClick={() => setSort(s.key)}
              >
                {s.label}
              </Button>
            ))}
          </div>
          <div className="flex flex-wrap gap-2">
            {MIN_GRADES.map((g) => (
              <Button
                key={g.label}
                size="sm"
                variant={minGrade === g.value ? "default" : "outline"}
                onClick={() => setMinGrade(g.value)}
              >
                {g.label}
              </Button>
            ))}
          </div>
        </div>

        {/* Brand + category facets */}
        {query.data && query.data.facets.brands.length > 0 ? (
          <div className="flex flex-wrap gap-2">
            {facetLabel ? (
              <Button size="sm" variant="outline" asChild>
                <Link to="/finds">All finds</Link>
              </Button>
            ) : null}
            {query.data.facets.brands.slice(0, 12).map((b) => (
              <Button
                key={b.slug}
                size="sm"
                variant={b.slug === brandSlug ? "default" : "outline"}
                asChild
              >
                <Link to={`/finds/b/${b.slug}`}>
                  {b.label} <span className="ml-1 opacity-70">{b.count}</span>
                </Link>
              </Button>
            ))}
            {query.data.facets.categories.slice(0, 8).map((c) => (
              <Button
                key={c.slug}
                size="sm"
                variant={c.slug === categorySlug ? "default" : "outline"}
                asChild
              >
                <Link to={`/finds/c/${c.slug}`}>{titleCase(c.label)}</Link>
              </Button>
            ))}
          </div>
        ) : null}

        {/* Feed */}
        {query.isError ? (
          <ErrorState
            title="Couldn't load the Finds feed"
            onRetry={() => query.refetch()}
          />
        ) : query.isLoading ? (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {Array.from({ length: 6 }).map((_, i) => (
              <Skeleton key={i} className="h-[380px] w-full" />
            ))}
          </div>
        ) : finds.length === 0 ? (
          <EmptyState
            icon={Sparkles}
            title="No finds here yet"
            description="Sellers choose which of their graded items appear in the feed. Grade something great and be the first."
          />
        ) : (
          <>
            <div className="flex items-center justify-between">
              <p className="text-sm text-muted-foreground">
                {finds.length.toLocaleString()} find{finds.length === 1 ? "" : "s"}
              </p>
              <Badge variant="outline" className="text-xs">
                Sorted by {SORTS.find((s) => s.key === sort)?.label}
              </Badge>
            </div>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {finds.map((f) => (
                <FindCard
                  key={f.id}
                  find={f}
                  reacted={myReactions.data?.has(f.id) ?? false}
                  reactionPending={toggle.isPending}
                  // Reacting needs an account (one vote per person). Signed-out
                  // visitors get the sign-in route rather than a dead button.
                  onReact={
                    user
                      ? (id) => toggle.mutate(id)
                      : () => {
                          window.location.href = "/login?next=/finds";
                        }
                  }
                />
              ))}
            </div>
          </>
        )}

        {/* AC3: the community leaderboard the Showcase feeds. */}
        {query.data && query.data.leaderboard.length > 0 ? (
          <section className="space-y-3 rounded-xl border p-5">
            <h2 className="flex items-center gap-2 text-lg font-semibold">
              <Trophy className="h-5 w-5 text-brand-navy dark:text-brand-red-text" />
              Most-loved sellers
            </h2>
            <p className="text-sm text-muted-foreground">
              Ranked by the reactions their showcased finds earned. Every seller
              here runs a public{" "}
              <Link to="/verified" className="font-medium hover:underline">
                GradeThread Verified
              </Link>{" "}
              profile. The opt-in{" "}
              <Link to="/leaderboards/finds" className="font-medium hover:underline">
                best-finds leaderboard
              </Link>{" "}
              ranks the same reactions weekly and all-time.
            </p>
            <ol className="space-y-2">
              {query.data.leaderboard.map((l, i) => (
                <li key={l.handle} className="flex items-center gap-3 text-sm">
                  <span className="w-6 text-muted-foreground tabular-nums">
                    {i + 1}
                  </span>
                  <Link
                    to={`/verified/${l.handle}`}
                    className="min-w-0 flex-1 truncate font-medium hover:underline"
                  >
                    {l.display_name}
                  </Link>
                  <span className="text-muted-foreground tabular-nums">
                    {l.finds} find{l.finds === 1 ? "" : "s"}
                  </span>
                  <span className="font-semibold tabular-nums">{l.reactions}</span>
                </li>
              ))}
            </ol>
          </section>
        ) : null}

        <p className="text-center text-sm text-muted-foreground">
          Sellers choose which graded items appear here. A grade is an independent
          condition assessment, not a valuation or an authentication.{" "}
          <Link to="/snap" className="font-medium hover:underline">
            Grade your own find
          </Link>{" "}
          ·{" "}
          <Link to="/leaderboards" className="font-medium hover:underline">
            See the leaderboards
          </Link>
        </p>
      </div>
    </MarketingLayout>
  );
}
