import { Link, useParams } from "react-router";
import { Button } from "@/components/ui/button";
import {
  MarketingLayout,
  MarketingCTA,
} from "@/components/marketing/marketing-layout";
import { NotFoundPage } from "@/pages/not-found";
import {
  RESELLER_GLOSSARY_HUB_PATH,
  getResellerTermBySlug,
  resellerTermPath,
  resellerTermsByGroup,
} from "@/lib/seo/reseller-glossary";
import {
  resellerTermJsonLd,
  resellerTermBreadcrumbItems,
  resellerGlossaryHubJsonLd,
  resellerGlossaryHubBreadcrumbItems,
  RESELLER_GLOSSARY_HUB_FAQS,
} from "@/pages/marketing/marketing-jsonld";

// US-1671: the reseller condition-vocabulary glossary hub (/grading/glossary) +
// one DefinedTerm page per term (/grading/glossary/:term). The term `slug` is
// passed explicitly by the prerender (entry-server renders each path with no
// router match); the live SPA reads it from useParams.

const GROUPED = resellerTermsByGroup();

export function ResellerGlossaryHubPage() {
  return (
    <MarketingLayout
      title="Reseller Condition Glossary"
      description="The reseller's glossary of clothing condition vocabulary — EUC, VGUC, NWT vs NWOT, death pile, comps, SNAD and more, each mapped to a 1–10 grade."
      canonicalPath={RESELLER_GLOSSARY_HUB_PATH}
      breadcrumbs={resellerGlossaryHubBreadcrumbItems()}
      jsonLd={resellerGlossaryHubJsonLd()}
    >
      <section className="px-6 py-16 lg:py-20">
        <div className="mx-auto max-w-3xl">
          <h1 className="text-4xl font-bold tracking-tight sm:text-5xl">
            The reseller condition glossary
          </h1>
          <p className="mt-6 text-lg text-foreground">
            The vocabulary resellers use to describe pre-owned clothing condition
            — the abbreviations (EUC, VGUC, NWT), the workflow slang (death pile,
            comps), and the marketplace terms (SNAD, HTF) — each defined plainly
            and mapped to the standardized{" "}
            <Link
              to="/grading/scale"
              className="font-medium text-brand-navy hover:underline dark:text-foreground"
            >
              1.0–10.0 grading scale
            </Link>
            . A shared vocabulary is how buyers learn to trust a listing.
          </p>
        </div>
      </section>

      {GROUPED.map((g) => (
        <section key={g.group} className="border-t px-6 py-12">
          <div className="mx-auto max-w-3xl">
            <h2 className="text-2xl font-bold">{g.label}</h2>
            <dl className="mt-6 space-y-4">
              {g.terms.map((t) => (
                <div key={t.slug} className="border-b pb-4 last:border-b-0">
                  <dt>
                    <Link
                      to={resellerTermPath(t.slug)}
                      className="text-lg font-medium text-brand-navy hover:underline dark:text-foreground"
                    >
                      {t.term}
                    </Link>
                    {t.alternateNames?.length ? (
                      <span className="ml-2 text-sm text-muted-foreground">
                        {t.alternateNames.join(" · ")}
                      </span>
                    ) : null}
                  </dt>
                  <dd className="mt-1 text-sm text-muted-foreground">
                    {t.definition}
                  </dd>
                </div>
              ))}
            </dl>
          </div>
        </section>
      ))}

      {/* Hub FAQ */}
      <section className="border-t bg-card px-6 py-16">
        <div className="mx-auto max-w-2xl">
          <h2 className="text-center text-3xl font-bold">
            Condition vocabulary FAQ
          </h2>
          <dl className="mt-10 space-y-6">
            {RESELLER_GLOSSARY_HUB_FAQS.map((faq) => (
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

export function ResellerGlossaryTermPage({ slug: slugProp }: { slug?: string }) {
  const params = useParams<{ term: string }>();
  const slug = slugProp ?? params.term ?? "";
  const term = getResellerTermBySlug(slug);

  if (!term) return <NotFoundPage />;

  return (
    <MarketingLayout
      title={term.title}
      description={term.description}
      canonicalPath={resellerTermPath(term.slug)}
      breadcrumbs={resellerTermBreadcrumbItems(term)}
      jsonLd={resellerTermJsonLd(term)}
    >
      {/* Answer-first definition */}
      <section className="px-6 py-16 lg:py-20">
        <div className="mx-auto max-w-3xl">
          <h1 className="text-4xl font-bold tracking-tight sm:text-5xl">
            {term.h1}
          </h1>
          {term.alternateNames?.length ? (
            <p className="mt-3 text-sm font-medium text-muted-foreground">
              Also: {term.alternateNames.join(" · ")}
            </p>
          ) : null}
          <p className="mt-6 text-lg text-foreground">{term.definition}</p>
        </div>
      </section>

      {/* Usage in a real listing */}
      <section className="border-t bg-card px-6 py-16">
        <div className="mx-auto max-w-3xl">
          <h2 className="text-3xl font-bold">How it's used in a listing</h2>
          <p className="mt-6 border-l-2 border-brand-navy/30 pl-4 text-muted-foreground">
            {term.usageExample}
          </p>
        </div>
      </section>

      {/* Maps to the grade scale */}
      <section className="px-6 py-16">
        <div className="mx-auto max-w-3xl">
          <h2 className="text-3xl font-bold">How it maps to the grade scale</h2>
          <p className="mt-6 text-muted-foreground">{term.scaleMapping}</p>
          <p className="mt-6 text-sm text-muted-foreground">
            See where every condition sits on the{" "}
            <Link
              to="/grading/scale"
              className="font-medium text-brand-navy hover:underline dark:text-foreground"
            >
              GradeThread condition grading scale
            </Link>
            .
          </p>
        </div>
      </section>

      {/* FAQ */}
      {term.faqs.length > 0 && (
        <section className="border-t bg-card px-6 py-16">
          <div className="mx-auto max-w-2xl">
            <h2 className="text-center text-3xl font-bold">
              {term.term} — frequently asked
            </h2>
            <dl className="mt-10 space-y-6">
              {term.faqs.map((faq) => (
                <div key={faq.q} className="border-b pb-6 last:border-b-0">
                  <dt className="font-medium">{faq.q}</dt>
                  <dd className="mt-2 text-sm text-muted-foreground">{faq.a}</dd>
                </div>
              ))}
            </dl>
          </div>
        </section>
      )}

      {/* Related terms (sideways rule) */}
      <section className="px-6 py-16">
        <div className="mx-auto max-w-3xl">
          <h2 className="text-3xl font-bold">Related terms</h2>
          <div className="mt-6 flex flex-wrap gap-3">
            {term.relatedSlugs.map((rel) => {
              const target = getResellerTermBySlug(rel);
              if (!target) return null;
              return (
                <Link
                  key={rel}
                  to={resellerTermPath(target.slug)}
                  className="rounded-full border px-4 py-2 text-sm font-medium text-brand-navy transition-colors hover:bg-brand-navy hover:text-white dark:text-foreground"
                >
                  {target.term}
                </Link>
              );
            })}
            <Link
              to={RESELLER_GLOSSARY_HUB_PATH}
              className="rounded-full border px-4 py-2 text-sm font-medium text-brand-navy transition-colors hover:bg-brand-navy hover:text-white dark:text-foreground"
            >
              All condition terms
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
