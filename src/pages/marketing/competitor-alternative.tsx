import { Link } from "react-router";
import { ArrowRight, Check, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  MarketingLayout,
  MarketingCTA,
} from "@/components/marketing/marketing-layout";
import { RESELLING_PILLAR_PATH } from "@/lib/seo/reselling-guides";
import { CROSSLIST_APPS_PATH } from "@/lib/seo/crosslisting-apps";
import {
  COMPETITOR_ALTERNATIVES_VERIFIED,
  alternativePath,
  getAlternativeBySlug,
  type CompetitorAlternative,
} from "@/lib/seo/competitor-alternatives";
import {
  alternativeJsonLd,
  alternativeBreadcrumbItems,
} from "@/pages/marketing/marketing-jsonld";
import { NotFoundPage } from "@/pages/not-found";
import { SWITCH_FROM_SLUGS, switchFromPath } from "@/lib/seo/switch-from-slugs";

// Bottom-funnel competitor alternative pages. See the rationale block in
// lib/seo/competitor-alternatives.ts — in short, "vendoo alternative" is a
// different (and far higher intent) query than "best crosslisting app", and the
// page has to be genuinely useful to the reader who should NOT switch, or it
// earns neither the ranking nor the trust.

/**
 * One page per competitor. The slug arrives as a PROP, not a route param: the
 * router registers an explicit path per entry (they have to precede the dynamic
 * /reselling/:slug, which would otherwise swallow them), so there is no param to
 * read. Same shape as OpportunistGuidePage.
 */
export function CompetitorAlternativePage({ slug }: { slug: string }) {
  const alt = getAlternativeBySlug(slug);
  if (!alt) return <NotFoundPage />;
  return <AlternativeBody alt={alt} />;
}

