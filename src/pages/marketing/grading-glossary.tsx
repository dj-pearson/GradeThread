import { Link, useParams } from "react-router";
import { Button } from "@/components/ui/button";
import {
  MarketingLayout,
  MarketingCTA,
} from "@/components/marketing/marketing-layout";
import { NotFoundPage } from "@/pages/not-found";
import { getGlossaryEntryBySlug } from "@/lib/seo/glossary";
import {
  glossaryJsonLd,
  glossaryBreadcrumbItems,
} from "@/pages/marketing/marketing-jsonld";

// A single glossary / knowledge-hub page (US-303): one per grade tier + grading
// factor, generated from src/lib/constants.ts. Spokes off the /condition-grading
// pillar with hub-and-spoke internal linking + FAQPage/BreadcrumbList JSON-LD.
//
// `slug` is passed explicitly by the build-time prerender (entry-server renders
// each path directly, with no router param match); the live SPA reads it from
// useParams via the /grading/:slug route.
export function GradingGlossaryPage({ slug: slugProp }: { slug?: string }) {
  const params = useParams<{ slug: string }>();
  const slug = slugProp ?? params.slug ?? "";
  const entry = getGlossaryEntryBySlug(slug);

  if (!entry) return <NotFoundPage />;

  return (
    <MarketingLayout
      title={entry.title}
      description={entry.description}
      canonicalPath={entry.path}
      breadcrumbs={glossaryBreadcrumbItems(entry)}
      jsonLd={glossaryJsonLd(entry)}
    >
      {/* Answer-first lead */}
      <section className="px-6 py-16 lg:py-20">
        <div className="mx-auto max-w-3xl">
          {/* US-433: the 3-level breadcrumb (GradeThread → Condition grading →
              term) now renders once in MarketingLayout, matching the JSON-LD. */}
          <h1 className="text-4xl font-bold tracking-tight sm:text-5xl">
            {entry.h1}
          </h1>
          <p className="mt-3 inline-block rounded-full bg-brand-navy px-3 py-1 text-sm font-medium text-white">
            {entry.rangeLabel}
          </p>
          <p className="mt-6 text-lg text-muted-foreground">{entry.definition}</p>
        </div>
      </section>

      {/* What graders look for */}
      <section className="border-t bg-card px-6 py-16">
        <div className="mx-auto max-w-3xl">
          <h2 className="text-3xl font-bold">What graders look for</h2>
          <ul className="mt-6 space-y-3">
            {entry.lookFor.map((item) => (
              <li
                key={item}
                className="flex gap-3 rounded-lg border bg-background p-4 text-sm"
              >
                <span
                  aria-hidden
                  className="mt-1.5 h-2 w-2 flex-shrink-0 rounded-full bg-brand-red"
                />
                <span>{item}</span>
              </li>
            ))}
          </ul>
        </div>
      </section>

      {/* Examples */}
      <section className="px-6 py-16">
        <div className="mx-auto max-w-3xl">
          <h2 className="text-3xl font-bold">Examples</h2>
          <ul className="mt-6 space-y-3 text-muted-foreground">
            {entry.examples.map((ex) => (
              <li key={ex} className="border-l-2 border-brand-navy/30 pl-4">
                {ex}
              </li>
            ))}
          </ul>
          <p className="mt-8 text-sm text-muted-foreground">
            See the full picture in{" "}
            <Link
              to="/condition-grading"
              className="font-medium text-brand-navy hover:underline dark:text-foreground"
            >
              the condition grading guide
            </Link>
            , or how the score is produced in{" "}
            <Link
              to="/how-it-works"
              className="font-medium text-brand-navy hover:underline dark:text-foreground"
            >
              how it works
            </Link>
            .
          </p>
        </div>
      </section>

      {/* FAQ */}
      <section className="border-t bg-card px-6 py-16">
        <div className="mx-auto max-w-2xl">
          <h2 className="text-center text-3xl font-bold">
            {entry.term} — frequently asked
          </h2>
          <dl className="mt-10 space-y-6">
            {entry.faqs.map((faq) => (
              <div key={faq.q} className="border-b pb-6 last:border-b-0">
                <dt className="font-medium">{faq.q}</dt>
                <dd className="mt-2 text-sm text-muted-foreground">{faq.a}</dd>
              </div>
            ))}
          </dl>
        </div>
      </section>

      {/* Related terms (internal-link block) */}
      <section className="px-6 py-16">
        <div className="mx-auto max-w-3xl">
          <h2 className="text-3xl font-bold">Related terms</h2>
          <div className="mt-6 flex flex-wrap gap-3">
            {entry.relatedSlugs.map((rel) => {
              const target = getGlossaryEntryBySlug(rel);
              if (!target) return null;
              return (
                <Link
                  key={rel}
                  to={target.path}
                  className="rounded-full border px-4 py-2 text-sm font-medium text-brand-navy transition-colors hover:bg-brand-navy hover:text-white dark:text-foreground"
                >
                  {target.term}
                </Link>
              );
            })}
            <Link
              to="/condition-grading"
              className="rounded-full border px-4 py-2 text-sm font-medium text-brand-navy transition-colors hover:bg-brand-navy hover:text-white dark:text-foreground"
            >
              All condition grades
            </Link>
          </div>
          <div className="mt-10">
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
  );
}
