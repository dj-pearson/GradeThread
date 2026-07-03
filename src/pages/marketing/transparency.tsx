import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import {
  escapeJsonForScript,
  getTransparencySeed,
  readSeedFromDom,
  TRANSPARENCY_SEED_DOM_ID,
} from "@/lib/seo/transparency-seed";
import { ShieldCheck, GitCommitVertical, Gauge, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  MarketingLayout,
  MarketingCTA,
} from "@/components/marketing/marketing-layout";
import { edgeApiUrl } from "@/lib/edge-api";
import {
  TRANSPARENCY_FAQS,
  transparencyJsonLd,
} from "@/pages/marketing/marketing-jsonld";

// US-326: the public accuracy & transparency report. Substantiates the
// "trusted, self-improving grading authority" claim with PUBLISHED numbers,
// pulled live from the edge service's aggregate-only endpoint. The static
// methodology + FAQ render server-side (prerender); the figures hydrate on the
// client. When a metric has too little data to be truthful, we say so rather
// than print a misleading 0%.

interface TransparencyReport {
  generated_at: string;
  scale: { min: number; max: number; increment: number; tiers: number };
  volume: { items_graded: number; human_reviews: number; graded_sales: number };
  quality: {
    human_agreement_rate: number | null;
    mean_absolute_error: number | null;
    intentional_misread_rate: number | null;
    avg_confidence: number | null;
    human_review_rate: number | null;
  };
  outcomes: { dispute_rate: number | null };
  // US-866: per-garment-category accuracy/MAE breakdown (sample-gated, public-safe).
  category_quality: Array<{
    garment_category: string;
    mean_absolute_error: number;
    agreement_rate: number;
    reviews: number;
  }>;
  gate: { max_mae: number; min_agreement: number };
  model: { active: Array<{ stage: string; version_name: string }> };
  changelog: Array<{
    version_name: string;
    model: string;
    mean_absolute_error: number;
    agreement_rate: number;
    passed: boolean;
    created_at: string;
  }>;
  // US-334: human-vs-human reliability baseline (when a sufficient study exists).
  reliability: {
    study_name: string;
    pairable_items: number;
    tolerance: number;
    human_agreement_rate: number;
    human_mae: number;
    krippendorff_alpha: number | null;
    ai_agreement_rate: number | null;
    ai_meets_human: boolean | null;
  } | null;
}

const PENDING = "Not enough data yet";

function pct(rate: number | null, digits = 1): string {
  return rate === null || rate === undefined
    ? PENDING
    : `${(rate * 100).toFixed(digits)}%`;
}

function num(n: number | null, digits = 2): string {
  return n === null || n === undefined ? PENDING : n.toFixed(digits);
}

function count(n: number | undefined): string {
  return (n ?? 0).toLocaleString("en-US");
}

