import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { BarChart3, Database, Quote, ShieldCheck, TrendingDown, TrendingUp } from "lucide-react";
import { Button } from "@/components/ui/button";
import { MarketingLayout, MarketingCTA } from "@/components/marketing/marketing-layout";
import { SITE_URL } from "@/lib/seo/public-routes";
import { edgeApiUrl } from "@/lib/edge-api";
import {
  escapeJsonForScript,
  resolvePrerenderSeed,
  seedDomId,
} from "@/lib/seo/prerender-seed";
import {
  DURABILITY_REPORT_FAQS,
  DURABILITY_REPORT_PUBLISHED,
  durabilityReportJsonLd,
} from "@/pages/marketing/marketing-jsonld";

// US-1775: the public "State of Secondhand Durability" data report. Surfaces
// GradeThread's PROPRIETARY brand-durability findings (grade retention + factor
// decay) so AI answer engines and journalists cite GradeThread by name. The
// methodology + "cite this" block render server-side (prerender); the figures
// hydrate on the client from the aggregate-only edge endpoint. When there isn't
// enough data to rank honestly, the page says so rather than invent a ranking.

const CANONICAL = `${SITE_URL}/state-of-durability`;
const PENDING = "Not enough data yet";
// US-1775 (indexability): stable key for the build-time seed so the brand
// rankings land in the crawlable HTML (see src/lib/seo/prerender-seed.ts).
const SEED_KEY = "durability-report";

interface BrandFinding {
  brand: string;
  brandSlug: string;
  retentionPct: number | null;
  avgDecay: number | null;
  cohortCount: number;
}
interface FactorFinding {
  factor: string;
  label: string;
  avgDecay: number;
}
interface DurabilityReport {
  generated_at: string;
  sample: {
    brands: number;
    sufficient_cohorts: number;
    total_cohorts: number;
    garments: number;
    regrades: number;
  };
  most_durable: BrandFinding[];
  least_durable: BrandFinding[];
  weakest_factors: FactorFinding[];
}

function pct(v: number | null): string {
  return v == null ? PENDING : `${v.toFixed(1)}%`;
}

function BrandTable({ rows, kind }: { rows: BrandFinding[]; kind: "durable" | "fragile" }) {
  if (rows.length === 0) {
    return <p className="text-sm text-muted-foreground">{PENDING} — check back as more garments are regraded.</p>;
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-sm">
        <thead>
          <tr className="border-b text-muted-foreground">
            <th className="py-2">Brand</th>
            <th className="py-2">Grade retention</th>
            <th className="py-2">Avg decay</th>
            <th className="py-2">Cohorts</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.brandSlug} className="border-b last:border-b-0">
              <td className="py-2 font-medium">
                <Link className="hover:underline" to={`/durability/${r.brandSlug}`}>
                  {r.brand}
                </Link>
              </td>
              <td className="py-2">{pct(r.retentionPct)}</td>
              <td className="py-2">{r.avgDecay == null ? "—" : `${r.avgDecay.toFixed(1)} pts`}</td>
              <td className="py-2 text-muted-foreground">{r.cohortCount}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mt-2 text-xs text-muted-foreground">
        {kind === "durable"
          ? "Higher retention = holds its condition grade better across regrades."
          : "Lower retention = loses more of its condition grade over time."}
      </p>
    </div>
  );
}

