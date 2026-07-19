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
  ArrowRight,
  Fingerprint,
  Calendar,
  Camera,
  Store,
  ScanLine,
  ExternalLink,
  History,
  type LucideIcon,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { SEO } from "@/components/seo";
import { Breadcrumbs } from "@/components/breadcrumbs";
import { CrossSurfaceNudge } from "@/components/cross-surface/cross-surface-nudge";
import {
  ConditionCurve,
  type ConditionCurvePoint,
} from "@/components/passport/condition-curve";
import { passportLd, breadcrumbLd } from "@/lib/seo/json-ld";
import { SITE_URL } from "@/lib/seo/site";
import { track } from "@/lib/analytics";
import { cn } from "@/lib/utils";
import { edgeApiUrl } from "@/lib/edge-api";
import {
  chainStrength,
  confidenceInfo,
  confidenceLevelOf,
} from "@/lib/passport-confidence";

// Mirrors the PII-free shape returned by the public passport endpoint
// (services/edge-functions/src/routes/passport.ts GET /:slug). The edge already
// sanitizes payloads and resolves actors to pseudonymous labels only — this
// page renders what it is given and never reaches for identity.
type PassportEvent = {
  event_type: string;
  confidence: "deterministic" | "probable" | "unknown" | string;
  actor: string | null;
  // US-1105: the actor's PUBLIC Verified identity, present ONLY when they opted
  // in to reveal it for this hop. null (the default) = stay pseudonymous.
  actor_revealed?: { handle: string; display_name: string | null } | null;
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
  // US-1282: condition-over-time curve across re-grades (per-factor deltas).
  grade_curve?: ConditionCurvePoint[];
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

// Confidence → badge visuals. The LABEL + TOOLTIP come from the shared taxonomy
// (lib/passport-confidence.ts) so the DB, edge, certificate, and this page never
// drift; only the per-level icon/colors live here.
type ConfidenceVisual = { icon: LucideIcon; classes: string };
const CONFIDENCE_VISUAL: Record<
  "deterministic" | "probable" | "unknown",
  ConfidenceVisual
> = {
  deterministic: {
    icon: ShieldCheck,
    classes:
      "bg-emerald-100 text-emerald-800 border-emerald-200 dark:bg-emerald-950/50 dark:text-emerald-300 dark:border-emerald-800",
  },
  probable: {
    icon: ShieldQuestion,
    classes:
      "bg-amber-100 text-amber-800 border-amber-200 dark:bg-amber-950/50 dark:text-amber-300 dark:border-amber-800",
  },
  unknown: {
    icon: CircleHelp,
    classes: "bg-slate-100 text-slate-700 border-slate-200",
  },
};
function confidenceVisual(c: string): ConfidenceVisual {
  return CONFIDENCE_VISUAL[confidenceLevelOf(c)];
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
  const conf = confidenceVisual(event.confidence);
  const confInfo = confidenceInfo(event.confidence);
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
            <Badge
              variant="outline"
              className={cn("gap-1", conf.classes)}
              title={confInfo.tooltip}
            >
              <ConfIcon className="h-3.5 w-3.5" />
              {confInfo.label}
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
            {event.actor_revealed?.handle
              ? (
                <Link
                  to={`/verified/${event.actor_revealed.handle}`}
                  className="inline-flex items-center gap-1 font-medium text-brand-navy hover:underline dark:text-blue-400"
                  title="This participant opted to reveal their Verified identity"
                >
                  <BadgeCheck className="h-3.5 w-3.5" />
                  {event.actor_revealed.display_name || `@${event.actor_revealed.handle}`}
                </Link>
              )
              : event.actor && <span>{event.actor}</span>}
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
  // US-1120: the public certificate handle from the most recent grade — the
  // headline proof a passport viewer can open and verify.
  const latestCertificate = latestGraded ? str(latestGraded.payload.certificate) : null;

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
          {/* US-1120: a prominent link to the latest grade certificate — the
              verifiable proof behind this passport. Previously the certificate
              only appeared buried in a timeline node. */}
          {latestCertificate && (
            <CardContent className="border-t px-5 pb-5 pt-3">
              <Button asChild className="w-full sm:w-auto">
                <Link
                  to={`/cert/${latestCertificate}`}
                  onClick={() =>
                    track("passport_certificate_cta_clicked", { slug: data.slug })
                  }
                >
                  <BadgeCheck className="mr-1.5 h-4 w-4" />
                  View the latest grade certificate
                  <ExternalLink className="ml-1.5 h-3.5 w-3.5" />
                </Link>
              </Button>
            </CardContent>
          )}
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

        {/* US-1102: aggregate chain-strength indicator — how many hops are
            independently verified vs. inferred. Measured copy (no over-claiming). */}
        {data.events.length > 0 && (() => {
          const strength = chainStrength(data.events.map((e) => e.confidence));
          const STRENGTH_CLASS: Record<string, string> = {
            Strong: "bg-emerald-100 text-emerald-800 border-emerald-200 dark:bg-emerald-950/50 dark:text-emerald-300 dark:border-emerald-800",
            Moderate: "bg-amber-100 text-amber-800 border-amber-200 dark:bg-amber-950/50 dark:text-amber-300 dark:border-amber-800",
            Emerging: "bg-slate-100 text-slate-700 border-slate-200",
            None: "bg-slate-100 text-slate-700 border-slate-200",
          };
          return (
            <Card>
              <CardContent className="space-y-3 p-5">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
                    Chain strength
                  </h2>
                  <Badge
                    variant="outline"
                    className={cn("gap-1", STRENGTH_CLASS[strength.label])}
                    title="How much of this chain is established by first-party facts (verified) vs. inferred matches."
                  >
                    <ShieldCheck className="h-3.5 w-3.5" />
                    {strength.label}
                  </Badge>
                </div>
                {/* Proven-share bar (deterministic links). */}
                <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
                  <div
                    className="h-full rounded-full bg-brand-navy"
                    style={{ width: `${Math.round(strength.score * 100)}%` }}
                  />
                </div>
                <p className="text-xs text-muted-foreground">
                  {strength.summary}
                  {strength.probable > 0 &&
                    ` ${strength.probable} ${strength.probable === 1 ? "link is" : "links are"} a probable (inferred) match.`}
                </p>
              </CardContent>
            </Card>
          );
        })()}

        {/* US-1282: condition-over-time curve. Only renders with ≥2 grades (a
            re-grade) — a single-grade garment has nothing to plot. */}
        {data.grade_curve && <ConditionCurve points={data.grade_curve} />}

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

        {/* US-1120: convert passport viewers instead of dead-ending. A buyer who
            owns the item can claim the chain; everyone else gets a measurable,
            dismissable path to grade their own item or sell on FlipDesk. */}
        <div className="space-y-3">
          <Card className="border-brand-navy/30 bg-brand-navy/5">
            <CardContent className="flex flex-col gap-3 p-5 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex items-start gap-3">
                <div className="rounded-md bg-brand-navy/10 p-2">
                  <ScanLine className="h-5 w-5 text-brand-navy dark:text-foreground" />
                </div>
                <div>
                  <p className="text-sm font-medium text-foreground">
                    Bought this item? Claim its passport
                  </p>
                  <p className="text-xs text-muted-foreground">
                    Enter the tag code from the seller to take ownership — the full
                    history and the buyer guarantee follow you.
                  </p>
                </div>
              </div>
              <Button asChild className="shrink-0 bg-brand-navy text-white hover:bg-brand-navy/90">
                <Link
                  to="/scan"
                  onClick={() => track("passport_claim_cta_clicked", { slug: data.slug })}
                >
                  Claim this passport
                  <ArrowRight className="ml-1.5 h-3.5 w-3.5" />
                </Link>
              </Button>
            </CardContent>
          </Card>

          <CrossSurfaceNudge
            nudgeId="passport-grade-your-own"
            icon={Camera}
            title="Grade your own garment"
            description="Get an objective 1.0–10.0 condition grade and a public passport buyers can scan and trust — in minutes."
            cta={{ label: "Grade an item", to: "/whats-it-worth" }}
            context={{ surface: "passport", slug: data.slug }}
          />
          <CrossSurfaceNudge
            nudgeId="passport-sell-flipdesk"
            icon={Store}
            title="Sell it faster with FlipDesk"
            description="List across marketplaces with the grade and passport built in — fewer “not as described” returns."
            cta={{ label: "See FlipDesk", to: "/for-resellers" }}
            context={{ surface: "passport", slug: data.slug }}
          />
        </div>

        <p className="border-t pt-4 text-center text-xs text-muted-foreground">
          Each entry is labeled with how certain its link in the chain is.
          Participants are shown as pseudonymous labels only — GradeThread never
          exposes personal information on a public passport.
        </p>
      </div>
    </div>
  );
}
