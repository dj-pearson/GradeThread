import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import {
  BadgeCheck,
  ExternalLink,
  ImageOff,
  Share2,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorState } from "@/components/ui/error-state";
import { SEO } from "@/components/seo";
import { edgeApiUrl } from "@/lib/edge-api";
import { MARKETPLACE_LABELS } from "@/lib/constants";
import { cn } from "@/lib/utils";
import { profileUrl } from "@/lib/verified";
import { shareOrCopy } from "@/lib/share";
import { track } from "@/lib/analytics";

interface RecentCert {
  id: string;
  title: string;
  brand: string | null;
  overall_score: number;
  grade_tier: string;
  created_at: string;
}

// One active-listing card. Graded items carry cert fields and link to /cert/:id;
// non-graded items carry listing_url and link out to the marketplace.
interface StorefrontListing {
  id: string;
  title: string;
  brand: string | null;
  price: number;
  photo_url: string | null;
  platform: string;
  certificate_id?: string;
  overall_score?: number;
  grade_tier?: string;
  listing_url?: string;
}

interface SellerProfile {
  seller: {
    handle: string;
    display_name: string;
    bio: string | null;
    verified_since: string | null;
  };
  stats: {
    total_graded: number;
    total_is_capped: boolean;
    average_grade: number;
    tier_distribution: Record<string, number>;
  };
  recent_certificates: RecentCert[];
  show_listings: boolean;
  listings: StorefrontListing[];
}

function platformLabel(platform: string): string {
  return (
    MARKETPLACE_LABELS[platform as keyof typeof MARKETPLACE_LABELS] ?? platform
  );
}

function StorefrontCard({ listing }: { listing: StorefrontListing }) {
  const graded = !!listing.certificate_id;
  const price = `$${listing.price.toFixed(2)}`;
  const cardClass =
    "group block overflow-hidden rounded-lg border transition-colors hover:bg-muted/50";

  const inner = (
    <>
      <div className="relative aspect-square overflow-hidden bg-muted">
        {listing.photo_url ? (
          <img
            src={listing.photo_url}
            alt={listing.title}
            loading="lazy"
            className="h-full w-full object-cover"
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center text-muted-foreground/50">
            <ImageOff className="h-8 w-8" />
          </div>
        )}
        {graded ? (
          <span className="absolute left-1.5 top-1.5 inline-flex items-center gap-1 rounded-full bg-brand-navy px-2 py-0.5 text-xs font-bold text-white shadow">
            <BadgeCheck className="h-3 w-3" />
            <span className={scoreColor(listing.overall_score ?? 0)}>
              {(listing.overall_score ?? 0).toFixed(1)}
            </span>
          </span>
        ) : (
          <span className="absolute left-1.5 top-1.5 rounded-full bg-black/60 px-2 py-0.5 text-[10px] font-medium text-white">
            {platformLabel(listing.platform)}
          </span>
        )}
      </div>
      <div className="p-2.5">
        <p className="truncate text-sm font-medium">{listing.title}</p>
        {listing.brand && (
          <p className="truncate text-xs text-muted-foreground">{listing.brand}</p>
        )}
        <p className="mt-0.5 text-sm font-semibold text-brand-navy dark:text-foreground">{price}</p>
        {graded ? (
          <p className="mt-0.5 text-xs font-medium text-green-700 dark:text-green-300">
            Verified grade · {listing.grade_tier}
          </p>
        ) : (
          <span className="mt-0.5 inline-flex items-center gap-1 text-xs text-muted-foreground">
            View on {platformLabel(listing.platform)}
            <ExternalLink className="h-3 w-3" />
          </span>
        )}
      </div>
    </>
  );

  return graded ? (
    <Link to={`/cert/${listing.certificate_id}`} className={cardClass}>
      {inner}
    </Link>
  ) : (
    <a
      href={listing.listing_url}
      target="_blank"
      rel="nofollow noopener"
      className={cardClass}
    >
      {inner}
    </a>
  );
}

function scoreColor(score: number): string {
  if (score > 7) return "text-green-600 dark:text-green-400";
  if (score >= 5) return "text-yellow-600 dark:text-yellow-400";
  return "text-red-600 dark:text-red-400";
}

