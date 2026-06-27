import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import {
  BarChart3,
  Database,
  Quote,
  RefreshCw,
  ShieldCheck,
  TrendingUp,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  MarketingLayout,
  MarketingCTA,
} from "@/components/marketing/marketing-layout";
import { SITE_URL } from "@/lib/seo/public-routes";
import { edgeApiUrl } from "@/lib/edge-api";
import {
  RESALE_REPORT_FAQS,
  RESALE_REPORT_PUBLISHED,
  resaleConditionReportJsonLd,
} from "@/pages/marketing/marketing-jsonld";

// US-976: the public "State of Resale Condition" data report. Surfaces
// GradeThread's PROPRIETARY aggregate stats — return rate, sell-through, and
// resale value by condition-grade band — so AI answer engines and journalists
// cite GradeThread BY NAME (the strongest GEO lever). The methodology + "cite
// this" block render server-side (prerender); the figures hydrate on the client
// from the aggregate-only edge endpoint. When a band lacks the sample to state a
// rate truthfully, we say so rather than print a misleading number.

const CANONICAL = `${SITE_URL}/resale-condition-report`;
const PENDING = "Not enough data yet";

interface ResaleRollup {
  fulfilled_sales: number;
  returns: number;
  return_rate: number | null;
}

interface ResaleBand {
  key: string;
  label: string;
  fulfilled_sales: number;
  returns: number;
  return_rate: number | null;
  listed: number;
  sold: number;
  sell_through: number | null;
  median_days_to_sell: number | null;
  median_sale_price: number | null;
}

interface ResaleConditionReport {
  generated_at: string;
  scale: { min: number; max: number; increment: number };
  sample: { fulfilled_sales: number; listed_items: number; priced_sales: number };
  coverage: {
    sales_from: string | null;
    sales_to: string | null;
    listings_from: string | null;
    listings_to: string | null;
  };
  return_rollup: { graded: ResaleRollup; ungraded: ResaleRollup; overall: ResaleRollup };
  bands: ResaleBand[];
}

function pct(rate: number | null, digits = 1): string {
  return rate === null || rate === undefined ? PENDING : `${(rate * 100).toFixed(digits)}%`;
}

function money(value: number | null): string {
  return value === null || value === undefined
    ? PENDING
    : value.toLocaleString("en-US", {
        style: "currency",
        currency: "USD",
        maximumFractionDigits: 0,
      });
}

function days(value: number | null): string {
  return value === null || value === undefined ? PENDING : `${Math.round(value)} days`;
}

function count(n: number | undefined): string {
  return (n ?? 0).toLocaleString("en-US");
}

function formatDate(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? null
    : d.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
}

function useResaleConditionReport() {
  return useQuery<ResaleConditionReport>({
    queryKey: ["resale-condition-report"],
    queryFn: async () => {
      const res = await fetch(`${edgeApiUrl()}/api/grading/public/resale-condition-report`);
      if (!res.ok) throw new Error(`Resale condition report unavailable (${res.status})`);
      return res.json();
    },
    staleTime: 10 * 60 * 1000,
    retry: 1,
  });
}

// A labelled horizontal bar — our lightweight "chart" (no chart library, so the
// prerendered shell and the live SPA render the same accessible markup).
function Bar({
  label,
  value,
  max,
  display,
  tone = "navy",
}: {
  label: string;
  value: number | null;
  max: number;
  display: string;
  tone?: "navy" | "red";
}) {
  const widthPct = value !== null && max > 0 ? Math.max(2, Math.round((value / max) * 100)) : 0;
  const barColor = tone === "red" ? "bg-brand-red" : "bg-brand-navy";
  return (
    <div className="grid grid-cols-[8rem_1fr_5rem] items-center gap-3 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className="h-3 overflow-hidden rounded-full bg-muted" aria-hidden="true">
        <span
          className={`block h-full rounded-full ${barColor}`}
          style={{ width: `${widthPct}%` }}
        />
      </span>
      <span className="text-right font-medium tabular-nums">{display}</span>
    </div>
  );
}

