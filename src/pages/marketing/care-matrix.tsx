import { Link, useLocation } from "react-router";
import { ArrowRight } from "lucide-react";
import { MarketingLayout, MarketingCTA } from "@/components/marketing/marketing-layout";
import { NotFoundPage } from "@/pages/not-found";
import {
  FIBER_LABELS,
  getMatrixEntryByPath,
  matrixPath,
} from "@/lib/seo/care-matrix";
import { flawPath, getFlawBySlug } from "@/lib/seo/flaw-library";
import {
  careMatrixJsonLd,
  careMatrixBreadcrumbItems,
} from "@/pages/marketing/marketing-jsonld";

// US-9014. One page per flaw-and-fibre combination whose procedure genuinely
// differs from the parent flaw page. Eighteen of a possible 192.
//
// The page leads with WHAT CHANGES rather than with the flaw again. Somebody
// who searched "how to get a stain out of silk" has already read a generic
// stain page and found it did not answer their question; repeating it here
// wastes the one thing this URL has, which is specificity.

export function CareMatrixPage({ path: pathProp }: { path?: string }) {
  const { pathname } = useLocation();
  const entry = getMatrixEntryByPath(pathProp ?? pathname);
  if (!entry) return <NotFoundPage />;
  const parent = getFlawBySlug(entry.flaw);

  return (
    <MarketingLayout
      title={entry.title}
      description={entry.description}
      canonicalPath={matrixPath(entry)}
      breadcrumbs={careMatrixBreadcrumbItems(entry)}
      jsonLd={careMatrixJsonLd(entry)}
    >
      <section className="px-6 py-16 lg:py-20">
        <div className="mx-auto max-w-3xl">
          {parent && (
            <p className="text-sm font-medium text-muted-foreground">
              <Link to={flawPath(parent.slug)} className="hover:underline">
                {parent.name}
              </Link>
            </p>
          )}
          <h1 className="mt-2 text-4xl font-bold tracking-tight sm:text-5xl">{entry.h1}</h1>
          <p className="mt-6 rounded-xl border px-5 py-4 text-lg text-foreground">
            <strong>What changes on {FIBER_LABELS[entry.fiber]}.</strong> {entry.differs}
          </p>
        </div>
      </section>

      <section className="border-y bg-card px-6 py-16">
        <div className="mx-auto max-w-3xl">
          <h2 className="text-2xl font-bold sm:text-3xl">
            The method for {FIBER_LABELS[entry.fiber]}
          </h2>
          <ol className="mt-6 space-y-3">
            {entry.steps.map((step, i) => (
              <li
                key={step}
                id={`step-${i + 1}`}
                className="flex gap-3 rounded-lg border bg-background p-4 text-sm"
              >
                <span className="font-semibold tabular-nums text-muted-foreground">{i + 1}</span>
                <span>{step}</span>
              </li>
            ))}
          </ol>

          <div className="mt-8 rounded-xl border p-5">
            <h3 className="font-bold">What ruins it</h3>
            <p className="mt-2 text-sm text-muted-foreground">{entry.neverDo}</p>
          </div>
        </div>
      </section>

      {parent && (
        <section className="px-6 py-16">
          <div className="mx-auto max-w-3xl">
            <h2 className="text-2xl font-bold sm:text-3xl">
              The general case, and what it costs you
            </h2>
            <p className="mt-4 text-muted-foreground">
              {parent.comesOut === "no"
                ? `${parent.name} does not come out of any fabric. What differs between fibres is what you can do instead, and what the damage costs when you sell the garment.`
                : `The general method, the detection notes and what this does to a garment's resale value are on the ${parent.name.toLowerCase()} page.`}
            </p>
            <div className="mt-5 flex flex-wrap gap-4 text-sm font-medium">
              <Link to={flawPath(parent.slug)} className="text-brand-red-text hover:underline">
                All of {parent.name.toLowerCase()}
              </Link>
              <Link to="/resale-value-by-condition" className="text-brand-red-text hover:underline">
                What each condition grade is worth
              </Link>
            </div>
            <div className="mt-6">
              <Link to="/condition-grading">
                <span className="inline-flex items-center text-sm font-medium text-brand-red-text hover:underline">
                  How condition grading works
                  <ArrowRight className="ml-1 h-4 w-4" />
                </span>
              </Link>
            </div>
          </div>
        </section>
      )}

      <MarketingCTA />
    </MarketingLayout>
  );
}
