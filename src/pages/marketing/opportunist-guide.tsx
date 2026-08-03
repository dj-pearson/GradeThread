import { Link } from "react-router-dom";
import { ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  MarketingLayout,
  MarketingCTA,
} from "@/components/marketing/marketing-layout";
import { NotFoundPage } from "@/pages/not-found";
import {
  getOpportunistGuideByPath,
  type OpportunistGuide,
} from "@/lib/seo/opportunist-guides";
import { RESELLING_PILLAR_PATH } from "@/lib/seo/reselling-guides";
import {
  opportunistGuideJsonLd,
  opportunistGuideBreadcrumbItems,
} from "@/pages/marketing/marketing-jsonld";

// US-1668: opportunist mid-tail eBay how-to pages. A single component keyed by
// the guide's explicit path (paths vary in depth, so the routes are registered
// directly rather than via one dynamic slug route).

export function OpportunistGuidePage({ path }: { path: string }) {
  const guide = getOpportunistGuideByPath(path);
  if (!guide) return <NotFoundPage />;
  return <OpportunistGuideView guide={guide} />;
}

function OpportunistGuideView({ guide }: { guide: OpportunistGuide }) {
  return (
    <MarketingLayout
      title={guide.title}
      description={guide.description}
      canonicalPath={guide.path}
      breadcrumbs={opportunistGuideBreadcrumbItems(guide)}
      jsonLd={opportunistGuideJsonLd(guide)}
    >
      <section className="px-6 py-16 lg:py-20">
        <div className="mx-auto max-w-3xl">
          <p className="text-sm font-medium text-muted-foreground">
            <Link to={RESELLING_PILLAR_PATH} className="hover:underline">
              Reselling
            </Link>
          </p>
          <h1 className="mt-2 text-4xl font-bold tracking-tight sm:text-5xl">
            {guide.h1}
          </h1>
          {/* Quotable definition block (AI-citable answer). */}
          <p className="mt-6 rounded-xl bg-muted/40 p-5 text-lg font-medium text-foreground">
            {guide.definition}
          </p>
          <p className="mt-6 text-muted-foreground">{guide.intro}</p>
        </div>
      </section>

      {/* HowTo steps */}
      <section className="border-t bg-card px-6 py-16">
        <div className="mx-auto max-w-3xl">
          <h2 className="text-3xl font-bold">Step by step</h2>
          <ol className="mt-8 space-y-6">
            {guide.steps.map((s, i) => (
              <li key={s.name} className="flex gap-4">
                <span className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-brand-navy text-sm font-bold text-white">
                  {i + 1}
                </span>
                <div>
                  <p className="font-medium text-foreground">{s.name}</p>
                  <p className="mt-1 text-muted-foreground">{s.text}</p>
                </div>
              </li>
            ))}
          </ol>
        </div>
      </section>

      {guide.sections.map((s, i) => (
        <section
          key={s.heading}
          className={
            i % 2 === 0 ? "border-t px-6 py-16" : "border-t bg-card px-6 py-16"
          }
        >
          <div className="mx-auto max-w-3xl">
            <h2 className="text-2xl font-bold sm:text-3xl">{s.heading}</h2>
            <p className="mt-4 text-muted-foreground">{s.body}</p>
          </div>
        </section>
      ))}

      {/* FlipDesk feature CTA */}
      <section className="border-t px-6 py-16">
        <div className="mx-auto max-w-3xl rounded-xl border bg-muted/30 p-6">
          <h2 className="text-2xl font-bold">Do this automatically</h2>
          <p className="mt-3 text-muted-foreground">{guide.flipdeskCta.blurb}</p>
          <div className="mt-5">
            <Link to={guide.flipdeskCta.href}>
              <Button variant="outline" size="sm">
                {guide.flipdeskCta.label}
                <ArrowRight className="ml-1 h-4 w-4" />
              </Button>
            </Link>
          </div>
        </div>
      </section>

      {guide.faqs.length > 0 && (
        <section className="border-t bg-card px-6 py-16">
          <div className="mx-auto max-w-2xl">
            <h2 className="text-center text-3xl font-bold">Frequently asked</h2>
            <dl className="mt-10 space-y-6">
              {guide.faqs.map((faq) => (
                <div key={faq.q} className="border-b pb-6 last:border-b-0">
                  <dt className="font-medium">{faq.q}</dt>
                  <dd className="mt-2 text-sm text-muted-foreground">{faq.a}</dd>
                </div>
              ))}
            </dl>
          </div>
        </section>
      )}

      <MarketingCTA />
    </MarketingLayout>
  );
}
