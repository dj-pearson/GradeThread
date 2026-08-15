import { Link, useLocation } from "react-router";
import { ArrowRight, Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  MarketingLayout,
  MarketingCTA,
} from "@/components/marketing/marketing-layout";
import { HelpCategoryLink } from "@/components/marketing/help-category-link";
import { NotFoundPage } from "@/pages/not-found";
import { getFlipdeskLandingByPath } from "@/lib/seo/flipdesk-landing";
import {
  flipdeskLandingJsonLd,
  flipdeskLandingBreadcrumbItems,
} from "@/pages/marketing/marketing-jsonld";

// US-1675 / US-1676: the five FlipDesk conversion landing pages under /flipdesk/*.
// One data-driven component; the specific page is resolved from the pathname
// (prerender renders each path directly, so we key off the location, not a param).
export function FlipdeskLandingPage({ slug: slugProp }: { slug?: string }) {
  const { pathname } = useLocation();
  const path = slugProp ? `/flipdesk/${slugProp}` : pathname;
  const landing = getFlipdeskLandingByPath(path);

  if (!landing) return <NotFoundPage />;

  return (
    <MarketingLayout
      title={landing.title}
      description={landing.description}
      canonicalPath={landing.path}
      breadcrumbs={flipdeskLandingBreadcrumbItems(landing)}
      jsonLd={flipdeskLandingJsonLd(landing)}
    >
      {/* Hero — H1 + job-to-be-done intro */}
      <section className="px-6 py-16 lg:py-20">
        <div className="mx-auto max-w-3xl">
          <p className="text-sm font-semibold uppercase tracking-wide text-brand-red-text">
            FlipDesk
          </p>
          <h1 className="mt-3 text-4xl font-bold tracking-tight sm:text-5xl">
            {landing.h1}
          </h1>
          <p className="mt-6 text-lg text-foreground">{landing.intro}</p>
          <div className="mt-8 flex flex-wrap gap-3">
            <Link to="/signup">
              <Button
                size="lg"
                className="bg-brand-red text-white hover:bg-brand-red/90"
              >
                Start free
                <ArrowRight className="ml-2 h-4 w-4" />
              </Button>
            </Link>
            <Link to="/flipdesk">
              <Button size="lg" variant="outline">
                Explore FlipDesk
              </Button>
            </Link>
          </div>
        </div>
      </section>

      {/* Feature sections */}
      {landing.sections.map((s, i) => (
        <section
          key={s.heading}
          className={i % 2 === 0 ? "border-t bg-card px-6 py-16" : "border-t px-6 py-16"}
        >
          <div className="mx-auto max-w-3xl">
            <h2 className="text-2xl font-bold sm:text-3xl">{s.heading}</h2>
            <p className="mt-4 text-muted-foreground">{s.body}</p>
          </div>
        </section>
      ))}

      {/* What's included (from the schema featureList) */}
      <section className="border-t px-6 py-16">
        <div className="mx-auto max-w-3xl">
          <h2 className="text-2xl font-bold sm:text-3xl">What's included</h2>
          <ul className="mt-6 space-y-3">
            {landing.featureList.map((f) => (
              <li key={f} className="flex gap-3 text-sm">
                <Check className="mt-0.5 h-5 w-5 flex-shrink-0 text-brand-red-text" />
                <span>{f}</span>
              </li>
            ))}
          </ul>
          <p className="mt-8 text-sm text-muted-foreground">
            See how it fits your volume on the{" "}
            <Link
              to="/pricing"
              className="font-medium text-brand-navy hover:underline dark:text-foreground"
            >
              pricing page
            </Link>
            .
          </p>
        </div>
      </section>

      {/* FAQ */}
      <section className="border-t bg-card px-6 py-16">
        <div className="mx-auto max-w-2xl">
          <h2 className="text-center text-3xl font-bold">Frequently asked</h2>
          <dl className="mt-10 space-y-6">
            {landing.faqs.map((faq) => (
              <div key={faq.q} className="border-b pb-6 last:border-b-0">
                <dt className="font-medium">{faq.q}</dt>
                <dd className="mt-2 text-sm text-muted-foreground">{faq.a}</dd>
              </div>
            ))}
          </dl>
        </div>
      </section>

      <MarketingCTA />
      <div className="px-6 pb-12 lg:px-12">
        <div className="mx-auto max-w-5xl">
          <HelpCategoryLink category="flipdesk" label="Every pipeline stage, one guide each:" />
        </div>
      </div>

    </MarketingLayout>
  );
}
