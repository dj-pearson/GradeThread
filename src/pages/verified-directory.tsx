import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router";
import { BadgeCheck, Trophy, Search } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorState } from "@/components/ui/error-state";
import { MarketingLayout } from "@/components/marketing/marketing-layout";
import { edgeApiUrl } from "@/lib/edge-api";
import {
  resolvePrerenderSeed,
  seedDomId,
  escapeJsonForScript,
} from "@/lib/seo/prerender-seed";
import { cn } from "@/lib/utils";

// US-2187: build-time seed key. The directory list hydrates client-side, so
// without a seed the crawlable HTML (and AI answer engines, which don't run JS)
// see only the shell. scripts/prerender.mjs fetches sellers.json at build and
// this key lets the SSR render the ranked list into the static HTML.
const SEED_KEY = "verified-directory";

// One row from /api/content/public/sellers.json — the same public projection
// the sitemap reads, extended (US-863) with the headline trust stats the
// directory ranks by. No private fields: only verified_enabled profiles, and
// stats counted over CERTIFIED (public) reports only.
interface DirectorySeller {
  handle: string;
  display_name: string;
  verified_since: string | null;
  updated_at: string | null;
  total_graded: number;
  average_grade: number;
}

type SortKey = "volume" | "grade" | "recency";

const SORTS: { key: SortKey; label: string }[] = [
  { key: "volume", label: "Most graded" },
  { key: "grade", label: "Highest grade" },
  { key: "recency", label: "Newest" },
];

function scoreColor(score: number): string {
  if (score > 7) return "text-green-600 dark:text-green-400";
  if (score >= 5) return "text-yellow-600 dark:text-yellow-400";
  return "text-red-600 dark:text-red-400";
}

// Recency key: when the seller joined the verified program, falling back to the
// last profile update so a brand-new (verified_since-less) row still sorts.
function recencyKey(s: DirectorySeller): string {
  return s.verified_since ?? s.updated_at ?? "";
}

function sortSellers(rows: DirectorySeller[], sort: SortKey): DirectorySeller[] {
  const out = [...rows];
  out.sort((a, b) => {
    if (sort === "volume") {
      if (b.total_graded !== a.total_graded) return b.total_graded - a.total_graded;
      return b.average_grade - a.average_grade;
    }
    if (sort === "grade") {
      if (b.average_grade !== a.average_grade) return b.average_grade - a.average_grade;
      return b.total_graded - a.total_graded;
    }
    // recency
    return recencyKey(b).localeCompare(recencyKey(a));
  });
  return out;
}

function SellerCard({ seller, rank }: { seller: DirectorySeller; rank: number }) {
  const avg = seller.average_grade > 0 ? seller.average_grade.toFixed(1) : "—";
  const count = seller.total_graded.toLocaleString();
  return (
    <Link
      to={`/verified/${seller.handle}`}
      className="group flex items-center gap-4 rounded-lg border p-4 transition-colors hover:bg-muted/50"
    >
      <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full bg-brand-navy text-sm font-bold text-white">
        {rank <= 3 ? <Trophy className="h-5 w-5" /> : `#${rank}`}
      </div>
      <div className="min-w-0 flex-1">
        <p className="flex items-center gap-1.5 truncate font-semibold">
          {seller.display_name}
          <BadgeCheck className="h-4 w-4 flex-shrink-0 text-brand-navy dark:text-brand-red-text" />
        </p>
        <p className="truncate text-sm text-muted-foreground">@{seller.handle}</p>
      </div>
      <div className="flex flex-shrink-0 items-center gap-5 text-right">
        <div>
          <div className="text-lg font-bold text-brand-navy dark:text-foreground">
            {count}
          </div>
          <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
            graded
          </p>
        </div>
        <div>
          <div className={cn("text-lg font-bold", scoreColor(seller.average_grade))}>
            {avg}
          </div>
          <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
            avg grade
          </p>
        </div>
      </div>
    </Link>
  );
}