function AlternativeBody({ alt }: { alt: CompetitorAlternative }) {
  return (
    <MarketingLayout
      title={alt.title}
      description={alt.description}
      canonicalPath={alternativePath(alt.slug)}
      breadcrumbs={alternativeBreadcrumbItems(alt)}
      jsonLd={alternativeJsonLd(alt)}
    >
      <section className="px-6 py-16 lg:py-20">
        <div className="mx-auto max-w-3xl">
          <p className="text-sm font-medium text-muted-foreground">
            <Link to={RESELLING_PILLAR_PATH} className="hover:underline">
              Reselling
            </Link>
          </p>
          <h1 className="mt-2 text-4xl font-bold tracking-tight sm:text-5xl">
            {alt.h1}
          </h1>
          {/* Quotable answer block (AI-citable) — the direct answer first. */}
          <p className="mt-6 rounded-xl bg-muted/40 p-5 text-lg font-medium text-foreground">
            {alt.definition}
          </p>
          <p className="mt-6 text-muted-foreground">{alt.intro}</p>
          <p className="mt-3 text-sm text-muted-foreground">
            Verified {COMPETITOR_ALTERNATIVES_VERIFIED} · features and pricing
            change — verify on each tool's site before switching.
          </p>
        </div>
      </section>

      {/* US-9209: the reader who has decided goes to the page that says what
          actually moves. Every alternative page links both, because the
          crosslist reader may be leaving either of the other two. */}
      <section className="border-t px-6 py-8">
        <div className="mx-auto max-w-3xl text-sm text-muted-foreground">
          Already decided?{" "}
          {SWITCH_FROM_SLUGS.map((slug, i) => (
            <span key={slug}>
              {i > 0 ? " or " : ""}
              <Link to={switchFromPath(slug)} className="underline underline-offset-2">
                what transfers when you switch from {slug === "vendoo" ? "Vendoo" : "List Perfectly"}
              </Link>
            </span>
          ))}
          .
        </div>
      </section>

      {/* Reasons to STAY, deliberately placed before the alternatives. A reader
          who should not switch is better served by being told so, and a page
          that only sells the switch is the one nobody trusts or cites. */}
      <section className="border-t bg-card px-6 py-16">
        <div className="mx-auto max-w-3xl">
          <h2 className="text-2xl font-bold sm:text-3xl">
            What {alt.competitor} does well
          </h2>
          <p className="mt-3 text-muted-foreground">
            Worth being honest about first — if these are the things you rely on,
            switching may cost you more in migration and relearning than it
            returns.
          </p>
          <ul className="mt-8 space-y-3">
            {alt.strengths.map((s) => (
              <li key={s} className="flex gap-3 text-muted-foreground">
                <Check className="mt-1 h-4 w-4 flex-shrink-0 text-brand-navy dark:text-foreground" />
                {s}
              </li>
            ))}
          </ul>
        </div>
      </section>

      <section className="border-t px-6 py-16">
        <div className="mx-auto max-w-3xl">
          <h2 className="text-2xl font-bold sm:text-3xl">
            Why resellers look for an alternative
          </h2>
          <p className="mt-3 text-muted-foreground">
            These are the reasons sellers commonly cite. Identify which one is
            actually yours — the right replacement depends entirely on that, and
            "it feels clunky" usually is not a reason a different tool fixes.
          </p>
          <ul className="mt-8 space-y-3">
            {alt.switchReasons.map((r) => (
              <li key={r} className="flex gap-3 text-muted-foreground">
                <TriangleAlert className="mt-1 h-4 w-4 flex-shrink-0 text-brand-red-text" />
                {r}
              </li>
            ))}
          </ul>
        </div>
      </section>

      <section className="border-t bg-card px-6 py-16">
        <div className="mx-auto max-w-3xl">
          <h2 className="text-2xl font-bold sm:text-3xl">
            {alt.competitor} alternatives, matched to the reason
          </h2>
          <div className="mt-8 space-y-4">
            {alt.options.map((opt) => (
              <div
                key={opt.name}
                className={
                  opt.isOurs
                    ? "rounded-xl border-2 border-brand-navy bg-background p-6 dark:border-foreground"
                    : "rounded-xl border bg-background p-6"
                }
              >
                <h3 className="text-xl font-bold">{opt.name}</h3>
                <p className="mt-1 text-muted-foreground">
                  Pick this if you are {opt.bestFor}.
                </p>
              </div>
            ))}
          </div>
          <p className="mt-8 text-sm text-muted-foreground">
            For the full side-by-side including pros and cons, see the{" "}
            <Link
              to={CROSSLIST_APPS_PATH}
              className="font-medium text-brand-navy hover:underline dark:text-foreground"
            >
              best crosslisting apps roundup
            </Link>
            .
          </p>
        </div>
      </section>

      <section className="border-t px-6 py-16">
        <div className="mx-auto max-w-3xl rounded-xl border bg-muted/30 p-6">
          <h2 className="text-2xl font-bold">
            If returns are the reason, no crosslister fixes it
          </h2>
          <p className="mt-3 text-muted-foreground">
            Every tool on this page changes how fast listings go out. None of
            them changes how accurately condition is described — and condition
            mismatch is the leading cause of "not as described" claims. If that
            is where your margin is going, faster listing is the wrong lever.
            FlipDesk builds a standardized 1.0–10.0 condition grade and a
            buyer-verifiable certificate into the listing flow, so listings set
            expectations the buyer can check before they open a case.
          </p>
          <div className="mt-5 flex flex-wrap gap-3">
            <Link to="/tools/grade-checker">
              <Button variant="outline" size="sm">
                Grade a photo free — no signup
                <ArrowRight className="ml-1 h-4 w-4" />
              </Button>
            </Link>
            <Link to="/reselling/reduce-ebay-returns">
              <Button variant="outline" size="sm">
                How to cut "not as described" returns
                <ArrowRight className="ml-1 h-4 w-4" />
              </Button>
            </Link>
          </div>
        </div>
      </section>

      <section className="border-t bg-card px-6 py-16">
        <div className="mx-auto max-w-2xl">
          <h2 className="text-center text-3xl font-bold">Frequently asked</h2>
          <dl className="mt-10 space-y-6">
            {alt.faqs.map((faq) => (
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