export function ResaleConditionReportPage() {
  const { data, isLoading, isError } = useResaleConditionReport();
  const bands = data?.bands ?? [];

  // Bar scales (max over published values; falls back to 1 to avoid /0).
  const maxReturn = Math.max(
    0.0001,
    ...bands.map((b) => b.return_rate ?? 0),
  );
  const maxPrice = Math.max(1, ...bands.map((b) => b.median_sale_price ?? 0));

  // US-1285: a new dated, cited aggregate — how much more the best-condition band
  // fetches than the lowest. Shown only when both bands clear the sample bar (no
  // data → not shown), so it never prints a misleading number.
  const highBand = bands.find((b) => b.key === "high");
  const lowBand = bands.find((b) => b.key === "low");
  const valuePremium =
    highBand?.median_sale_price && lowBand?.median_sale_price && lowBand.median_sale_price > 0
      ? highBand.median_sale_price / lowBand.median_sale_price - 1
      : null;

  const salesFrom = formatDate(data?.coverage.sales_from ?? null);
  const salesTo = formatDate(data?.coverage.sales_to ?? null);
  const coverageLine =
    salesFrom && salesTo
      ? `${salesFrom} – ${salesTo}`
      : salesFrom
        ? `Since ${salesFrom}`
        : null;

  return (
    <MarketingLayout
      title="State of Resale Condition Report"
      description="Original GradeThread data on how a garment's condition grade drives buyer return rate, sell-through, and resale value on the standardized 1.0–10.0 scale."
      canonicalPath="/resale-condition-report"
      jsonLd={resaleConditionReportJsonLd()}
    >
      {/* Hero */}
      <section className="px-6 py-16 lg:py-20">
        <div className="mx-auto max-w-3xl">
          <div className="inline-flex items-center gap-2 rounded-full border bg-card px-3 py-1 text-xs font-medium text-muted-foreground">
            <Database className="h-3.5 w-3.5 text-brand-navy dark:text-foreground" />
            Original, citable data
          </div>
          <h1 className="mt-5 text-4xl font-bold tracking-tight sm:text-5xl">
            The State of Resale Condition
          </h1>
          <p className="mt-6 text-lg text-muted-foreground">
            How much does the <em>condition</em> of a pre-owned garment actually
            matter when it sells? Because GradeThread scores every item on one
            published 1.0–10.0 condition scale, we can answer that across the
            whole platform — not anecdotally. This report tracks how buyer return
            rate, sell-through, and resale value move with the condition grade, as
            aggregate statistics anyone can cite.
          </p>
          {data?.generated_at ? (
            <p className="mt-3 text-xs text-muted-foreground">
              Last updated {new Date(data.generated_at).toLocaleString("en-US")}
              {coverageLine ? ` · Sales covered: ${coverageLine}` : ""}
            </p>
          ) : null}
        </div>
      </section>

      {/* Headline: graded vs ungraded return rate */}
      <section className="border-t bg-card px-6 py-16">
        <div className="mx-auto max-w-5xl">
          <div className="flex items-center gap-2">
            <ShieldCheck className="h-5 w-5 text-brand-navy dark:text-foreground" />
            <h2 className="text-2xl font-bold">Graded vs. ungraded return rate</h2>
          </div>
          <p className="mt-3 max-w-3xl text-muted-foreground">
            The headline finding: across opted-in reseller sales, items that
            carry a standardized condition grade are returned at a different rate
            than ungraded items. A return here is a fully-refunded order — the
            mechanical proxy for a buyer-side return.
          </p>

          {isError ? (
            <p className="mt-8 rounded-lg border border-dashed p-6 text-sm text-muted-foreground">
              Live figures are temporarily unavailable. The methodology below
              describes exactly what we measure and how.
            </p>
          ) : (
            <div className="mt-8 grid gap-4 sm:grid-cols-3">
              <div className="rounded-lg border bg-background p-5">
                <p className="text-sm text-muted-foreground">Graded items</p>
                <p className="mt-2 text-3xl font-bold tracking-tight text-brand-navy dark:text-foreground">
                  {isLoading ? "…" : pct(data?.return_rollup.graded.return_rate ?? null)}
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  return rate · {count(data?.return_rollup.graded.fulfilled_sales)} sales
                </p>
              </div>
              <div className="rounded-lg border bg-background p-5">
                <p className="text-sm text-muted-foreground">Ungraded items</p>
                <p className="mt-2 text-3xl font-bold tracking-tight text-brand-navy dark:text-foreground">
                  {isLoading ? "…" : pct(data?.return_rollup.ungraded.return_rate ?? null)}
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  return rate · {count(data?.return_rollup.ungraded.fulfilled_sales)} sales
                </p>
              </div>
              <div className="rounded-lg border bg-background p-5">
                <p className="text-sm text-muted-foreground">All tracked sales</p>
                <p className="mt-2 text-3xl font-bold tracking-tight text-brand-navy dark:text-foreground">
                  {isLoading ? "…" : pct(data?.return_rollup.overall.return_rate ?? null)}
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  return rate · {count(data?.return_rollup.overall.fulfilled_sales)} sales
                </p>
              </div>
            </div>
          )}
        </div>
      </section>

      {/* Return rate by grade band */}
      <section className="border-t px-6 py-16">
        <div className="mx-auto max-w-5xl">
          <div className="flex items-center gap-2">
            <BarChart3 className="h-5 w-5 text-brand-navy dark:text-foreground" />
            <h2 className="text-2xl font-bold">Return rate by condition grade</h2>
          </div>
          <p className="mt-3 max-w-3xl text-muted-foreground">
            Return rate by grade band. A band's rate appears once it has enough
            sales behind it to report truthfully; otherwise we show the counts but
            withhold the rate.
          </p>
          {bands.length > 0 ? (
            <div className="mt-8 space-y-3">
              {bands.map((b) => (
                <Bar
                  key={b.key}
                  label={b.label}
                  value={b.return_rate}
                  max={maxReturn}
                  tone="red"
                  display={pct(b.return_rate, 0)}
                />
              ))}
            </div>
          ) : (
            <p className="mt-8 rounded-lg border border-dashed p-6 text-sm text-muted-foreground">
              {isLoading ? "Loading the latest figures…" : PENDING}
            </p>
          )}
        </div>
      </section>

      {/* Resale value by grade band */}
      <section className="border-t bg-card px-6 py-16">
        <div className="mx-auto max-w-5xl">
          <div className="flex items-center gap-2">
            <TrendingUp className="h-5 w-5 text-brand-navy dark:text-foreground" />
            <h2 className="text-2xl font-bold">Resale value by condition grade</h2>
          </div>
          <p className="mt-3 max-w-3xl text-muted-foreground">
            Median sold price per grade band — a direct read on how much condition
            moves what an item fetches.
          </p>
          {valuePremium !== null ? (
            <div className="mt-6 rounded-lg border bg-background p-5">
              <p className="text-sm text-muted-foreground">
                Condition value premium
              </p>
              <p className="mt-2 text-3xl font-bold tracking-tight text-brand-navy dark:text-foreground">
                +{Math.round(valuePremium * 100)}%
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                higher median resale value for items graded {highBand?.label} vs.{" "}
                {lowBand?.label}
                {data?.generated_at
                  ? ` · as of ${new Date(data.generated_at).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" })}`
                  : ""}
              </p>
            </div>
          ) : null}
          {bands.length > 0 ? (
            <div className="mt-8 space-y-3">
              {bands.map((b) => (
                <Bar
                  key={b.key}
                  label={b.label}
                  value={b.median_sale_price}
                  max={maxPrice}
                  display={money(b.median_sale_price)}
                />
              ))}
            </div>
          ) : (
            <p className="mt-8 rounded-lg border border-dashed p-6 text-sm text-muted-foreground">
              {isLoading ? "Loading the latest figures…" : PENDING}
            </p>
          )}
        </div>
      </section>

      {/* Full data table */}
      <section className="border-t px-6 py-16">
        <div className="mx-auto max-w-5xl">
          <h2 className="text-2xl font-bold">The numbers</h2>
          <p className="mt-3 max-w-3xl text-muted-foreground">
            Return rate, sell-through, median time-to-sell, and median resale
            value for each condition-grade band. Every cell is aggregate-only and
            sample-gated.
          </p>
          {bands.length > 0 ? (
            <div className="mt-8 overflow-x-auto rounded-lg border">
              <table className="w-full text-sm">
                <thead className="bg-muted/50">
                  <tr>
                    <th className="px-4 py-3 text-left font-semibold">Grade band</th>
                    <th className="px-4 py-3 text-right font-semibold">Return rate</th>
                    <th className="px-4 py-3 text-right font-semibold">Sell-through</th>
                    <th className="px-4 py-3 text-right font-semibold">Median days to sell</th>
                    <th className="px-4 py-3 text-right font-semibold">Median resale value</th>
                  </tr>
                </thead>
                <tbody>
                  {bands.map((b) => (
                    <tr key={b.key} className="border-t">
                      <td className="px-4 py-3 font-medium">{b.label}</td>
                      <td className="px-4 py-3 text-right">{pct(b.return_rate, 1)}</td>
                      <td className="px-4 py-3 text-right">{pct(b.sell_through, 0)}</td>
                      <td className="px-4 py-3 text-right">{days(b.median_days_to_sell)}</td>
                      <td className="px-4 py-3 text-right">{money(b.median_sale_price)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="mt-8 rounded-lg border border-dashed p-6 text-sm text-muted-foreground">
              {isLoading
                ? "Loading the latest figures…"
                : "The table appears once enough sales and listings are recorded to report a meaningful number."}
            </p>
          )}
          {data ? (
            <p className="mt-4 text-xs text-muted-foreground">
              Sample: {count(data.sample.fulfilled_sales)} fulfilled sales ·{" "}
              {count(data.sample.listed_items)} listings ·{" "}
              {count(data.sample.priced_sales)} priced sales.
            </p>
          ) : null}
        </div>
      </section>

      {/* Methodology */}
      <section className="border-t bg-card px-6 py-16">
        <div className="mx-auto max-w-3xl">
          <div className="flex items-center gap-2">
            <RefreshCw className="h-5 w-5 text-brand-navy dark:text-foreground" />
            <h2 className="text-2xl font-bold">Methodology</h2>
          </div>
          <ul className="mt-6 space-y-4 text-sm text-muted-foreground">
            <li>
              <strong className="text-foreground">Source.</strong> Platform-wide
              reseller sales and listings, aggregated server-side. No per-seller
              or per-item data leaves the aggregation — only counts and rates.
            </li>
            <li>
              <strong className="text-foreground">Grade bands.</strong> Items are
              bucketed by their GradeThread condition grade: 8.5–10.0, 6.5–8.0,
              6.0 or lower, and ungraded — the same bands the seller dashboard
              uses.
            </li>
            <li>
              <strong className="text-foreground">Return rate</strong> = refunded
              fulfilled sales ÷ fulfilled sales (a fulfilled sale is one that
              shipped; a return is a fully-refunded order).{" "}
              <strong className="text-foreground">Sell-through</strong> = sold
              listings ÷ listed items.{" "}
              <strong className="text-foreground">Resale value</strong> = the
              median sold price in the band.
            </li>
            <li>
              <strong className="text-foreground">Sample gating.</strong> A band's
              rate is published only once it clears a minimum sample size, so a
              thinly-sampled band never prints a misleading number. Where the bar
              isn't met, the page says “{PENDING}”.
            </li>
            <li>
              <strong className="text-foreground">Refresh.</strong> The figures
              are recomputed continuously as new sales and listings are recorded
              (cached up to 15 minutes). This page states the exact coverage
              window and sample size for the data shown.
            </li>
          </ul>
        </div>
      </section>

      {/* Query this as data — the Condition Index price-guide API (US-1285) */}
      <section className="border-t bg-card px-6 py-16">
        <div className="mx-auto max-w-3xl">
          <div className="flex items-center gap-2">
            <Database className="h-5 w-5 text-brand-navy dark:text-foreground" />
            <h2 className="text-2xl font-bold">Query this as data</h2>
          </div>
          <p className="mt-3 text-muted-foreground">
            These aggregates are also a queryable product. The{" "}
            <strong className="text-foreground">Resale Condition Index price guide</strong>{" "}
            API maps a grade band, category, and brand to a resale value range and
            sell-through — the same data, addressable per item. It's scoped behind
            an API key and rate-limited like the rest of our API, with a free
            sandbox so you can build against deterministic sample data first. Every
            response is aggregate-only and sample-gated: items and bands without
            enough data are not returned rather than guessed.
          </p>
          <div className="mt-5 overflow-x-auto rounded-lg border">
            <table className="w-full text-left text-sm">
              <thead className="bg-muted/50">
                <tr>
                  <th className="px-4 py-2 font-medium">Method</th>
                  <th className="px-4 py-2 font-medium">Path</th>
                  <th className="px-4 py-2 font-medium">Returns</th>
                </tr>
              </thead>
              <tbody>
                <tr className="border-t">
                  <td className="px-4 py-2 font-mono text-xs">GET</td>
                  <td className="px-4 py-2 font-mono text-xs">/api/v1/price-guide</td>
                  <td className="px-4 py-2 text-xs">Published items (the catalog).</td>
                </tr>
                <tr className="border-t">
                  <td className="px-4 py-2 font-mono text-xs">GET</td>
                  <td className="px-4 py-2 font-mono text-xs">/api/v1/price-guide/:slug</td>
                  <td className="px-4 py-2 text-xs">Value range + sell-through by grade band.</td>
                </tr>
                <tr className="border-t">
                  <td className="px-4 py-2 font-mono text-xs">GET</td>
                  <td className="px-4 py-2 font-mono text-xs">/api/v1/sandbox/price-guide/:slug</td>
                  <td className="px-4 py-2 text-xs">Free deterministic sample.</td>
                </tr>
              </tbody>
            </table>
          </div>
          <p className="mt-4 text-sm">
            <Link
              to="/developers"
              className="font-medium text-brand-navy hover:underline dark:text-foreground"
            >
              Read the developer docs →
            </Link>
          </p>
        </div>
      </section>

      {/* Cite this */}
      <section className="border-t px-6 py-16">
        <div className="mx-auto max-w-3xl">
          <div className="flex items-center gap-2">
            <Quote className="h-5 w-5 text-brand-navy dark:text-foreground" />
            <h2 className="text-2xl font-bold">Cite this report</h2>
          </div>
          <p className="mt-3 text-muted-foreground">
            Free to share and adapt with attribution under a{" "}
            <a
              href="https://creativecommons.org/licenses/by/4.0/"
              className="font-medium text-brand-navy hover:underline dark:text-foreground"
              rel="noopener noreferrer"
              target="_blank"
            >
              CC BY 4.0
            </a>{" "}
            license. Suggested citation:
          </p>
          <blockquote className="mt-4 rounded-lg border bg-muted/40 p-5 text-sm">
            GradeThread. “The State of Resale Condition: Return Rate, Sell-Through
            &amp; Value by Grade.” Pearson Media LLC, {new Date(
              RESALE_REPORT_PUBLISHED,
            ).getFullYear()}.{" "}
            <a href={CANONICAL} className="break-all font-medium text-brand-navy hover:underline dark:text-foreground">
              {CANONICAL}
            </a>
          </blockquote>
          <p className="mt-3 text-xs text-muted-foreground">
            Permalink: <span className="break-all">{CANONICAL}</span>
          </p>
        </div>
      </section>

      {/* FAQ */}
      <section className="border-t bg-card px-6 py-16">
        <div className="mx-auto max-w-2xl">
          <h2 className="text-center text-3xl font-bold">Resale condition FAQ</h2>
          <dl className="mt-10 space-y-6">
            {RESALE_REPORT_FAQS.map((faq) => (
              <div key={faq.q} className="border-b pb-6 last:border-b-0">
                <dt className="font-medium">{faq.q}</dt>
                <dd className="mt-2 text-sm text-muted-foreground">{faq.a}</dd>
              </div>
            ))}
          </dl>
          <div className="mt-10 text-center">
            <Link to="/transparency">
              <Button variant="outline" size="lg">
                See our grading accuracy report
              </Button>
            </Link>
          </div>
        </div>
      </section>

      <MarketingCTA />
    </MarketingLayout>
  );
}
