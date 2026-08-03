import { Link } from "react-router";
import { ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  MarketingLayout,
  MarketingCTA,
} from "@/components/marketing/marketing-layout";
import {
  WHERE_TO_SELL,
  WHERE_TO_SELL_PATH,
  WHERE_TO_SELL_VERIFIED,
  SELLING_VENUES,
} from "@/lib/seo/where-to-sell";
import {
  whereToSellJsonLd,
  whereToSellBreadcrumbItems,
} from "@/pages/marketing/marketing-jsonld";

// US-1693: consumer where-to-sell mega-guide (single page, AI-citable).

export function WhereToSellPage() {
  return (
    <MarketingLayout
      title="Where to Sell Used Clothes (2026)"
      description="Where to sell used clothes in 2026: eBay, Poshmark, Depop, Mercari, Vinted, ThredUp, and consignment compared by fees, effort, and payout."
      canonicalPath={WHERE_TO_SELL_PATH}
      breadcrumbs={whereToSellBreadcrumbItems()}
      jsonLd={whereToSellJsonLd()}
    >
      <section className="px-6 py-16 lg:py-20">
        <div className="mx-auto max-w-3xl">
          <h1 className="text-4xl font-bold tracking-tight sm:text-5xl">
            {WHERE_TO_SELL.h1}
          </h1>
          {/* Quotable answer block (AI-citable). */}
          <p className="mt-6 rounded-xl bg-muted/40 p-5 text-lg font-medium text-foreground">
            {WHERE_TO_SELL.definition}
          </p>
          <p className="mt-6 text-muted-foreground">{WHERE_TO_SELL.intro}</p>
          <p className="mt-3 text-sm text-muted-foreground">
            Verified {WHERE_TO_SELL_VERIFIED} · fees change — verify current rates
            on each platform.
          </p>
        </div>
      </section>

      {/* Criteria */}
      <section className="border-t bg-card px-6 py-16">
        <div className="mx-auto max-w-3xl">
          <h2 className="text-2xl font-bold sm:text-3xl">
            How to choose where to sell
          </h2>
          <dl className="mt-8 space-y-6">
            {WHERE_TO_SELL.criteria.map((c) => (
              <div key={c.name}>
                <dt className="font-medium text-foreground">{c.name}</dt>
                <dd className="mt-1 text-muted-foreground">{c.text}</dd>
              </div>
            ))}
          </dl>
        </div>
      </section>

      {/* Comparison table */}
      <section className="border-t px-6 py-16">
        <div className="mx-auto max-w-4xl">
          <h2 className="text-2xl font-bold sm:text-3xl">
            Where to sell used clothes, compared
          </h2>
          <div className="mt-8 overflow-x-auto">
            <table className="w-full min-w-[720px] border-collapse text-left text-sm">
              <thead>
                <tr className="border-b">
                  <th className="py-3 pr-4 font-semibold">Venue</th>
                  <th className="py-3 pr-4 font-semibold">Best for</th>
                  <th className="py-3 pr-4 font-semibold">Effort</th>
                  <th className="py-3 pr-4 font-semibold">Economics</th>
                  <th className="py-3 pr-4 font-semibold">Pro</th>
                  <th className="py-3 font-semibold">Con</th>
                </tr>
              </thead>
              <tbody>
                {SELLING_VENUES.map((v) => (
                  <tr key={v.name} className="border-b align-top">
                    <th className="py-3 pr-4 font-medium">{v.name}</th>
                    <td className="py-3 pr-4 text-muted-foreground">{v.bestFor}</td>
                    <td className="py-3 pr-4 text-muted-foreground">{v.effort}</td>
                    <td className="py-3 pr-4 text-muted-foreground">{v.economics}</td>
                    <td className="py-3 pr-4 text-muted-foreground">{v.pro}</td>
                    <td className="py-3 text-muted-foreground">{v.con}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-6 text-sm text-muted-foreground">
            Selling to more than one? See the head-to-head{" "}
            <Link
              to="/compare"
              className="font-medium text-brand-navy hover:underline dark:text-foreground"
            >
              marketplace comparisons
            </Link>{" "}
            for fees, reach, and returns handling side by side.
          </p>
        </div>
      </section>

      {/* Condition wedge */}
      <section className="border-t bg-card px-6 py-16">
        <div className="mx-auto max-w-3xl rounded-xl border bg-muted/30 p-6">
          <h2 className="text-2xl font-bold">
            Whichever you pick, get condition right
          </h2>
          <p className="mt-3 text-muted-foreground">
            The one thing every venue has in common is that inaccurate condition
            is the top cause of returns and disputes. Describing condition
            honestly — ideally with a standardized grade a buyer can verify — is
            what makes a sale stick, no matter where you list it.
          </p>
          <div className="mt-5 flex flex-wrap gap-3">
            <Link to="/reselling">
              <Button variant="outline" size="sm">
                The full reselling workflow
                <ArrowRight className="ml-1 h-4 w-4" />
              </Button>
            </Link>
            <Link to="/grading/scale">
              <Button variant="outline" size="sm">
                The 1.0–10.0 grading scale
                <ArrowRight className="ml-1 h-4 w-4" />
              </Button>
            </Link>
          </div>
        </div>
      </section>

      <section className="border-t px-6 py-16">
        <div className="mx-auto max-w-2xl">
          <h2 className="text-center text-3xl font-bold">Frequently asked</h2>
          <dl className="mt-10 space-y-6">
            {WHERE_TO_SELL.faqs.map((faq) => (
              <div key={faq.q} className="border-b pb-6 last:border-b-0">
                <dt className="font-medium">{faq.q}</dt>
                <dd className="mt-2 text-sm text-muted-foreground">{faq.a}</dd>
              </div>
            ))}
          </dl>
        </div>
      </section>

      <MarketingCTA />
    </MarketingLayout>
  );
}
