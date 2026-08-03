import { Link, useParams } from "react-router";
import { Button } from "@/components/ui/button";
import { Image } from "@/components/responsive-image";
import {
  MarketingLayout,
  MarketingCTA,
} from "@/components/marketing/marketing-layout";
import { NotFoundPage } from "@/pages/not-found";
import {
  FLAW_LIBRARY_HUB_PATH,
  FLAW_ENTRIES,
  getFlawBySlug,
  flawPath,
} from "@/lib/seo/flaw-library";
import {
  flawJsonLd,
  flawBreadcrumbItems,
  flawHubJsonLd,
  flawHubBreadcrumbItems,
  FLAW_HUB_FAQS,
} from "@/pages/marketing/marketing-jsonld";

// US-1683: the flaw library — a hub (/grading/flaws) + one page per flaw
// (/grading/flaws/:flaw). Image-rich where the graded corpus supplies photos;
// certificates deep-link each detected flaw here (the internal-link flywheel).

export function FlawLibraryHubPage() {
  return (
    <MarketingLayout
      title="Clothing Flaw Library for Grading"
      description="A library of clothing flaws — pilling, moth holes, sun fading, crocking and more — how to detect each, its grade impact, fixability, and disclosure."
      canonicalPath={FLAW_LIBRARY_HUB_PATH}
      breadcrumbs={flawHubBreadcrumbItems()}
      jsonLd={flawHubJsonLd()}
    >
      <section className="px-6 py-16 lg:py-20">
        <div className="mx-auto max-w-3xl">
          <h1 className="text-4xl font-bold tracking-tight sm:text-5xl">
            The clothing flaw library
          </h1>
          <p className="mt-6 text-lg text-foreground">
            Every flaw GradeThread's condition grading detects — how to spot it,
            how it affects the{" "}
            <Link
              to="/grading/scale"
              className="font-medium text-brand-navy hover:underline dark:text-foreground"
            >
              1.0–10.0 grade
            </Link>
            , whether it's fixable, and how to disclose it honestly in a listing.
          </p>
        </div>
      </section>

      <section className="border-t px-6 py-12">
        <div className="mx-auto max-w-3xl">
          <dl className="grid gap-4 sm:grid-cols-2">
            {FLAW_ENTRIES.map((f) => (
              <div key={f.slug} className="rounded-lg border p-4">
                <dt>
                  <Link
                    to={flawPath(f.slug)}
                    className="font-medium text-brand-navy hover:underline dark:text-foreground"
                  >
                    {f.name}
                  </Link>
                </dt>
                <dd className="mt-1 text-sm text-muted-foreground">
                  {f.definition}
                </dd>
              </div>
            ))}
          </dl>
        </div>
      </section>

      <section className="border-t bg-card px-6 py-16">
        <div className="mx-auto max-w-2xl">
          <h2 className="text-center text-3xl font-bold">Flaw grading FAQ</h2>
          <dl className="mt-10 space-y-6">
            {FLAW_HUB_FAQS.map((faq) => (
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

export function FlawPage({ slug: slugProp }: { slug?: string }) {
  const params = useParams<{ flaw: string }>();
  const slug = slugProp ?? params.flaw ?? "";
  const flaw = getFlawBySlug(slug);

  if (!flaw) return <NotFoundPage />;

  return (
    <MarketingLayout
      title={flaw.title}
      description={flaw.description}
      canonicalPath={flawPath(flaw.slug)}
      breadcrumbs={flawBreadcrumbItems(flaw)}
      jsonLd={flawJsonLd(flaw)}
    >
      <section className="px-6 py-16 lg:py-20">
        <div className="mx-auto max-w-3xl">
          <h1 className="text-4xl font-bold tracking-tight sm:text-5xl">
            {flaw.h1}
          </h1>
          {flaw.alternateNames?.length ? (
            <p className="mt-3 text-sm font-medium text-muted-foreground">
              Also: {flaw.alternateNames.join(" · ")}
            </p>
          ) : null}
          <p className="mt-6 text-lg text-foreground">{flaw.definition}</p>
        </div>
      </section>

      {/* Photos — rendered only when the graded corpus supplies them */}
      {flaw.photos?.length ? (
        <section className="border-t px-6 py-12">
          <div className="mx-auto grid max-w-3xl gap-4 sm:grid-cols-3">
            {flaw.photos.map((p) => (
              <figure key={p.url} className="overflow-hidden rounded-lg border">
                <Image
                  src={p.url}
                  alt={p.alt}
                  width={400}
                  height={400}
                  className="h-auto w-full"
                />
              </figure>
            ))}
          </div>
        </section>
      ) : null}

      <section className="border-t bg-card px-6 py-16">
        <div className="mx-auto max-w-3xl">
          <h2 className="text-2xl font-bold sm:text-3xl">How to detect it</h2>
          <ul className="mt-6 space-y-3">
            {flaw.howToDetect.map((item) => (
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

      <section className="px-6 py-16">
        <div className="mx-auto grid max-w-3xl gap-6 sm:grid-cols-3">
          <div>
            <h2 className="text-lg font-bold">Grade impact</h2>
            <p className="mt-2 text-sm text-muted-foreground">{flaw.gradeImpact}</p>
          </div>
          <div>
            <h2 className="text-lg font-bold">Fixability</h2>
            <p className="mt-2 text-sm text-muted-foreground">{flaw.fixability}</p>
          </div>
          <div>
            <h2 className="text-lg font-bold">How to disclose it</h2>
            <p className="mt-2 text-sm text-muted-foreground">{flaw.disclosure}</p>
          </div>
        </div>
      </section>

      {flaw.faqs.length > 0 && (
        <section className="border-t bg-card px-6 py-16">
          <div className="mx-auto max-w-2xl">
            <h2 className="text-center text-3xl font-bold">
              {flaw.name} — frequently asked
            </h2>
            <dl className="mt-10 space-y-6">
              {flaw.faqs.map((faq) => (
                <div key={faq.q} className="border-b pb-6 last:border-b-0">
                  <dt className="font-medium">{faq.q}</dt>
                  <dd className="mt-2 text-sm text-muted-foreground">{faq.a}</dd>
                </div>
              ))}
            </dl>
          </div>
        </section>
      )}

      <section className="px-6 py-16">
        <div className="mx-auto max-w-3xl">
          <h2 className="text-2xl font-bold">Related flaws</h2>
          <div className="mt-6 flex flex-wrap gap-3">
            {flaw.relatedSlugs.map((rel) => {
              const target = getFlawBySlug(rel);
              if (!target) return null;
              return (
                <Link
                  key={rel}
                  to={flawPath(target.slug)}
                  className="rounded-full border px-4 py-2 text-sm font-medium text-brand-navy transition-colors hover:bg-brand-navy hover:text-white dark:text-foreground"
                >
                  {target.name}
                </Link>
              );
            })}
            <Link
              to={FLAW_LIBRARY_HUB_PATH}
              className="rounded-full border px-4 py-2 text-sm font-medium text-brand-navy transition-colors hover:bg-brand-navy hover:text-white dark:text-foreground"
            >
              All flaws
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
