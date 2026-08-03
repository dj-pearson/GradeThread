import { Link } from "react-router";
import { ArrowRight, Printer } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  MarketingLayout,
  MarketingCTA,
} from "@/components/marketing/marketing-layout";
import { CONDITION_CHART_META, CONDITION_CHART_PATH } from "@/lib/seo/condition-chart";
import { scaleBands } from "@/lib/seo/grading-scale";
import { GRADE_FACTORS } from "@/lib/constants";
import {
  conditionChartJsonLd,
  conditionChartBreadcrumbItems,
} from "@/pages/marketing/marketing-jsonld";

// US-1678: free printable condition chart. Renders from scaleBands() +
// GRADE_FACTORS (single source of truth). window.print() only runs client-side.

export function ConditionChartPage() {
  const bands = scaleBands();
  const factors = Object.values(GRADE_FACTORS);
  return (
    <MarketingLayout
      title={CONDITION_CHART_META.title}
      description={CONDITION_CHART_META.description}
      canonicalPath={CONDITION_CHART_PATH}
      breadcrumbs={conditionChartBreadcrumbItems()}
      jsonLd={conditionChartJsonLd()}
    >
      <section className="px-6 py-16 lg:py-20">
        <div className="mx-auto max-w-3xl">
          <p className="text-sm font-medium text-muted-foreground">
            <Link to="/grading/scale" className="hover:underline">
              Grading scale
            </Link>
          </p>
          <h1 className="mt-2 text-4xl font-bold tracking-tight sm:text-5xl">
            {CONDITION_CHART_META.h1}
          </h1>
          <p className="mt-6 text-lg text-foreground">
            A free, no-signup reference for grading pre-owned clothing condition
            on the GradeThread 1.0–10.0 scale. Print it, screenshot it, or share
            it — it's yours to use.
          </p>
          <div className="mt-6 print:hidden">
            <Button onClick={() => window.print()} variant="outline" size="sm">
              <Printer className="mr-1 h-4 w-4" />
              Print this chart
            </Button>
          </div>
        </div>
      </section>

      {/* The chart */}
      <section className="border-t bg-card px-6 py-12 print:bg-white print:py-4">
        <div className="mx-auto max-w-5xl">
          <h2 className="text-2xl font-bold">
            The GradeThread condition scale
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            gradethread.com · the 1.0–10.0 clothing condition standard
          </p>
          <div className="mt-6 overflow-x-auto">
            <table className="w-full min-w-[720px] border-collapse text-left text-sm">
              <thead>
                <tr className="border-b">
                  <th className="py-3 pr-4 font-semibold">Grade</th>
                  <th className="py-3 pr-4 font-semibold">Tier</th>
                  <th className="py-3 pr-4 font-semibold">What earns it</th>
                  <th className="py-3 pr-4 font-semibold">Typical flaws</th>
                  <th className="py-3 font-semibold">Marketplace equivalent</th>
                </tr>
              </thead>
              <tbody>
                {bands.map((b) => (
                  <tr key={b.term} className="border-b align-top">
                    <td className="py-3 pr-4 font-medium">{b.score}</td>
                    <td className="py-3 pr-4 text-muted-foreground">{b.label}</td>
                    <td className="py-3 pr-4 text-muted-foreground">{b.criteria}</td>
                    <td className="py-3 pr-4 text-muted-foreground">{b.typicalFlaws}</td>
                    <td className="py-3 text-muted-foreground">{b.marketplaceEquivalent}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </section>

      {/* Factor weights */}
      <section className="border-t px-6 py-12 print:py-4">
        <div className="mx-auto max-w-5xl">
          <h2 className="text-2xl font-bold">The five weighted factors</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Every grade is a weighted blend of these five factors.
          </p>
          <div className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
            {factors.map((f) => (
              <div key={f.label} className="rounded-lg border p-4 text-center">
                <p className="text-2xl font-bold text-brand-navy dark:text-foreground">
                  {Math.round(f.weight * 100)}%
                </p>
                <p className="mt-1 text-sm text-muted-foreground">{f.label}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="border-t bg-card px-6 py-16 print:hidden">
        <div className="mx-auto max-w-3xl rounded-xl border bg-muted/30 p-6">
          <h2 className="text-2xl font-bold">Want a verifiable grade?</h2>
          <p className="mt-3 text-muted-foreground">
            This chart shows the standard. A GradeThread grade applies it
            objectively to your item and gives you a certificate buyers can
            verify — the difference between saying "good condition" and proving
            it.
          </p>
          <div className="mt-5">
            <Link to="/grading/scale">
              <Button variant="outline" size="sm">
                How the scale works
                <ArrowRight className="ml-1 h-4 w-4" />
              </Button>
            </Link>
          </div>
        </div>
      </section>

      <div className="print:hidden">
        <MarketingCTA />
      </div>
    </MarketingLayout>
  );
}
