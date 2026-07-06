import { Link, useParams } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Image } from "@/components/responsive-image";
import {
  MarketingLayout,
  MarketingCTA,
} from "@/components/marketing/marketing-layout";
import { NotFoundPage } from "@/pages/not-found";
import {
  GARMENT_GUIDES_HUB_PATH,
  GARMENT_GUIDES,
  getGuideBySlug,
  guidePath,
} from "@/lib/seo/garment-guides";
import { getFlawBySlug, flawPath } from "@/lib/seo/flaw-library";
import {
  garmentGuideJsonLd,
  guideBreadcrumbItems,
  garmentHubJsonLd,
  guideHubBreadcrumbItems,
  GARMENT_HUB_FAQS,
} from "@/pages/marketing/marketing-jsonld";

// US-1682: garment-type grading guides — a hub (/grading/guides) + one guide per
// garment (/grading/guides/:garment). The garment-specific criteria + steps are
// the proprietary rubric rendered as content; flaw deep-links feed the flywheel.

export function GarmentGuidesHubPage() {
  return (
    <MarketingLayout
      title="How to Grade Used Clothing by Type"
      description="Garment-by-garment grading guides — denim, leather, knitwear, activewear and more — each with the flaws to check, a photo checklist, and graded examples."
      canonicalPath={GARMENT_GUIDES_HUB_PATH}
      breadcrumbs={guideHubBreadcrumbItems()}
      jsonLd={garmentHubJsonLd()}
    >
      <section className="px-6 py-16 lg:py-20">
        <div className="mx-auto max-w-3xl">
          <h1 className="text-4xl font-bold tracking-tight sm:text-5xl">
            How to grade used clothing, by type
          </h1>
          <p className="mt-6 text-lg text-foreground">
            The 1.0–10.0 scale is universal, but wear isn't. Each guide gives the
            garment-specific flaws to check, an inspection checklist, and graded
            examples — so a denim jacket, a cashmere sweater, and a pair of
            activewear leggings each get graded on what actually fails for them.
          </p>
        </div>
      </section>

      <section className="border-t px-6 py-12">
        <div className="mx-auto max-w-3xl">
          <ul className="grid gap-3 sm:grid-cols-2">
            {GARMENT_GUIDES.map((g) => (
              <li key={g.slug}>
                <Link
                  to={guidePath(g.slug)}
                  className="block rounded-lg border p-4 transition-colors hover:border-brand-navy"
                >
                  <span className="font-medium text-brand-navy dark:text-foreground">
                    {g.h1}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </div>
      </section>

      <section className="border-t bg-card px-6 py-16">
        <div className="mx-auto max-w-2xl">
          <h2 className="text-center text-3xl font-bold">Grading by type FAQ</h2>
          <dl className="mt-10 space-y-6">
            {GARMENT_HUB_FAQS.map((faq) => (
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

export function GarmentGuidePage({ slug: slugProp }: { slug?: string }) {
  const params = useParams<{ garment: string }>();
  const slug = slugProp ?? params.garment ?? "";
  const guide = getGuideBySlug(slug);

  if (!guide) return <NotFoundPage />;

  return (
    <MarketingLayout
      title={guide.title}
      description={guide.description}
      canonicalPath={guidePath(guide.slug)}
      breadcrumbs={guideBreadcrumbItems(guide)}
      jsonLd={garmentGuideJsonLd(guide)}
    >
      <section className="px-6 py-16 lg:py-20">
        <div className="mx-auto max-w-3xl">
          <h1 className="text-4xl font-bold tracking-tight sm:text-5xl">
            {guide.h1}
          </h1>
          <p className="mt-6 text-lg text-foreground">{guide.intro}</p>
        </div>
      </section>

      {/* Photos — rendered only when the graded corpus supplies them */}
      {guide.photos?.length ? (
        <section className="border-t px-6 py-12">
          <div className="mx-auto grid max-w-3xl gap-4 sm:grid-cols-3">
            {guide.photos.map((p) => (
              <figure key={p.url} className="overflow-hidden rounded-lg border">
                <Image src={p.url} alt={p.alt} width={400} height={400} className="h-auto w-full" />
              </figure>
            ))}
          </div>
        </section>
      ) : null}

      {/* Garment-specific criteria */}
      <section className="border-t bg-card px-6 py-16">
        <div className="mx-auto max-w-3xl">
          <h2 className="text-2xl font-bold sm:text-3xl">What to check</h2>
          <ul className="mt-6 space-y-3">
            {guide.criteria.map((c) => (
              <li
                key={c}
                className="flex gap-3 rounded-lg border bg-background p-4 text-sm"
              >
                <span
                  aria-hidden
                  className="mt-1.5 h-2 w-2 flex-shrink-0 rounded-full bg-brand-red"
                />
                <span>{c}</span>
              </li>
            ))}
          </ul>
        </div>
      </section>

      {/* HowTo steps */}
      <section className="px-6 py-16">
        <div className="mx-auto max-w-3xl">
          <h2 className="text-2xl font-bold sm:text-3xl">
            How to grade it, step by step
          </h2>
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

      {/* Graded examples */}
      <section className="border-t bg-card px-6 py-16">
        <div className="mx-auto max-w-3xl">
          <h2 className="text-2xl font-bold sm:text-3xl">Graded examples</h2>
          <div className="mt-6 overflow-x-auto rounded-lg border">
            <table className="w-full text-sm">
              <thead className="bg-muted/50">
                <tr>
                  <th className="px-4 py-3 text-left font-semibold">Grade</th>
                  <th className="px-4 py-3 text-left font-semibold">Why</th>
                </tr>
              </thead>
              <tbody>
                {guide.gradedExamples.map((ex) => (
                  <tr key={ex.grade} className="border-t align-top">
                    <td className="whitespace-nowrap px-4 py-3 font-semibold tabular-nums text-brand-navy dark:text-foreground">
                      {ex.grade}
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">{ex.note}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-6 text-sm text-muted-foreground">
            Every grade sits on the{" "}
            <Link
              to="/grading/scale"
              className="font-medium text-brand-navy hover:underline dark:text-foreground"
            >
              GradeThread 1.0–10.0 scale
            </Link>
            .
          </p>
        </div>
      </section>

      {/* Related flaws (deep-link into the flaw library) */}
      {guide.relatedFlawSlugs.length > 0 && (
        <section className="px-6 py-16">
          <div className="mx-auto max-w-3xl">
            <h2 className="text-2xl font-bold">Flaws to watch on this garment</h2>
            <div className="mt-6 flex flex-wrap gap-3">
              {guide.relatedFlawSlugs.map((rel) => {
                const flaw = getFlawBySlug(rel);
                if (!flaw) return null;
                return (
                  <Link
                    key={rel}
                    to={flawPath(flaw.slug)}
                    className="rounded-full border px-4 py-2 text-sm font-medium text-brand-navy transition-colors hover:bg-brand-navy hover:text-white dark:text-foreground"
                  >
                    {flaw.name}
                  </Link>
                );
              })}
            </div>
          </div>
        </section>
      )}

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
            <div className="mt-10 text-center">
              <Link to="/signup">
                <Button size="lg" className="bg-brand-navy text-white hover:bg-brand-navy/90">
                  Grade an item free
                </Button>
              </Link>
            </div>
          </div>
        </section>
      )}

      <MarketingCTA />
    </MarketingLayout>
  );
}
