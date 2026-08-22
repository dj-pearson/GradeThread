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
  FIBER_LABELS,
  matrixEntriesForFlaw,
  matrixPath,
} from "@/lib/seo/care-matrix";
import {
  flawJsonLd,
  flawBreadcrumbItems,
  flawHubJsonLd,
  flawHubBreadcrumbItems,
  FLAW_HUB_FAQS,
} from "@/pages/marketing/marketing-jsonld";

// US-1683: the flaw library — a hub + one page per flaw. US-9012 moved both
// from /grading/flaws to /care (/care and /care/:flaw); the old URLs 301. Image-rich where the graded corpus supplies photos;
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

  // Empty for the seven flaws that have no fabric-specific page yet, so the
  // section below renders nothing rather than an empty heading.
  const fibreEntries = matrixEntriesForFlaw(flaw.slug);

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

      {/* US-9012: removal comes FIRST. The reader has the garment in their hand
          and wants the mark gone; detection, grading and disclosure are our
          questions, not theirs, and they now sit below the answer. */}
      <section className="border-t bg-card px-6 py-16">
        <div className="mx-auto max-w-3xl">
          <h2 className="text-2xl font-bold sm:text-3xl">{flaw.removalHeading}</h2>
          {flaw.comesOut === "no" && (
            <p className="mt-4 rounded-lg border px-4 py-3 text-sm">
              <strong>Short answer: it does not come out.</strong> Everything
              below is about what to do instead. We would rather tell you that
              in the first line than sell you an afternoon of scrubbing.
            </p>
          )}
          {flaw.comesOut === "sometimes" && (
            <p className="mt-4 rounded-lg border px-4 py-3 text-sm">
              <strong>Short answer: sometimes.</strong> It depends on what
              exactly you have and how long it has been there. The steps below
              say where it stops working rather than pretending it always does.
            </p>
          )}
          <ol className="mt-6 space-y-3">
            {flaw.removal.map((step, i) => (
              <li key={step} className="flex gap-3 rounded-lg border bg-background p-4 text-sm">
                <span className="font-semibold tabular-nums text-muted-foreground">
                  {i + 1}
                </span>
                <span>{step}</span>
              </li>
            ))}
          </ol>
          <h3 className="mt-10 text-lg font-bold">Stopping it happening again</h3>
          <p className="mt-2 text-muted-foreground">{flaw.prevention}</p>
        </div>
      </section>

      {/* US-9013: the full repair guide, on the seven entries where somebody is
          actually going to pick up a needle. The HowTo JSON-LD is built from
          this same array, so the markup can never describe steps the page does
          not show. */}
      {flaw.repair && (
        <section className="border-t px-6 py-16">
          <div className="mx-auto max-w-3xl">
            <h2 className="text-2xl font-bold sm:text-3xl">{flaw.repair.name}</h2>
            <dl className="mt-5 flex flex-wrap gap-x-8 gap-y-2 text-sm">
              <div>
                <dt className="inline font-medium">Difficulty: </dt>
                <dd className="inline text-muted-foreground">{flaw.repair.difficulty}</dd>
              </div>
              <div>
                <dt className="inline font-medium">Time: </dt>
                <dd className="inline text-muted-foreground">
                  About {flaw.repair.minutes} minutes
                </dd>
              </div>
              <div>
                <dt className="inline font-medium">Cost: </dt>
                <dd className="inline text-muted-foreground">{flaw.repair.cost}</dd>
              </div>
            </dl>

            {(flaw.repair.tools.length > 0 || flaw.repair.supplies.length > 0) && (
              <div className="mt-6 grid gap-6 sm:grid-cols-2">
                {flaw.repair.tools.length > 0 && (
                  <div>
                    <h3 className="text-sm font-bold">Tools</h3>
                    <ul className="mt-2 space-y-1 text-sm text-muted-foreground">
                      {flaw.repair.tools.map((t) => (
                        <li key={t}>{t}</li>
                      ))}
                    </ul>
                  </div>
                )}
                {flaw.repair.supplies.length > 0 && (
                  <div>
                    <h3 className="text-sm font-bold">Materials</h3>
                    <ul className="mt-2 space-y-1 text-sm text-muted-foreground">
                      {flaw.repair.supplies.map((t) => (
                        <li key={t}>{t}</li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            )}

            <ol className="mt-8 space-y-5">
              {flaw.repair.steps.map((step, i) => (
                <li key={step.name} id={`step-${i + 1}`} className="border-b pb-5 last:border-b-0">
                  <h3 className="font-medium">
                    <span className="mr-2 tabular-nums text-muted-foreground">{i + 1}.</span>
                    {step.name}
                  </h3>
                  <p className="mt-1 text-sm text-muted-foreground">{step.text}</p>
                </li>
              ))}
            </ol>
          </div>
        </section>
      )}

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

      {/* US-9014 down-links. Every /care/:flaw/:fabric page was ORPHANED: 18 of
          them in the sitemap and not one internal link from the flaw page above
          it, across all 11 parents. matrixEntriesForFlaw was written for exactly
          this — "for the parent page to link down to" — and had no callers, so
          the audit reported it as a dead export rather than as a missing
          section, which is what it was.

          Each row carries the child's own "what changes" line rather than just
          its title. That is the same test the matrix uses to decide a
          combination deserves a page at all: if you cannot write the line, the
          page does not exist. Reusing it here means this block is worth reading
          on its own, not a list of links wearing a heading. */}
      {fibreEntries.length > 0 && (
        <section className="border-t px-6 py-16">
          <div className="mx-auto max-w-3xl">
            <h2 className="text-2xl font-bold sm:text-3xl">
              What changes by fabric
            </h2>
            <p className="mt-3 text-muted-foreground">
              The method above is the general one. These fabrics need a
              different approach.
            </p>
            <ul className="mt-6 space-y-4">
              {fibreEntries.map((entry) => (
                <li key={matrixPath(entry)}>
                  <Link
                    to={matrixPath(entry)}
                    className="font-semibold underline-offset-4 hover:underline"
                  >
                    {entry.h1}
                  </Link>
                  <p className="mt-1 text-muted-foreground">
                    <span className="capitalize">{FIBER_LABELS[entry.fiber]}</span>
                    {" — "}
                    {entry.differs}
                  </p>
                </li>
              ))}
            </ul>
          </div>
        </section>
      )}
      <section className="border-t px-6 py-16">
        <div className="mx-auto max-w-3xl">
          <h2 className="text-2xl font-bold sm:text-3xl">How to spot it</h2>
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

      {/* US-9012 AC4: the honest hinge. Whatever the removal section managed,
          some of it stays, and what stays has a price. This is the ONE-WAY link
          down into the reseller spine — care pages point at grading and pricing,
          and those pages do not point back up here (US-9015 guards that). */}
      <section className="border-t px-6 py-16">
        <div className="mx-auto max-w-3xl">
          <h2 className="text-2xl font-bold sm:text-3xl">
            {flaw.comesOut === "no"
              ? "It is staying, so the question is what it costs"
              : "What if it does not all come out?"}
          </h2>
          <p className="mt-4 text-muted-foreground">
            {flaw.comesOut === "no"
              ? `${flaw.name} is permanent, which means the garment is worth what a garment with ${flaw.name.toLowerCase()} is worth. That is a smaller number than the same piece without it, and it is not zero. The gap between those two numbers is what a condition grade measures.`
              : `Most of the time some of it stays, and the leftover is what a buyer sees. A garment is worth what its condition says it is worth, so the sensible next question is how much this particular flaw moves the number.`}
          </p>
          <div className="mt-5 flex flex-wrap gap-4 text-sm font-medium">
            <Link to="/resale-value-by-condition" className="text-brand-red-text hover:underline">
              What each condition grade is worth
            </Link>
            <Link to="/condition-grading" className="text-brand-red-text hover:underline">
              How condition grading works
            </Link>
            <Link to="/tools/reseller-profit-calculator" className="text-brand-red-text hover:underline">
              Price it with the condition built in
            </Link>
          </div>
        </div>
      </section>

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
