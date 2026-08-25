import { useMemo, useState } from "react";
import { Link } from "react-router";
import {
  TrendingUp,
  ArrowRight,
  Tag,
  Search,
  ShieldCheck,
  Info,
} from "lucide-react";
import {
  MarketingLayout,
  MarketingCTA,
} from "@/components/marketing/marketing-layout";
import { Button } from "@/components/ui/button";
import { BuyerConversionCtas } from "@/components/marketing/buyer-conversion-ctas";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { whatsItWorthJsonLd } from "@/pages/marketing/marketing-jsonld";
import {
  useConditionIndexHub,
  useConditionIndexCurve,
  formatCurveCents,
  type ConditionCurvePoint,
} from "@/hooks/use-condition-index";
import { tierLabelForGrade } from "@/lib/condition-value-curve";
import { ValueBasisNote, type ValueBasis } from "@/components/value/value-basis-note";

// US-849: public "what's my item worth?" condition-value tool. A high-intent,
// top-of-funnel page: a visitor picks a Condition Index item + a condition
// grade and gets the typical resale value at that grade, read live from the
// public Condition Index curve. We only ever show
// published grades (points the lib deemed sufficient with a real median), show
// the comp count + freshness so we never imply false precision, and pair every
// estimate with a CTA to get a real, verifiable GradeThread grade.