export function VerifiedSellerPage() {
  const { handle } = useParams<{ handle: string }>();
  const [data, setData] = useState<SellerProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // US-1131: distinguish a 404 (not-found → EmptyState) from a fetch failure
  // (→ retryable ErrorState); `attempt` re-runs the load on retry.
  const [notFound, setNotFound] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!handle) return;
    let cancelled = false;

    async function load() {
      setLoading(true);
      setError(null);
      setNotFound(false);
      try {
        const res = await fetch(
          `${edgeApiUrl()}/api/content/public/sellers/${encodeURIComponent(handle!)}`,
          { headers: { Accept: "application/json" } },
        );
        if (!res.ok) {
          // Clear any previously-rendered profile so a failed reload (e.g. the
          // handle changed / profile was disabled) can't show stale listings
          // alongside the error (US-798).
          if (!cancelled) {
            setData(null);
            setNotFound(true);
          }
          return;
        }
        const json = (await res.json()) as SellerProfile;
        if (!cancelled) setData(json);
      } catch {
        if (!cancelled) {
          setData(null);
          setError("Couldn't load this profile");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    load();

    // US-1760: attribute a storefront-badge-driven arrival to this seller. Once
    // per session; the owner is resolved server-side from the handle. Only the
    // badge/embed source (a storefront badge always links with ?s=embed).
    try {
      const src = new URLSearchParams(window.location.search).get("s") ?? "";
      const key = `gt_sbadge_${handle}`;
      if ((src === "embed" || src === "badge") && !sessionStorage.getItem(key)) {
        sessionStorage.setItem(key, "1");
        void fetch(`${edgeApiUrl()}/api/content/public/badge-click`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ targetType: "seller", targetId: handle, source: src }),
        }).catch(() => {});
      }
    } catch {
      /* storage/network disabled — best-effort attribution */
    }

    return () => {
      cancelled = true;
    };
  }, [handle, attempt]);

  if (loading) {
    return (
      <div className="mx-auto w-full max-w-3xl space-y-6 p-6">
        <Skeleton className="h-10 w-64" />
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="mx-auto flex min-h-[60vh] w-full max-w-md items-center justify-center p-6">
        <ErrorState
          title="Couldn't load this profile"
          onRetry={() => setAttempt((a) => a + 1)}
        />
      </div>
    );
  }

  if (notFound || !data) {
    return (
      <div className="mx-auto flex min-h-[60vh] w-full max-w-md items-center justify-center p-6">
        <EmptyState
          icon={BadgeCheck}
          title="Profile not found"
          description="This seller profile may be private or the link is invalid."
          action={{ label: "Browse verified sellers", to: "/verified" }}
        />
      </div>
    );
  }

  const { seller, stats, recent_certificates } = data;
  const listings = data.show_listings ? (data.listings ?? []) : [];
  const avg = stats.average_grade > 0 ? stats.average_grade.toFixed(1) : "—";
  const count = stats.total_is_capped
    ? `${stats.total_graded.toLocaleString()}+`
    : stats.total_graded.toLocaleString();
  const since = seller.verified_since
    ? new Date(seller.verified_since).toLocaleDateString("en-US", {
        year: "numeric",
        month: "long",
      })
    : null;

  // US-862: "share your store" — native share sheet / copy of the public
  // profile link, carrying ?s=share for view attribution (US-769).
  const shareStore = async () => {
    const url = `${profileUrl(seller.handle)}?s=share`;
    const result = await shareOrCopy({
      title: `${seller.display_name} — GradeThread Verified Seller`,
      text: `Shop ${seller.display_name}'s GradeThread Verified store — every item is independently AI condition-graded.`,
      url,
      copiedMessage: "Store link copied",
    });
    if (result === "shared" || result === "copied") {
      track("seller_profile_share", {
        handle: seller.handle,
        method: result === "shared" ? "web_share" : "copy",
      });
    }
  };

  return (
    <div className="min-h-screen bg-background">
      <SEO
        title={`${seller.display_name} — GradeThread Verified Seller`}
        description={`${seller.display_name} is a GradeThread Verified seller with ${count} AI-graded items${stats.average_grade > 0 ? ` averaging ${avg}/10` : ""}.${listings.length > 0 ? ` Shop ${listings.length} item${listings.length === 1 ? "" : "s"} for sale.` : ""} Every grade is independently verifiable.`}
        canonicalUrl={`https://gradethread.com/verified/${seller.handle}`}
      />

      {/* Header */}
      <div className="bg-brand-navy py-8 text-white">
        <div className="mx-auto flex max-w-3xl flex-col items-center gap-3 px-6 text-center">
          <span className="inline-flex items-center gap-1.5 rounded-full bg-white/15 px-3 py-1 text-sm font-semibold">
            <BadgeCheck className="h-4 w-4" />
            GradeThread Verified Seller
          </span>
          <h1 className="text-2xl font-bold sm:text-3xl">{seller.display_name}</h1>
          {since && <p className="text-sm text-white/70">Verified since {since}</p>}
          {seller.bio && (
            <p className="max-w-xl text-sm text-white/80">{seller.bio}</p>
          )}
          <Button
            variant="outline"
            size="sm"
            onClick={shareStore}
            className="mt-1 border-white/30 bg-white/10 text-white hover:bg-white/20 hover:text-white"
          >
            <Share2 className="mr-1.5 h-4 w-4" />
            Share your store
          </Button>
        </div>
      </div>

      <div className="mx-auto max-w-3xl space-y-6 px-6 py-8">
        {/* Stats */}
        <div className="grid grid-cols-2 gap-4">
          <Card>
            <CardContent className="pt-6 text-center">
              <div className="text-4xl font-extrabold text-brand-navy dark:text-foreground">{count}</div>
              <p className="text-sm text-muted-foreground">items graded</p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-6 text-center">
              <div className="text-4xl font-extrabold text-brand-navy dark:text-foreground">{avg}</div>
              <p className="text-sm text-muted-foreground">avg grade · out of 10</p>
            </CardContent>
          </Card>
        </div>

        {/* Tier distribution */}
        {Object.keys(stats.tier_distribution).length > 0 && (
          <div className="flex flex-wrap justify-center gap-2">
            {Object.entries(stats.tier_distribution)
              .sort((a, b) => b[1] - a[1])
              .map(([tier, n]) => (
                <Badge key={tier} variant="outline" className="text-xs">
                  {tier} · {n}
                </Badge>
              ))}
          </div>
        )}

        {/* Shop — active listings, graded items highlighted */}
        {listings.length > 0 && (
          <Card>
            <CardHeader>
              <CardTitle className="text-base">
                Shop {seller.display_name}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
                {listings.map((listing) => (
                  <StorefrontCard key={listing.id} listing={listing} />
                ))}
              </div>
            </CardContent>
          </Card>
        )}

        {/* Recent certificates */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Recent verified grades</CardTitle>
          </CardHeader>
          <CardContent>
            {recent_certificates.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No public certificates yet.
              </p>
            ) : (
              <div className="grid gap-3 sm:grid-cols-2">
                {recent_certificates.map((cert) => (
                  <Link
                    key={cert.id}
                    to={`/cert/${cert.id}`}
                    className="flex items-center gap-3 rounded-lg border p-3 transition-colors hover:bg-muted/50"
                  >
                    <div className="flex h-12 w-12 flex-shrink-0 items-center justify-center rounded-full bg-brand-navy">
                      <span
                        className={cn(
                          "text-lg font-extrabold",
                          scoreColor(cert.overall_score),
                        )}
                      >
                        {cert.overall_score.toFixed(1)}
                      </span>
                    </div>
                    <div className="min-w-0">
                      <p className="truncate font-medium">{cert.title}</p>
                      {cert.brand && (
                        <p className="truncate text-sm text-muted-foreground">
                          {cert.brand}
                        </p>
                      )}
                      <p className="text-xs text-muted-foreground">
                        {cert.grade_tier}
                      </p>
                    </div>
                  </Link>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        {/* CTA */}
        <div className="pb-4 text-center">
          <p className="text-sm text-muted-foreground">
            Want a verified profile like this?{" "}
            <Link to="/for-resellers" className="font-medium text-brand-navy hover:underline dark:text-foreground">
              Get GradeThread Verified
            </Link>
          </p>
        </div>
      </div>
    </div>
  );
}
