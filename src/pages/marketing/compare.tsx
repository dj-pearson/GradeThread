import { Link, useParams } from "react-router-dom";
import { ArrowRight, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  MarketingLayout,
  MarketingCTA,
} from "@/components/marketing/marketing-layout";
import { NotFoundPage } from "@/pages/not-found";
import {
  COMPARE_HUB_PATH,
  COMPARISONS,
  COMPARISON_VERIFIED,
  comparePath,
  getComparisonBySlug,
} from "@/lib/seo/comparison-guides";
import {
  compareHubJsonLd,
  compareHubBreadcrumbItems,
  comparisonJsonLd,
  comparisonBreadcrumbItems,
} from "@/pages/marketing/marketing-jsonld";

// US-1667: reusable marketplace comparison template (/compare/{a}-vs-{b}) + the
// hand-written flagship /compare/mercari-vs-ebay. Every comparison carries a
// unique returns/condition-dispute row (the grading wedge) and links up to the
// returns spine + /grading/scale.

export function CompareHubPage() {
  return (
    <MarketingLayout
      title="Marketplace Comparisons for Resellers"
      description="Compare the marketplaces resellers sell used clothes on — fees, reach, shipping, payout speed, and how each handles condition disputes and returns."
      canonicalPath={COMPARE_HUB_PATH}
      breadcrumbs={compareHubBreadcrumbItems()}
      jsonLd={compareHubJsonLd()}
    >
      <section className="px-6 py-16 lg:py-20">
        <div className="mx-auto max-w-3xl">
          <h1 className="text-4xl font-bold tracking-tight sm:text-5xl">
            Marketplace comparisons for resellers
          </h1>
          <p className="mt-6 text-lg text-foreground">
            Where you sell decides your fees, your reach, and — the part most
            comparisons skip — how a condition dispute gets resolved. These
            head-to-head guides cover all three, with a column on returns and
            condition-dispute handling that no generic comparison has.
          </p>
        </div>
      </section>

      <section className="border-t bg-card px-6 py-16">
        <div className="mx-auto max-w-3xl">
          <h2 className="text-3xl font-bold">Comparisons</h2>
          <ul className="mt-6 space-y-4">
            {COMPARISONS.map((c) => (
              <li key={c.slug} className="border-b pb-4 last:border-b-0">
                <Link
                  to={comparePath(c.slug)}
                  className="text-lg font-medium text-brand-navy hover:underline dark:text-foreground"
                >
                  {c.platformA} vs {c.platformB}
                </Link>
                <p className="mt-1 text-sm text-muted-foreground">
                  {c.description}
                </p>
              </li>
            ))}
          </ul>
        </div>
      </section>

      <MarketingCTA />
    </MarketingLayout>
  );
}

export function ComparisonPage({ slug: slugProp }: { slug?: string }) {
  const params = useParams<{ slug: string }>();
  const slug = slugProp ?? params.slug ?? "";
  const cmp = getComparisonBySlug(slug);

  if (!cmp) return <NotFoundPage />;

  return (
    <MarketingLayout
      title={cmp.title}
      description={cmp.description}
      canonicalPath={comparePath(cmp.slug)}
      breadcrumbs={comparisonBreadcrumbItems(cmp)}
      jsonLd={comparisonJsonLd(cmp)}
    >
      <section className="px-6 py-16 lg:py-20">
        <div className="mx-auto max-w-3xl">
          <p className="text-sm font-medium text-muted-foreground">
            <Link to={COMPARE_HUB_PATH} className="hover:underline">
              Comparisons
            </Link>
          </p>
          <h1 className="mt-2 text-4xl font-bold tracking-tight sm:text-5xl">
            {cmp.h1}
          </h1>
          <p className="mt-3 text-sm text-muted-foreground">
            Verified {COMPARISON_VERIFIED} · fees and policies change — verify
            current rates before you price.
          </p>
          <p className="mt-6 text-lg text-foreground">{cmp.intro}</p>
        </div>
      </section>

      {/* The comparison table */}
      <section className="border-t bg-card px-6 py-16">
        <div className="mx-auto max-w-4xl">
          <h2 className="text-3xl font-bold">
            {cmp.platformA} vs {cmp.platformB}, side by side
          </h2>
          <div className="mt-8 overflow-x-auto">
            <table className="w-full min-w-[640px] border-collapse text-left text-sm">
              <thead>
                <tr className="border-b">
                  <th className="py-3 pr-4 font-semibold">&nbsp;</th>
                  <th className="py-3 pr-4 font-semibold">{cmp.platformA}</th>
                  <th className="py-3 font-semibold">{cmp.platformB}</th>
                </tr>
              </thead>
              <tbody>
                {cmp.rows.map((row) => (
                  <tr
                    key={row.dimension}
                    className={
                      row.wedge
                        ? "border-b bg-brand-red/5 align-top"
                        : "border-b align-top"
                    }
                  >
                    <th className="py-4 pr-4 font-medium">
                      {row.dimension}
                      {row.wedge ? (
                        <span className="mt-1 flex items-center gap-1 text-xs font-normal text-brand-red">
                          <ShieldCheck className="h-3.5 w-3.5" />
                          Where a grade protects you
                        </span>
                      ) : null}
                    </th>
                    <td className="py-4 pr-4 text-muted-foreground">{row.a}</td>
                    <td className="py-4 text-muted-foreground">{row.b}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </section>

      {cmp.sections.map((s, i) => (
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

      {/* Verdict */}
      <section className="border-t px-6 py-16">
        <div className="mx-auto max-w-3xl">
          <h2 className="text-2xl font-bold sm:text-3xl">The verdict</h2>
          <p className="mt-4 text-muted-foreground">{cmp.verdict}</p>
        </div>
      </section>

      {/* The grading wedge — links to scale + returns spine */}
      <section className="border-t bg-card px-6 py-16">
        <div className="mx-auto max-w-3xl rounded-xl border bg-muted/30 p-6">
          <h2 className="text-2xl font-bold">
            The one risk both platforms share
          </h2>
          <p className="mt-3 text-muted-foreground">{cmp.gradingWedge}</p>
          <div className="mt-5 flex flex-wrap gap-3">
            <Link to="/grading/scale">
              <Button variant="outline" size="sm">
                The 1.0–10.0 grading scale
                <ArrowRight className="ml-1 h-4 w-4" />
              </Button>
            </Link>
            <Link to="/reduce-returns">
              <Button variant="outline" size="sm">
                Cut condition returns
                <ArrowRight className="ml-1 h-4 w-4" />
              </Button>
            </Link>
          </div>
        </div>
      </section>

      {cmp.faqs.length > 0 && (
        <section className="border-t px-6 py-16">
          <div className="mx-auto max-w-2xl">
            <h2 className="text-center text-3xl font-bold">Frequently asked</h2>
            <dl className="mt-10 space-y-6">
              {cmp.faqs.map((faq) => (
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
