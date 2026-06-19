import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import {
  ShieldCheck,
  ShieldQuestion,
  CircleHelp,
  BadgeCheck,
  Tag,
  ShoppingBag,
  ArrowRightLeft,
  Fingerprint,
  Calendar,
  ExternalLink,
  History,
  type LucideIcon,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { SEO } from "@/components/seo";
import { Breadcrumbs } from "@/components/breadcrumbs";
import { passportLd, breadcrumbLd } from "@/lib/seo/json-ld";
import { SITE_URL } from "@/lib/seo/public-routes";
import { cn } from "@/lib/utils";
import { edgeApiUrl } from "@/lib/edge-api";

// Mirrors the PII-free shape returned by the public passport endpoint
// (services/edge-functions/src/routes/passport.ts GET /:slug). The edge already
// sanitizes payloads and resolves actors to pseudonymous labels only — this
// page renders what it is given and never reaches for identity.
type PassportEvent = {
  event_type: string;
  confidence: "deterministic" | "probable" | "unknown" | string;
  actor: string | null;
  source: string | null;
  payload: Record<string, unknown>;
  created_at: string;
};
type PassportResponse = {
  slug: string;
  sku_class: Record<string, unknown>;
  status: string;
  created_at: string;
  // US-1101: PII-free origin-seller Verified badge (null unless opted in).
  origin_verified_seller?: {
    handle: string;
    display_name: string | null;
    since: string | null;
  } | null;
  events: PassportEvent[];
};

function formatLabel(value: string): string {
  return value
    .split(/[-_]/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString("en-US", {
      year: "numeric",
      month: "long",
      day: "numeric",
    });
  } catch {
    return iso;
  }
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v : null;
}
function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

// Per-event-type presentation. Kept small + local (no cross-app coupling); the
// set mirrors the garment_event_type enum (00256).
const EVENT_META: Record<string, { icon: LucideIcon; label: string }> = {
  graded: { icon: BadgeCheck, label: "Condition graded" },
  listed: { icon: Tag, label: "Listed for sale" },
  sold: { icon: ShoppingBag, label: "Sold" },
  ownership_transfer: { icon: ArrowRightLeft, label: "Ownership transferred" },
  fingerprinted: { icon: Fingerprint, label: "Fingerprinted" },
};
function eventMeta(type: string): { icon: LucideIcon; label: string } {
  return EVENT_META[type] ?? { icon: History, label: formatLabel(type) };
}

// Confidence → badge. Each event in the chain is labeled with how certain the
// link is: deterministic (a first-party fact / signed handoff), probable (a
// matched-but-inferred link), or unknown.
type ConfidenceMeta = { icon: LucideIcon; label: string; classes: string };
const UNKNOWN_CONFIDENCE: ConfidenceMeta = {
  icon: CircleHelp,
  label: "Unknown",
  classes: "bg-slate-100 text-slate-700 border-slate-200",
};
const CONFIDENCE_META: Record<string, ConfidenceMeta> = {
  deterministic: {
    icon: ShieldCheck,
    label: "Verified",
    classes:
      "bg-emerald-100 text-emerald-800 border-emerald-200 dark:bg-emerald-950/50 dark:text-emerald-300 dark:border-emerald-800",
  },
  probable: {
    icon: ShieldQuestion,
    label: "Probable",
    classes:
      "bg-amber-100 text-amber-800 border-amber-200 dark:bg-amber-950/50 dark:text-amber-300 dark:border-amber-800",
  },
  unknown: UNKNOWN_CONFIDENCE,
};
function confidenceMeta(c: string): ConfidenceMeta {
  return CONFIDENCE_META[c] ?? UNKNOWN_CONFIDENCE;
}

/** A human-readable garment name from the PII-free sku_class descriptor. */
function garmentName(sku: Record<string, unknown>): string {
  const brand = str(sku.brand);
  const type = str(sku.garment_type);
  const parts = [brand, type ? formatLabel(type) : null].filter(Boolean);
  return parts.length ? parts.join(" ") : "Graded garment";
}

function PassportSkeleton() {
  return (
    <div className="mx-auto max-w-2xl space-y-6 px-6 py-10">
      <Skeleton className="h-8 w-2/3" />
      <Skeleton className="h-24 w-full" />
      <Skeleton className="h-40 w-full" />
      <Skeleton className="h-40 w-full" />
    </div>
  );
}

// One row of the vertical provenance timeline.
function TimelineEvent({ event, isLast }: { event: PassportEvent; isLast: boolean }) {
  const meta = eventMeta(event.event_type);
  const conf = confidenceMeta(event.confidence);
  const Icon = meta.icon;
  const ConfIcon = conf.icon;

  const score = num(event.payload.overall_score);
  const tier = str(event.payload.grade_tier);
  const certificate = str(event.payload.certificate);

  return (
    <li className="relative flex gap-4 pb-8 last:pb-0">
      {/* Connector line (hidden on the final node). */}
      {!isLast && (
        <span
          aria-hidden
          className="absolute left-[19px] top-10 h-[calc(100%-1.5rem)] w-px bg-border"
        />
      )}
      {/* Node marker */}
      <div className="relative z-10 flex h-10 w-10 shrink-0 items-center justify-center rounded-full border bg-brand-navy text-white">
        <Icon className="h-5 w-5" />
      </div>

      <Card className="flex-1">
        <CardContent className="space-y-2 p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="font-semibold text-foreground">{meta.label}</h3>
            <Badge variant="outline" className={cn("gap-1", conf.classes)}>
              <ConfIcon className="h-3.5 w-3.5" />
              {conf.label}
            </Badge>
          </div>

          {/* Grade detail (graded events) */}
          {score !== null && tier && (
            <p className="text-sm text-muted-foreground">
              <span className="font-semibold text-brand-red">{score.toFixed(1)}/10</span>
              {" — "}
              {tier}
            </p>
          )}

          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
            <span className="flex items-center gap-1">
              <Calendar className="h-3.5 w-3.5" />
              {formatDate(event.created_at)}
            </span>
            {event.actor && <span>{event.actor}</span>}
          </div>

          {certificate && (
            <Link
              to={`/cert/${certificate}`}
              className="inline-flex items-center gap-1 text-sm font-medium text-brand-navy hover:underline dark:text-blue-400"
            >
              View grade certificate
              <ExternalLink className="h-3.5 w-3.5" />
            </Link>
          )}
        </CardContent>
      </Card>
    </li>
  );
}

export function PassportPage() {
  const { slug } = useParams<{ slug: string }>();
  const [data, setData] = useState<PassportResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!slug) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    (async () => {
      try {
        const res = await fetch(
          `${edgeApiUrl()}/api/passport/${encodeURIComponent(slug)}`,
        );
        if (res.status === 404) {
          if (!cancelled) setError("not_found");
          return;
        }
        if (!res.ok) throw new Error(`passport fetch failed: ${res.status}`);
        const json = (await res.json()) as PassportResponse;
        if (!cancelled) setData(json);
      } catch {
        if (!cancelled) setError("error");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [slug]);

  if (loading) return <PassportSkeleton />;

  if (error || !data) {
    return (
      <div className="mx-auto max-w-2xl px-6 py-20 text-center">
        <SEO title="Passport not found" noindex />
        <History className="mx-auto h-10 w-10 text-muted-foreground" />
        <h1 className="mt-4 text-xl font-bold">
          {error === "not_found" ? "Passport not found" : "Couldn't load this passport"}
        </h1>
        <p className="mt-2 text-muted-foreground">
          {error === "not_found"
            ? "We couldn't find a Garment Passport for this link."
            : "Something went wrong loading the provenance history. Please try again."}
        </p>
        <Link
          to="/"
          className="mt-6 inline-block text-sm font-medium text-brand-navy hover:underline dark:text-blue-400"
        >
          ← Back to GradeThread
        </Link>
      </div>
    );
  }

  const name = garmentName(data.sku_class);
  const brand = str(data.sku_class.brand);
  const category = str(data.sku_class.category);

  // Oldest→newest from the edge; the latest 'graded' event drives the JSON-LD
  // Product review and the header score.
  const gradedEvents = data.events.filter((e) => e.event_type === "graded");
  const latestGraded = gradedEvents[gradedEvents.length - 1];
  const latestScore = latestGraded ? num(latestGraded.payload.overall_score) : null;
  const latestTier = latestGraded ? str(latestGraded.payload.grade_tier) : null;

  const breadcrumbTrail = [
    { name: "GradeThread", url: `${SITE_URL}/` },
    { name: "Garment Passport", url: `${SITE_URL}/passport/${data.slug}` },
  ];

  return (
    <div className="min-h-screen bg-background">
      <SEO
        title={`Garment Passport — ${name}`}
        description={`Provenance and condition history for ${name}: a confidence-scored timeline of grades, listings, sales, and ownership on GradeThread.`}
        ogType="product"
        canonicalUrl={`${SITE_URL}/passport/${data.slug}`}
        jsonLd={[
          passportLd({
            slug: data.slug,
            name,
            category,
            brand,
            latestGrade:
              latestScore !== null && latestTier
                ? {
                    score: latestScore,
                    tier: latestTier,
                    datePublished: latestGraded?.created_at ?? null,
                  }
                : null,
          }),
          breadcrumbLd(breadcrumbTrail),
        ]}
      />

      {/* Brand header */}
      <div className="bg-brand-navy py-6 text-white">
        <div className="mx-auto flex max-w-2xl flex-col items-center gap-2 px-6 text-center">
          <div className="flex items-center gap-2">
            <History className="h-5 w-5" />
            <h1 className="text-lg font-bold sm:text-xl">Garment Passport</h1>
          </div>
          <p className="text-sm text-white/80">
            Pseudonymous, confidence-scored provenance — no personal data.
          </p>
        </div>
      </div>

      <div className="mx-auto max-w-2xl space-y-6 px-6 py-8">
        <Breadcrumbs items={breadcrumbTrail} />

        {/* Garment summary */}
        <Card>
          <CardContent className="flex flex-wrap items-center justify-between gap-3 p-5">
            <div>
              <h2 className="text-xl font-bold text-foreground">{name}</h2>
              <p className="text-sm text-muted-foreground">
                {category ? formatLabel(category) : "Pre-owned garment"}
                {" · First graded "}
                {formatDate(data.created_at)}
              </p>
            </div>
            {latestScore !== null && latestTier && (
              <div className="text-right">
                <div className="text-3xl font-bold text-brand-red">
                  {latestScore.toFixed(1)}
                </div>
                <div className="text-xs text-muted-foreground">{latestTier}</div>
              </div>
            )}
          </CardContent>
          {/* US-1101: the origin seller's GradeThread Verified badge — public,
              opt-in trust that travels with the passport. */}
          {data.origin_verified_seller && (
            <CardContent className="flex flex-wrap items-center gap-2 border-t px-5 pb-5 pt-3 text-sm">
              <BadgeCheck className="h-4 w-4 text-brand-navy" />
              <span className="text-muted-foreground">Originally graded &amp; sold by</span>
              <Link
                to={`/verified/${data.origin_verified_seller.handle}`}
                className="font-medium text-brand-navy hover:underline"
              >
                {data.origin_verified_seller.display_name ||
                  `@${data.origin_verified_seller.handle}`}
              </Link>
              <Badge variant="outline" className="font-normal">
                Verified Seller
              </Badge>
            </CardContent>
          )}
        </Card>

        {/* US-1101: the trust that travels — the incentive to claim the chain.
            The buyer-guarantee and verified-seller trust attach to the passport,
            and the guarantee transfers to the new owner when they claim it. */}
        <Card className="border-brand-navy/30 bg-brand-navy/5">
          <CardContent className="flex flex-col gap-2 p-5 sm:flex-row sm:items-start">
            <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-brand-navy" />
            <div className="space-y-1 text-sm">
              <p className="font-medium text-foreground">
                The buyer guarantee transfers when you claim this passport
              </p>
              <p className="text-muted-foreground">
                A passported item carries GradeThread&rsquo;s condition-backed buyer
                guarantee. Claim ownership after you buy and the guarantee&nbsp;—&nbsp;and
                the item&rsquo;s full, confidence-scored history&nbsp;—&nbsp;follows you,
                so it&rsquo;s demonstrably safer to buy and easier to resell.
              </p>
              <Link
                to="/buyer-guarantee"
                className="inline-flex items-center gap-1 font-medium text-brand-navy hover:underline"
              >
                How the buyer guarantee works
                <ExternalLink className="h-3.5 w-3.5" />
              </Link>
            </div>
          </CardContent>
        </Card>

        {/* Provenance timeline */}
        <section>
          <h2 className="mb-4 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            Provenance timeline
          </h2>
          {data.events.length === 0 ? (
            <p className="text-sm text-muted-foreground">No history recorded yet.</p>
          ) : (
            <ol className="list-none">
              {data.events.map((event, i) => (
                <TimelineEvent
                  key={`${event.event_type}-${event.created_at}-${i}`}
                  event={event}
                  isLast={i === data.events.length - 1}
                />
              ))}
            </ol>
          )}
        </section>

        <p className="border-t pt-4 text-center text-xs text-muted-foreground">
          Each entry is labeled with how certain its link in the chain is.
          Participants are shown as pseudonymous labels only — GradeThread never
          exposes personal information on a public passport.
        </p>
      </div>
    </div>
  );
}