/** Format a YYYY-...-ISO timestamp as a short, stable "Mon D, YYYY" date. */
function formatRefreshed(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

export function WhatsItWorthPage() {
  const [slug, setSlug] = useState<string | null>(null);
  const [grade, setGrade] = useState<number | null>(null);

  const hubQuery = useConditionIndexHub();
  const items = hubQuery.data ?? [];

  const curveQuery = useConditionIndexCurve(slug);
  const curve = curveQuery.data ?? null;

  // Only "published" grades are selectable: points the lib deemed sufficient
  // and that carry a real median (it suppresses thin curves so we never
  // fabricate a number). Sort high→low so NWT/Excellent lead.
  const publishedPoints = useMemo<ConditionCurvePoint[]>(
    () =>
      (curve?.points ?? [])
        .filter((p) => p.medianCents != null)
        .slice()
        .sort((a, b) => b.grade - a.grade),
    [curve],
  );

  const selected = useMemo(
    () => publishedPoints.find((p) => p.grade === grade) ?? null,
    [publishedPoints, grade],
  );

  function handlePickItem(nextSlug: string) {
    setSlug(nextSlug);
    setGrade(null); // grades differ per item — reset the picked grade
  }

  const currency = curve?.currency ?? "USD";

  return (
    <MarketingLayout
      title="What's My Used Clothing Worth?"
      description="Estimate what your used clothing is worth by brand, item, and condition grade — from real eBay sold-comparable data in the GradeThread Condition Index, then get a verifiable grade."
      canonicalPath="/whats-it-worth"
      jsonLd={whatsItWorthJsonLd()}
    >
      <section className="px-6 py-16 lg:py-20">
        <div className="mx-auto max-w-3xl">
          <span className="inline-flex items-center gap-1.5 rounded-full bg-brand-navy/10 px-3 py-1 text-xs font-semibold text-brand-navy dark:text-foreground">
            <TrendingUp className="h-3.5 w-3.5" />
            Condition Index
          </span>
          <h1 className="mt-4 text-4xl font-bold tracking-tight sm:text-5xl">
            What's my used clothing worth?
          </h1>
          <p className="mt-6 text-lg text-muted-foreground">
            Resale value comes down to the item and its condition. Pick a brand
            and item, choose a 1.0–10.0 condition grade, and we'll show the
            typical resale value at that grade — drawn from real eBay
            sold-comparable data in the GradeThread Condition Index, not a guess.
          </p>

          {/* The picker */}
          <div className="mt-10 rounded-xl border bg-card p-6 shadow-sm">
            <div className="grid gap-6 sm:grid-cols-2">
              {/* Item select */}
              <div>
                <label
                  htmlFor="wiw-item"
                  className="flex items-center gap-1.5 text-sm font-medium"
                >
                  <Tag className="h-4 w-4 text-brand-navy dark:text-foreground" />
                  Brand &amp; item
                </label>
                <Select value={slug ?? undefined} onValueChange={handlePickItem}>
                  <SelectTrigger id="wiw-item" className="mt-2 w-full">
                    <SelectValue
                      placeholder={
                        hubQuery.isLoading ? "Loading items…" : "Choose an item"
                      }
                    />
                  </SelectTrigger>
                  <SelectContent>
                    {items.map((it) => (
                      <SelectItem key={it.slug} value={it.slug}>
                        {it.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              {/* Grade select */}
              <div>
                <label
                  htmlFor="wiw-grade"
                  className="flex items-center gap-1.5 text-sm font-medium"
                >
                  <ShieldCheck className="h-4 w-4 text-brand-navy dark:text-foreground" />
                  Condition grade
                </label>
                <Select
                  value={grade != null ? String(grade) : undefined}
                  onValueChange={(v) => setGrade(Number(v))}
                  disabled={!slug || publishedPoints.length === 0}
                >
                  <SelectTrigger id="wiw-grade" className="mt-2 w-full">
                    <SelectValue
                      placeholder={
                        !slug
                          ? "Pick an item first"
                          : curveQuery.isLoading
                            ? "Loading grades…"
                            : publishedPoints.length === 0
                              ? "No published grades"
                              : "Choose a grade"
                      }
                    />
                  </SelectTrigger>
                  <SelectContent>
                    {publishedPoints.map((p) => (
                      <SelectItem key={p.grade} value={String(p.grade)}>
                        {p.grade.toFixed(1)} — {tierLabelForGrade(p.grade)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            {/* Result / empty states */}
            <div className="mt-6">
              {hubQuery.isError ? (
                <p className="flex items-center gap-2 rounded-lg border border-dashed bg-background p-4 text-sm text-muted-foreground">
                  <Info className="h-4 w-4 flex-shrink-0" />
                  We couldn't load the Condition Index right now. Please try again
                  in a moment.
                </p>
              ) : !slug ? (
                <p className="flex items-center gap-2 rounded-lg border border-dashed bg-background p-4 text-sm text-muted-foreground">
                  <Info className="h-4 w-4 flex-shrink-0" />
                  Choose a brand and item to get started.
                </p>
              ) : slug && publishedPoints.length === 0 && !curveQuery.isLoading ? (
                <p className="flex items-center gap-2 rounded-lg border border-dashed bg-background p-4 text-sm text-muted-foreground">
                  <Info className="h-4 w-4 flex-shrink-0" />
                  We don't have enough comparable listings to publish a value
                  for this item yet. The most reliable signal is still a real
                  condition grade.
                </p>
              ) : selected && selected.medianCents != null ? (
                <ResultCard
                  point={selected}
                  currency={currency}
                  label={curve?.label ?? ""}
                  brand={curve?.brand ?? null}
                  refreshedAt={curve?.refreshedAt}
                  disclosure={curve?.disclosure}
                  slug={slug}
                />
              ) : (
                <p className="flex items-center gap-2 rounded-lg border border-dashed bg-background p-4 text-sm text-muted-foreground">
                  <Info className="h-4 w-4 flex-shrink-0" />
                  Pick a condition grade to see its estimated resale value.
                </p>
              )}
            </div>
          </div>

          <p className="mt-4 text-xs text-muted-foreground">
            Estimates reflect recent sold comparables and are a guide, not a
            guarantee — actual sale prices vary with photos, timing, and demand.
          </p>
        </div>
      </section>

      {/* Why a real grade */}
      <section className="border-t bg-card px-6 py-16">
        <div className="mx-auto max-w-3xl">
          <h2 className="text-3xl font-bold">
            An estimate is a start — a grade is proof
          </h2>
          <p className="mt-4 text-muted-foreground">
            Knowing the going rate helps you price. But buyers pay more, and
            faster, when condition is independently verified. A GradeThread grade
            turns "Excellent (8/10)" from your opinion into an objective,
            shareable certificate any buyer can check.
          </p>
          <ul className="mt-6 space-y-3 text-sm text-muted-foreground">
            <li className="flex gap-2">
              <ShieldCheck className="mt-0.5 h-4 w-4 flex-shrink-0 text-brand-navy dark:text-foreground" />
              An objective 1.0–10.0 grade from one published rubric, not the
              seller's word.
            </li>
            <li className="flex gap-2">
              <ShieldCheck className="mt-0.5 h-4 w-4 flex-shrink-0 text-brand-navy dark:text-foreground" />
              A verifiable certificate with a QR code that buyers scan before they
              pay.
            </li>
            <li className="flex gap-2">
              <ShieldCheck className="mt-0.5 h-4 w-4 flex-shrink-0 text-brand-navy dark:text-foreground" />
              Fewer "not as described" disputes and returns — and faster sales.
            </li>
          </ul>
          <p className="mt-8 text-sm text-muted-foreground">
            New to condition grades? See what the{" "}
            <Link
              to="/condition-grading"
              className="font-medium text-brand-navy hover:underline dark:text-foreground"
            >
              1.0–10.0 scale and seven tiers
            </Link>{" "}
            mean, or browse the full{" "}
            <a
              href="/condition-index"
              className="font-medium text-brand-navy hover:underline dark:text-foreground"
            >
              Condition Index
            </a>
            .
          </p>
        </div>
      </section>

      <MarketingCTA
        heading="Get a real GradeThread grade"
        sub="Upload a few photos and turn your condition into an objective grade and a certificate buyers trust — so your items sell faster, closer to their real worth."
      />
    </MarketingLayout>
  );
}

function ResultCard({
  point,
  currency,
  label,
  brand,
  refreshedAt,
  disclosure,
  slug,
}: {
  point: ConditionCurvePoint;
  currency: string;
  label: string;
  brand: string | null;
  refreshedAt: string | undefined;
  disclosure: ValueBasis | undefined;
  slug: string;
}) {
  const median = formatCurveCents(point.medianCents as number, currency);
  const hasRange = point.lowCents != null && point.highCents != null;
  const refreshed = refreshedAt ? formatRefreshed(refreshedAt) : "";

  return (
    <div className="rounded-lg border border-brand-navy/30 bg-brand-navy/5 p-5">
      <p className="text-sm text-muted-foreground">
        A grade {point.grade.toFixed(1)} ({tierLabelForGrade(point.grade)}){" "}
        <span className="font-medium text-foreground">{label}</span> has a
        modeled resale estimate of about
      </p>
      <p className="mt-1 text-4xl font-bold tabular-nums text-brand-navy dark:text-foreground">
        {median}
      </p>
      {hasRange && (
        <p className="mt-1 text-sm text-muted-foreground tabular-nums">
          Typical range {formatCurveCents(point.lowCents as number, currency)} –{" "}
          {formatCurveCents(point.highCents as number, currency)}
        </p>
      )}
      {/* US-2850: the sample line, then what the sample actually is. The
          header comment on this file used to call these "real eBay sold
          comps"; they are active listings, so every figure on this page is an
          asking price. */}
      <p className="mt-3 text-xs text-muted-foreground">
        Modeled from {point.sampleSize.toLocaleString()} condition-matched
        listing{point.sampleSize === 1 ? "" : "s"} in this grade&rsquo;s
        condition band
        {refreshed ? ` · last refreshed ${refreshed}` : ""}.
      </p>
      <ValueBasisNote basis={disclosure} className="mt-2" />
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <Link to="/signup">
          <Button
            size="sm"
            className="bg-brand-red text-white hover:bg-brand-red/90"
          >
            Get a real grade
            <ArrowRight className="ml-1.5 h-4 w-4" />
          </Button>
        </Link>
        <a
          href={`/condition-index/${slug}`}
          className={cn(
            "inline-flex items-center gap-1 text-sm font-medium text-brand-navy hover:underline dark:text-foreground",
          )}
        >
          <Search className="h-4 w-4" />
          See the full {label} Condition Index
        </a>
      </div>

      {/* US-1843: the buyer half of this funnel. Same result, other side of the
          transaction — save it, watch for it, or verify what a seller claims. */}
      <BuyerConversionCtas
        className="mt-5 bg-background"
        tool="whats_it_worth"
        result={{
          slug,
          label,
          brand,
          grade: point.grade,
          tier: tierLabelForGrade(point.grade),
          medianCents: point.medianCents,
          lowCents: point.lowCents,
          highCents: point.highCents,
          currency,
          sampleSize: point.sampleSize,
        }}
      />
    </div>
  );
}