// Categories arrive as lowercase enum-ish slugs (e.g. "jeans", "t_shirts").
function categoryLabel(slug: string): string {
  return slug
    .split(/[_\s-]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

// US-1399: initial data comes from the build-time seed — during SSR from the
// module set by scripts/prerender.mjs, in the browser from the inline JSON
// script that same prerender baked into the HTML. Either way the numeric facts
// are present in the initial render (crawlers read them without JS; humans see
// them at hydration), and TanStack Query revalidates live as before. With no
// seed (CI build, fetch failed) this degrades to the old fetch-on-mount flow.
function resolveSeed(): TransparencyReport | null {
  return (readSeedFromDom() ?? getTransparencySeed()) as TransparencyReport | null;
}

function useTransparencyReport() {
  const seed = resolveSeed();
  return useQuery<TransparencyReport>({
    queryKey: ["transparency-report"],
    queryFn: async () => {
      const res = await fetch(`${edgeApiUrl()}/api/grading/public/transparency`);
      if (!res.ok) throw new Error(`Transparency report unavailable (${res.status})`);
      return res.json();
    },
    initialData: seed ?? undefined,
    staleTime: 10 * 60 * 1000,
    retry: 1,
  });
}

function MetricCard({
  label,
  value,
  sub,
}: {
  label: string;
  value: string;
  sub?: string;
}) {
  const pending = value === PENDING;
  return (
    <div className="rounded-lg border bg-background p-5">
      <p className="text-sm text-muted-foreground">{label}</p>
      <p
        className={
          pending
            ? "mt-2 text-base font-medium text-muted-foreground"
            : "mt-2 text-3xl font-bold tracking-tight text-brand-navy dark:text-foreground"
        }
      >
        {value}
      </p>
      {sub ? <p className="mt-1 text-xs text-muted-foreground">{sub}</p> : null}
    </div>
  );
}

export function TransparencyPage() {
  const { data, isLoading, isError } = useTransparencyReport();
  const q = data?.quality;

  return (
    <>
      {/* US-1399: embed the report so (a) the prerendered HTML carries it for
          the live SPA's initialData and (b) hydration shows the same numbers
          the crawlable HTML had — no numbers→spinner→numbers flash. */}
      {data && (
        <script
          type="application/json"
          id={TRANSPARENCY_SEED_DOM_ID}
          dangerouslySetInnerHTML={{ __html: escapeJsonForScript(data) }}
        />
      )}
    <MarketingLayout
      title="Grading Accuracy & Transparency Report"
      description="GradeThread's published clothing-grading accuracy: AI-vs-human agreement, error against expert reviewers, intentional-design misread rate, confidence, and buyer dispute rate — plus the eval gate and model changelog behind a self-improving standard."
      canonicalPath="/transparency"
      jsonLd={transparencyJsonLd()}
    >
      {/* Hero */}
      <section className="px-6 py-16 lg:py-20">
        <div className="mx-auto max-w-3xl">
          <div className="inline-flex items-center gap-2 rounded-full border bg-card px-3 py-1 text-xs font-medium text-muted-foreground">
            <ShieldCheck className="h-3.5 w-3.5 text-brand-navy dark:text-foreground" />
            Published, not promised
          </div>
          <h1 className="mt-5 text-4xl font-bold tracking-tight sm:text-5xl">
            Grading accuracy & transparency report
          </h1>
          <p className="mt-6 text-lg text-muted-foreground">
            A grade is only worth trusting if its accuracy is measured and shown.
            This page reports, platform-wide, how closely GradeThread's AI grades
            match expert human reviewers, how confident the model is, and how
            often buyers dispute a graded item — alongside the eval gate and model
            changelog that keep the standard improving over time.
          </p>
          {data?.generated_at ? (
            <p className="mt-3 text-xs text-muted-foreground">
              Last updated {new Date(data.generated_at).toLocaleString("en-US")}
            </p>
          ) : null}
        </div>
      </section>

      {/* Headline metrics */}
      <section className="border-t bg-card px-6 py-16">
        <div className="mx-auto max-w-5xl">
          <div className="flex items-center gap-2">
            <Gauge className="h-5 w-5 text-brand-navy dark:text-foreground" />
            <h2 className="text-2xl font-bold">How accurate the grades are</h2>
          </div>
          <p className="mt-3 max-w-3xl text-muted-foreground">
            Whenever a human expert reviews a grade, we compare their score to the
            AI's. These figures cover every reviewed grade across the platform.
          </p>

          {isError ? (
            <p className="mt-8 rounded-lg border border-dashed p-6 text-sm text-muted-foreground">
              Live figures are temporarily unavailable. The methodology below
              describes exactly what we measure and how.
            </p>
          ) : (
            <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              <MetricCard
                label="AI-vs-human agreement"
                value={isLoading ? "…" : pct(q?.human_agreement_rate ?? null)}
                sub="Grades within half a point of the human reviewer"
              />
              <MetricCard
                label="Mean error vs. reviewers"
                value={isLoading ? "…" : num(q?.mean_absolute_error ?? null)}
                sub="Average points of difference (lower is better)"
              />
              <MetricCard
                label="Average model confidence"
                value={isLoading ? "…" : pct(q?.avg_confidence ?? null)}
                sub="Across recent grades"
              />
              <MetricCard
                label="Routed to human review"
                value={isLoading ? "…" : pct(q?.human_review_rate ?? null)}
                sub="Low-confidence grades checked before finalizing"
              />
              <MetricCard
                label="Intentional-design misread rate"
                value={isLoading ? "…" : pct(q?.intentional_misread_rate ?? null)}
                sub="Design (e.g. distressing) mistaken for damage — lower is better"
              />
              <MetricCard
                label="Buyer dispute rate"
                value={isLoading ? "…" : pct(data?.outcomes.dispute_rate ?? null)}
                sub="Of opted-in graded sales"
              />
            </div>
          )}

          {/* Volume */}
          <div className="mt-6 grid gap-4 sm:grid-cols-3">
            <MetricCard
              label="Items graded"
              value={isLoading ? "…" : count(data?.volume.items_graded)}
            />
            <MetricCard
              label="Expert reviews"
              value={isLoading ? "…" : count(data?.volume.human_reviews)}
            />
            <MetricCard
              label="Graded sales tracked"
              value={isLoading ? "…" : count(data?.volume.graded_sales)}
            />
          </div>
        </div>
      </section>

      {/* US-866: per-category accuracy breakdown */}
      <section className="border-t px-6 py-16">
        <div className="mx-auto max-w-5xl">
          <h2 className="text-2xl font-bold">Accuracy by garment category</h2>
          <p className="mt-3 max-w-3xl text-muted-foreground">
            Some categories are harder to grade than others — distressed denim is
            easy to misread, a plain tee is not. We break the same AI-vs-human
            comparison down by category so the number isn't a single average that
            hides where grading is weakest. A category appears once it has enough
            reviewed grades to report truthfully.
          </p>
          {data && data.category_quality.length > 0 ? (
            <div className="mt-8 overflow-x-auto rounded-lg border">
              <table className="w-full text-sm">
                <thead className="bg-muted/50">
                  <tr>
                    <th className="px-4 py-3 text-left font-semibold">Category</th>
                    <th className="px-4 py-3 text-right font-semibold">Agreement</th>
                    <th className="px-4 py-3 text-right font-semibold">Mean error</th>
                    <th className="px-4 py-3 text-right font-semibold">Reviews</th>
                  </tr>
                </thead>
                <tbody>
                  {data.category_quality.map((row) => (
                    <tr key={row.garment_category} className="border-t">
                      <td className="px-4 py-3 font-medium">
                        {categoryLabel(row.garment_category)}
                      </td>
                      <td className="px-4 py-3 text-right">
                        {pct(row.agreement_rate, 0)}
                      </td>
                      <td className="px-4 py-3 text-right">
                        {num(row.mean_absolute_error)}
                      </td>
                      <td className="px-4 py-3 text-right text-muted-foreground">
                        {count(row.reviews)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="mt-8 rounded-lg border border-dashed p-6 text-sm text-muted-foreground">
              {isLoading
                ? "Loading category breakdown…"
                : "Per-category accuracy appears here once individual garment categories have enough reviewed grades to report a meaningful number."}
            </p>
          )}
        </div>
      </section>

      {/* US-334/US-866: human-vs-human reliability baseline (published studies only) */}
      {data && !data.reliability && (
        <section className="border-t px-6 py-16">
          <div className="mx-auto max-w-5xl">
            <h2 className="text-2xl font-bold">
              How good is “good”? The expert baseline
            </h2>
            <p className="mt-3 max-w-3xl text-muted-foreground">
              The fairest bar for an AI grader is how often two human experts
              agree with each other. We measure that in blind multi-rater
              reliability studies and publish the baseline here once a study is
              complete and reviewed.
            </p>
            <p className="mt-8 rounded-lg border border-dashed p-6 text-sm text-muted-foreground">
              Baseline pending — a published reliability study will appear here
              with expert-vs-expert agreement, mean error, and how the AI compares.
            </p>
          </div>
        </section>
      )}
      {data?.reliability && (
        <section className="border-t px-6 py-16">
          <div className="mx-auto max-w-5xl">
            <h2 className="text-2xl font-bold">
              How good is “good”? The expert baseline
            </h2>
            <p className="mt-3 max-w-3xl text-muted-foreground">
              In a blind study, multiple expert reviewers graded the same{" "}
              {data.reliability.pairable_items} items without seeing the AI grade
              or one another’s scores. That tells us how often two experts even
              agree with each other — the fair bar to hold the AI to.
              {data.reliability.ai_meets_human && (
                <>
                  {" "}
                  <strong className="text-foreground">
                    The AI agrees with the expert consensus at least as often as
                    the experts agree with each other.
                  </strong>
                </>
              )}
            </p>
            <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <MetricCard
                label="Expert-vs-expert agreement"
                value={pct(data.reliability.human_agreement_rate)}
                sub={`within ±${data.reliability.tolerance}`}
              />
              <MetricCard
                label="AI-vs-expert agreement"
                value={pct(data.reliability.ai_agreement_rate)}
                sub="vs the human consensus"
              />
              <MetricCard
                label="Expert-vs-expert error"
                value={num(data.reliability.human_mae)}
                sub="mean points apart"
              />
              <MetricCard
                label="Reliability (Krippendorff α)"
                value={
                  data.reliability.krippendorff_alpha === null
                    ? PENDING
                    : data.reliability.krippendorff_alpha.toFixed(2)
                }
                sub="1.0 = perfect agreement"
              />
            </div>
          </div>
        </section>
      )}

      {/* The self-improvement loop */}
      <section className="px-6 py-16">
        <div className="mx-auto max-w-3xl">
          <div className="flex items-center gap-2">
            <RefreshCw className="h-5 w-5 text-brand-navy dark:text-foreground" />
            <h2 className="text-2xl font-bold">How the standard improves over time</h2>
          </div>
          <p className="mt-3 text-muted-foreground">
            Accuracy isn't a one-time claim — it's maintained by a closed loop.
          </p>
          <ol className="mt-8 space-y-6">
            {[
              {
                t: "Every grade is attributed to a model version",
                d: "So accuracy can be measured per version, per factor, and per garment category — not as a single vague average.",
              },
              {
                t: "Human reviewers correct and the loop learns",
                d: "Reviewer corrections (including when design was mistaken for damage) and post-sale buyer disputes are fed back as signal on where grading drifts.",
              },
              {
                t: "New models must clear a published eval gate",
                d: data
                  ? `A candidate version cannot grade live items until it beats a maximum error of ${data.gate.max_mae.toFixed(
                      1,
                    )} and at least ${(data.gate.min_agreement * 100).toFixed(
                      0,
                    )}% agreement on a golden set of expert-graded garments.`
                  : "A candidate version cannot grade live items until it beats a fixed maximum error and minimum agreement on a golden set of expert-graded garments.",
              },
              {
                t: "An automated monitor watches for regressions",
                d: "On a schedule, the live grader is re-checked against the golden set and against production reviews and disputes. If quality drifts below threshold, the team is alerted before it slips further.",
              },
            ].map((step, i) => (
              <li key={step.t} className="flex gap-4">
                <span className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-brand-navy text-sm font-bold text-white">
                  {i + 1}
                </span>
                <div>
                  <p className="font-medium text-foreground">{step.t}</p>
                  <p className="mt-1 text-sm text-muted-foreground">{step.d}</p>
                </div>
              </li>
            ))}
          </ol>
        </div>
      </section>

      {/* Model changelog */}
      <section className="border-t bg-card px-6 py-16">
        <div className="mx-auto max-w-3xl">
          <div className="flex items-center gap-2">
            <GitCommitVertical className="h-5 w-5 text-brand-navy dark:text-foreground" />
            <h2 className="text-2xl font-bold">Model changelog</h2>
          </div>
          <p className="mt-3 text-muted-foreground">
            Grading model versions that have cleared the eval gate, newest first.
            Each row is a version proven against the golden set before it went
            live.
          </p>
          {data && data.changelog.length > 0 ? (
            <div className="mt-8 overflow-x-auto rounded-lg border">
              <table className="w-full text-sm">
                <thead className="bg-muted/50">
                  <tr>
                    <th className="px-4 py-3 text-left font-semibold">Version</th>
                    <th className="px-4 py-3 text-right font-semibold">Error</th>
                    <th className="px-4 py-3 text-right font-semibold">Agreement</th>
                    <th className="px-4 py-3 text-right font-semibold">Cleared</th>
                  </tr>
                </thead>
                <tbody>
                  {data.changelog.map((r, i) => (
                    <tr key={`${r.version_name}-${i}`} className="border-t">
                      <td className="px-4 py-3 font-medium">{r.version_name}</td>
                      <td className="px-4 py-3 text-right">
                        {r.mean_absolute_error.toFixed(2)}
                      </td>
                      <td className="px-4 py-3 text-right">
                        {(r.agreement_rate * 100).toFixed(0)}%
                      </td>
                      <td className="px-4 py-3 text-right text-muted-foreground">
                        {new Date(r.created_at).toLocaleDateString("en-US")}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="mt-8 rounded-lg border border-dashed p-6 text-sm text-muted-foreground">
              Eval-gated model releases will appear here as new grading versions
              are promoted.
            </p>
          )}
          <p className="mt-6 text-sm text-muted-foreground">
            For the full rubric and weighting behind every grade, see the{" "}
            <Link
              to="/grading-standard"
              className="font-medium text-brand-navy hover:underline dark:text-foreground"
            >
              grading standard
            </Link>
            .
          </p>
        </div>
      </section>

      {/* FAQ */}
      <section className="border-t px-6 py-16">
        <div className="mx-auto max-w-2xl">
          <h2 className="text-center text-3xl font-bold">Transparency FAQ</h2>
          <dl className="mt-10 space-y-6">
            {TRANSPARENCY_FAQS.map((faq) => (
              <div key={faq.q} className="border-b pb-6 last:border-b-0">
                <dt className="font-medium">{faq.q}</dt>
                <dd className="mt-2 text-sm text-muted-foreground">{faq.a}</dd>
              </div>
            ))}
          </dl>
          <div className="mt-10 text-center">
            <Link to="/signup">
              <Button
                size="lg"
                className="bg-brand-navy text-white hover:bg-brand-navy/90"
              >
                Grade an item free
              </Button>
            </Link>
          </div>
        </div>
      </section>

      <MarketingCTA />
    </MarketingLayout>
    </>
  );
}