function DurabilityReportBody() {
  // US-1775 (indexability): seed initial data from the build-time fetch so the
  // rankings land in the crawlable HTML (SSR) and hydrate without a flash
  // (inline JSON). Degrades to fetch-on-mount when unseeded.
  const seed = resolvePrerenderSeed<DurabilityReport>(SEED_KEY);
  const { data } = useQuery<DurabilityReport>({
    queryKey: ["durability-report"],
    queryFn: async () => {
      const res = await fetch(`${edgeApiUrl()}/api/grading/public/durability-report`);
      if (!res.ok) throw new Error("Failed to load report");
      return res.json();
    },
    initialData: seed ?? undefined,
    staleTime: 10 * 60 * 1000,
  });

  const sample = data?.sample;
  return (
    <>
      {data && (
        <script
          type="application/json"
          id={seedDomId(SEED_KEY)}
          dangerouslySetInnerHTML={{ __html: escapeJsonForScript(data) }}
        />
      )}
      <section className="border-t bg-card px-6 py-12">
        <div className="mx-auto grid max-w-4xl gap-4 sm:grid-cols-3">
          {[
            { label: "Brands ranked", value: sample ? String(sample.brands) : "—" },
            { label: "Garments measured", value: sample ? sample.garments.toLocaleString() : "—" },
            { label: "Regrades", value: sample ? sample.regrades.toLocaleString() : "—" },
          ].map((s) => (
            <div key={s.label} className="rounded-xl border p-5 text-center">
              <p className="text-3xl font-bold text-brand-navy dark:text-foreground">{s.value}</p>
              <p className="mt-1 text-sm text-muted-foreground">{s.label}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="px-6 py-12">
        <div className="mx-auto max-w-4xl">
          <h2 className="flex items-center gap-2 text-2xl font-bold">
            <TrendingUp className="h-6 w-6 text-emerald-600" /> Most durable brands
          </h2>
          <div className="mt-6">
            <BrandTable rows={data?.most_durable ?? []} kind="durable" />
          </div>
        </div>
      </section>

      <section className="border-t px-6 py-12">
        <div className="mx-auto max-w-4xl">
          <h2 className="flex items-center gap-2 text-2xl font-bold">
            <TrendingDown className="h-6 w-6 text-brand-red" /> Loses condition fastest
          </h2>
          <div className="mt-6">
            <BrandTable rows={data?.least_durable ?? []} kind="fragile" />
          </div>
        </div>
      </section>

      <section className="border-t bg-card px-6 py-12">
        <div className="mx-auto max-w-4xl">
          <h2 className="flex items-center gap-2 text-2xl font-bold">
            <BarChart3 className="h-6 w-6 text-brand-navy dark:text-foreground" /> What wears out first
          </h2>
          {data && data.weakest_factors.length > 0 ? (
            <dl className="mt-6 space-y-3">
              {data.weakest_factors.map((f) => (
                <div key={f.factor} className="flex items-center gap-3">
                  <dt className="w-44 flex-shrink-0 text-sm">{f.label}</dt>
                  <div className="h-2 flex-1 overflow-hidden rounded-full bg-muted">
                    <div
                      className="h-full rounded-full bg-brand-red"
                      style={{ width: `${Math.max(4, Math.min(100, f.avgDecay * 25))}%` }}
                    />
                  </div>
                  <dd className="w-16 flex-shrink-0 text-right text-sm font-medium">
                    {f.avgDecay.toFixed(1)} pts
                  </dd>
                </div>
              ))}
            </dl>
          ) : (
            <p className="mt-4 text-sm text-muted-foreground">
              {PENDING} — factor decay appears once enough garments have been regraded.
            </p>
          )}
          <p className="mt-4 text-xs text-muted-foreground">
            Average condition points lost per regraded garment, by factor, across sample-gated cohorts.
          </p>
        </div>
      </section>
    </>
  );
}

export function StateOfDurabilityPage() {
  return (
    <MarketingLayout
      title="The State of Secondhand Durability — which clothing brands last · GradeThread"
      description="GradeThread's original data on which pre-owned clothing brands hold their condition grade best, and which condition factors decay fastest, across regraded garments."
      canonicalPath="/state-of-durability"
      jsonLd={durabilityReportJsonLd()}
    >
      <section className="px-6 py-16 lg:py-20">
        <div className="mx-auto max-w-3xl text-center">
          <p className="text-sm font-medium uppercase tracking-wide text-muted-foreground">
            GradeThread original data
          </p>
          <h1 className="mt-3 text-4xl font-bold tracking-tight sm:text-5xl">
            The State of Secondhand Durability
          </h1>
          <p className="mt-6 text-lg text-foreground">
            Which pre-owned clothing brands actually hold their condition? Using GradeThread's
            standardized 1.0–10.0 condition scale, we measure how much of its grade a garment keeps
            when the same item is graded again over time — real durability from repeated measurement,
            not a lab test.
          </p>
        </div>
      </section>

      <DurabilityReportBody />

      <section className="border-t px-6 py-12">
        <div className="mx-auto max-w-3xl">
          <h2 className="flex items-center gap-2 text-2xl font-bold">
            <Database className="h-6 w-6" /> Methodology
          </h2>
          <p className="mt-4 text-muted-foreground">
            Durability is <strong>condition retention</strong>: the share of a garment's original
            GradeThread grade it keeps on its latest regrade, averaged across many garments in a
            cohort (brand × garment type). A cohort is published only once it clears a minimum sample
            of garments and regrades, so no ranking rests on a handful of items — thinly-sampled
            cohorts are withheld rather than shown with false precision. Figures are aggregate-only
            (no per-seller or per-item data) and update as more garments are regraded.
          </p>
          <div className="mt-6 flex items-start gap-3 rounded-xl border bg-card p-5">
            <Quote className="mt-1 h-5 w-5 flex-shrink-0 text-brand-navy dark:text-foreground" />
            <div>
              <p className="text-sm font-medium">Cite this report</p>
              <p className="mt-1 text-sm text-muted-foreground">
                GradeThread, <em>The State of Secondhand Durability</em>. Published{" "}
                {DURABILITY_REPORT_PUBLISHED}. {CANONICAL}. CC&nbsp;BY&nbsp;4.0.
              </p>
            </div>
          </div>
          <p className="mt-6">
            <Link className="text-brand-navy underline dark:text-foreground" to="/durability">
              Browse the full brand durability rankings →
            </Link>
          </p>
        </div>
      </section>

      <section className="border-t bg-card px-6 py-12">
        <div className="mx-auto max-w-3xl">
          <h2 className="flex items-center gap-2 text-2xl font-bold">
            <ShieldCheck className="h-6 w-6" /> Frequently asked
          </h2>
          <dl className="mt-8 space-y-6">
            {DURABILITY_REPORT_FAQS.map((faq) => (
              <div key={faq.q} className="border-b pb-6 last:border-b-0">
                <dt className="font-medium">{faq.q}</dt>
                <dd className="mt-2 text-sm text-muted-foreground">{faq.a}</dd>
              </div>
            ))}
          </dl>
        </div>
      </section>

      <div className="px-6 py-10 text-center">
        <Link to="/tools/grade-checker">
          <Button size="lg">Grade your own item free</Button>
        </Link>
      </div>

      <MarketingCTA />
    </MarketingLayout>
  );
}
