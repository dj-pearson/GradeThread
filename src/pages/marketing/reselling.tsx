import { Link, useParams } from "react-router-dom";
import { ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  MarketingLayout,
  MarketingCTA,
} from "@/components/marketing/marketing-layout";
import { NotFoundPage } from "@/pages/not-found";
import {
  RESELLING_PILLAR,
  RESELLING_GUIDES,
  getResellingGuideBySlug,
  resellingGuidePath,
} from "@/lib/seo/reselling-guides";
import {
  resellingPillarJsonLd,
  resellingPillarBreadcrumbItems,
  resellingGuideJsonLd,
  resellingGuideBreadcrumbItems,
} from "@/pages/marketing/marketing-jsonld";

// US-1688: the reselling workflow pillar (/reselling) + TOFU guides
// (/reselling/:slug). Every guide weaves in a grading step (the wedge) and links
// to the returns spine (/reduce-returns) and /grading/scale.

export function ResellingPillarPage() {
  return (
    <MarketingLayout
      title={RESELLING_PILLAR.title}
      description={RESELLING_PILLAR.description}
      canonicalPath={RESELLING_PILLAR.path}
      breadcrumbs={resellingPillarBreadcrumbItems()}
      jsonLd={resellingPillarJsonLd()}
    >
      <section className="px-6 py-16 lg:py-20">
        <div className="mx-auto max-w-3xl">
          <h1 className="text-4xl font-bold tracking-tight sm:text-5xl">
            {RESELLING_PILLAR.h1}
          </h1>
          <p className="mt-6 text-lg text-foreground">{RESELLING_PILLAR.intro}</p>
        </div>
      </section>

      {/* The workflow (HowTo steps) */}
      <section className="border-t bg-card px-6 py-16">
        <div className="mx-auto max-w-3xl">
          <h2 className="text-3xl font-bold">The workflow, source to ship</h2>
          <ol className="mt-8 space-y-6">
            {RESELLING_PILLAR.steps.map((s, i) => (
              <li key={s.name} className="flex gap-4">
                <span className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-brand-navy text-sm font-bold text-white">
                  {i + 1}
                </span>
                <div>
                  <p className="font-medium text-foreground">{s.name}</p>
                  <p className="mt-1 text-muted-foreground">{s.text}</p>
                  {s.guideSlug ? (
                    <Link
                      to={resellingGuidePath(s.guideSlug)}
                      className="mt-1 inline-block text-sm font-medium text-brand-navy hover:underline dark:text-foreground"
                    >
                      Read the guide →
                    </Link>
                  ) : null}
                </div>
              </li>
            ))}
          </ol>
        </div>
      </section>

      {/* Where grading fits (the wedge) */}
      <section className="px-6 py-16">
        <div className="mx-auto max-w-3xl">
          <h2 className="text-3xl font-bold">Where condition grading fits</h2>
          <p className="mt-4 text-muted-foreground">
            Condition is the buyer's biggest question and the top cause of
            returns. Grading each item on a standardized{" "}
            <Link
              to="/grading/scale"
              className="font-medium text-brand-navy hover:underline dark:text-foreground"
            >
              1.0–10.0 condition scale
            </Link>{" "}
            and attaching a verifiable certificate is how a listing earns trust —
            and how you{" "}
            <Link
              to="/reduce-returns"
              className="font-medium text-brand-navy hover:underline dark:text-foreground"
            >
              cut &ldquo;not as described&rdquo; returns
            </Link>{" "}
            at the source.
          </p>
        </div>
      </section>

      {/* Guide index */}
      <section className="border-t bg-card px-6 py-16">
        <div className="mx-auto max-w-3xl">
          <h2 className="text-3xl font-bold">Reselling guides</h2>
          <ul className="mt-6 space-y-4">
            {RESELLING_GUIDES.map((g) => (
              <li key={g.slug} className="border-b pb-4 last:border-b-0">
                <Link
                  to={resellingGuidePath(g.slug)}
                  className="text-lg font-medium text-brand-navy hover:underline dark:text-foreground"
                >
                  {g.h1}
                </Link>
                <p className="mt-1 text-sm text-muted-foreground">
                  {g.description}
                </p>
              </li>
            ))}
          </ul>
        </div>
      </section>

      <section className="px-6 py-16">
        <div className="mx-auto max-w-2xl">
          <h2 className="text-center text-3xl font-bold">Reselling FAQ</h2>
          <dl className="mt-10 space-y-6">
            {RESELLING_PILLAR.faqs.map((faq) => (
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

export function ResellingGuidePage({ slug: slugProp }: { slug?: string }) {
  const params = useParams<{ slug: string }>();
  const slug = slugProp ?? params.slug ?? "";
  const guide = getResellingGuideBySlug(slug);

  if (!guide) return <NotFoundPage />;

  return (
    <MarketingLayout
      title={guide.title}
      description={guide.description}
      canonicalPath={resellingGuidePath(guide.slug)}
      breadcrumbs={resellingGuideBreadcrumbItems(guide)}
      jsonLd={resellingGuideJsonLd(guide)}
    >
      <section className="px-6 py-16 lg:py-20">
        <div className="mx-auto max-w-3xl">
          <p className="text-sm font-medium text-muted-foreground">
            <Link to={RESELLING_PILLAR.path} className="hover:underline">
              Reselling
            </Link>
          </p>
          <h1 className="mt-2 text-4xl font-bold tracking-tight sm:text-5xl">
            {guide.h1}
          </h1>
          <p className="mt-6 text-lg text-foreground">{guide.intro}</p>
        </div>
      </section>

      {guide.sections.map((s, i) => (
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

      {/* The grading wedge — every guide has one, linking to scale + returns spine */}
      <section className="border-t px-6 py-16">
        <div className="mx-auto max-w-3xl rounded-xl border bg-muted/30 p-6">
          <h2 className="text-2xl font-bold">Where grading fits</h2>
          <p className="mt-3 text-muted-foreground">{guide.gradingWedge}</p>
          <div className="mt-5 flex flex-wrap gap-3">
            <Link to="/grading/scale">
              <Button variant="outline" size="sm">
                The grading scale
                <ArrowRight className="ml-1 h-4 w-4" />
              </Button>
            </Link>
            <Link to="/reduce-returns">
              <Button variant="outline" size="sm">
                Cut returns
                <ArrowRight className="ml-1 h-4 w-4" />
              </Button>
            </Link>
          </div>
        </div>
      </section>

      {guide.faqs.length > 0 && (
        <section className="border-t bg-card px-6 py-16">
          <div className="mx-auto max-w-2xl">
            <h2 className="text-center text-3xl font-bold">
              Frequently asked
            </h2>
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
