import { Link } from "react-router";
import { MarketingLayout, MarketingCTA } from "@/components/marketing/marketing-layout";
import {
  CALCULATOR_HUB_META,
  CALCULATOR_HUB_PATH,
  calculatorPath,
  liveCalculators,
} from "@/lib/seo/calculators";
import {
  calculatorHubJsonLd,
  calculatorHubBreadcrumbLdItems,
} from "@/pages/marketing/marketing-jsonld";

// US-9002: the calculator hub. Lists only what is live — the registry filters
// planned entries out, so this page can never advertise a tool that does not
// exist yet.

export function CalculatorHubPage() {
  const live = liveCalculators();
  return (
    <MarketingLayout
      title={CALCULATOR_HUB_META.title}
      description={CALCULATOR_HUB_META.description}
      canonicalPath={CALCULATOR_HUB_PATH}
      breadcrumbs={calculatorHubBreadcrumbLdItems()}
      jsonLd={calculatorHubJsonLd()}
    >
      <section className="px-6 py-16 lg:py-20">
        <div className="mx-auto max-w-3xl">
          <h1 className="text-4xl font-bold tracking-tight sm:text-5xl">
            {CALCULATOR_HUB_META.h1}
          </h1>
          <p className="mt-6 text-lg text-foreground">{CALCULATOR_HUB_META.intro}</p>
        </div>
      </section>

      <section className="border-t bg-card px-6 py-16">
        <div className="mx-auto max-w-3xl">
          <h2 className="text-3xl font-bold">The tools</h2>
          <ul className="mt-6 space-y-4">
            {live.map((c) => (
              <li key={c.slug} className="border-b pb-4 last:border-b-0">
                <Link
                  to={calculatorPath(c.slug)}
                  className="text-lg font-medium text-brand-navy hover:underline dark:text-foreground"
                >
                  {c.h1}
                </Link>
                <p className="mt-1 text-sm text-muted-foreground">{c.cardBlurb}</p>
              </li>
            ))}
          </ul>
        </div>
      </section>

      <section className="px-6 py-16">
        <div className="mx-auto max-w-3xl">
          <h2 className="text-3xl font-bold">Common questions</h2>
          <dl className="mt-6 space-y-6">
            {CALCULATOR_HUB_META.faqs.map((f) => (
              <div key={f.q}>
                <dt className="font-medium">{f.q}</dt>
                <dd className="mt-1 text-muted-foreground">{f.a}</dd>
              </div>
            ))}
          </dl>
        </div>
      </section>

      <MarketingCTA />
    </MarketingLayout>
  );
}