export function VerifiedDirectoryPage() {
  const [sellers, setSellers] = useState<DirectorySeller[] | null>(() => {
    const seeded = resolvePrerenderSeed<{ sellers: DirectorySeller[] }>(
      SEED_KEY,
    )?.sellers;
    // Only seed a NON-EMPTY list — an empty seed would render the EmptyState
    // <h3> right under the page <h1> in the prerendered HTML (heading-outline
    // skip). Empty directory = nothing to seed for GEO; skeleton until fetch.
    return seeded && seeded.length > 0 ? seeded : null;
  });
  const [error, setError] = useState<string | null>(null);
  const [sort, setSort] = useState<SortKey>("volume");
  const [query, setQuery] = useState("");
  // US-1131: bump to re-run the fetch from the standardized ErrorState retry.
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    setSellers(null);
    async function load() {
      try {
        const res = await fetch(`${edgeApiUrl()}/api/content/public/sellers.json`, {
          headers: { Accept: "application/json" },
        });
        if (!res.ok) {
          if (!cancelled) setError("Couldn't load the directory");
          return;
        }
        const json = (await res.json()) as { sellers: DirectorySeller[] };
        if (!cancelled) setSellers(json.sellers ?? []);
      } catch {
        if (!cancelled) setError("Couldn't load the directory");
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, [attempt]);

  const ranked = useMemo(() => {
    if (!sellers) return [];
    const q = query.trim().toLowerCase();
    const filtered = q
      ? sellers.filter(
          (s) =>
            s.handle.toLowerCase().includes(q) ||
            s.display_name.toLowerCase().includes(q),
        )
      : sellers;
    return sortSellers(filtered, sort);
  }, [sellers, sort, query]);

  return (
    // MarketingLayout, not a bare div: this is a PUBLIC, indexable page — the
    // trust surface a buyer lands on from a seller's shared badge — and without
    // the layout it rendered with no site nav and no footer. It carried exactly
    // ONE outbound link (/for-resellers) against 45 on a normal marketing page,
    // so a visitor arriving from search had no route to sign up and the page
    // absorbed link equity from the sitewide footer without passing any on.
    <MarketingLayout
      title="GradeThread Verified Sellers Directory"
      description="Browse trusted GradeThread Verified sellers, ranked by graded volume and average condition grade. Every item is independently AI condition-graded."
      canonicalPath="/verified"
    >
      {/* Header */}
      <div className="bg-brand-navy py-10 text-white">
        <div className="mx-auto flex max-w-3xl flex-col items-center gap-3 px-6 text-center">
          <span className="inline-flex items-center gap-1.5 rounded-full bg-white/15 px-3 py-1 text-sm font-semibold">
            <BadgeCheck className="h-4 w-4" />
            GradeThread Verified
          </span>
          <h1 className="text-3xl font-bold sm:text-4xl">Verified Seller Directory</h1>
          <p className="max-w-xl text-sm text-white/80">
            Trusted resellers who back every item with an independent, AI-powered
            condition grade and a verifiable certificate. Ranked by graded volume
            and average grade.
          </p>
        </div>
      </div>

      <div className="mx-auto max-w-3xl space-y-6 px-6 py-8">
        {/* US-2187: bake the ranked list the prerender fetched so crawlers/AI
            engines read the figures, and the live SPA can seed from it. */}
        {sellers && sellers.length > 0 && (
          <script
            type="application/json"
            id={seedDomId(SEED_KEY)}
            dangerouslySetInnerHTML={{
              __html: escapeJsonForScript({ sellers }),
            }}
          />
        )}
        {/* Controls */}
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="relative w-full sm:max-w-xs">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search sellers…"
              className="pl-9"
              aria-label="Search sellers"
            />
          </div>
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
        </div>

        {/* List */}
        {error ? (
          <ErrorState
            title={error}
            onRetry={() => setAttempt((a) => a + 1)}
          />
        ) : !sellers ? (
          <div className="space-y-3">
            {Array.from({ length: 6 }).map((_, i) => (
              <Skeleton key={i} className="h-[74px] w-full" />
            ))}
          </div>
        ) : ranked.length === 0 ? (
          <EmptyState
            icon={query ? Search : BadgeCheck}
            title={
              query
                ? "No verified sellers match your search"
                : "No verified sellers yet"
            }
            description={
              query
                ? "Try a different name or clear your search."
                : "Be the first to get verified — grade your inventory and turn on your public profile."
            }
          />
        ) : (
          <>
            <div className="flex items-center justify-between">
              <p className="text-sm text-muted-foreground">
                {ranked.length.toLocaleString()} verified seller
                {ranked.length === 1 ? "" : "s"}
              </p>
              <Badge variant="outline" className="text-xs">
                Sorted by {SORTS.find((s) => s.key === sort)?.label}
              </Badge>
            </div>
            <div className="space-y-3">
              {ranked.map((seller, i) => (
                <SellerCard key={seller.handle} seller={seller} rank={i + 1} />
              ))}
            </div>
          </>
        )}

        {/* CTA */}
        <div className="pt-2 text-center">
          <p className="text-sm text-muted-foreground">
            Want to appear here?{" "}
            <Link
              to="/for-resellers"
              className="font-medium text-brand-navy hover:underline dark:text-foreground"
            >
              Get GradeThread Verified
            </Link>
          </p>
        </div>
      </div>
    </MarketingLayout>
  );
}
