import { Link } from "react-router";
import { ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  MarketingLayout,
  MarketingCTA,
} from "@/components/marketing/marketing-layout";
import { RESELLING_PILLAR_PATH } from "@/lib/seo/reselling-guides";
import { RETURNS_SPINE } from "@/lib/seo/returns-spine";
import {
  returnsSpineJsonLd,
  returnsSpineBreadcrumbItems,
} from "@/pages/marketing/marketing-jsonld";

// US-1673: the returns spine. The designated crossover from the reselling
// universe into the grading moat — links HARD to /grading/scale and /verify.

export function ReduceEbayReturnsPage() {
  return (
    <MarketingLayout
      title={RETURNS_SPINE.title}
      description={RETURNS_SPINE.description}
      canonicalPath={RETURNS_SPINE.path}
      breadcrumbs={returnsSpineBreadcrumbItems()}
      jsonLd={returnsSpineJsonLd()}
    >
      <section className="px-6 py-16 lg:py-20">
        <div className="mx-auto max-w-3xl">
          <p className="text-sm font-medium text-muted-foreground">
            <Link to={RESELLING_PILLAR_PATH} className="hover:underline">
              Reselling
            </Link>
          </p>
          <h1 className="mt-2 text-4xl font-bold tracking-tight sm:text-5xl">
            {RETURNS_SPINE.h1}
          </h1>
          {/* Quotable answer block (AI-citable). */}
          <p className="mt-6 rounded-xl bg-muted/40 p-5 text-lg font-medium text-foreground">
            {RETURNS_SPINE.definition}
          </p>
          <p className="mt-6 text-muted-foreground">{RETURNS_SPINE.intro}</p>
        </div>
      </section>

      {/* Return-reason → disclosure mapping */}
      <section className="border-t bg-card px-6 py-16">
        <div className="mx-auto max-w-4xl">
          <h2 className="text-3xl font-bold">
            Top return reasons, and the disclosure that prevents each
          </h2>
          <div className="mt-8 space-y-6">
            {RETURNS_SPINE.reasons.map((r) => (
              <div key={r.reason} className="rounded-xl border p-5">
                <h3 className="font-semibold text-foreground">{r.reason}</h3>
                <p className="mt-2 text-sm text-muted-foreground">
                  <span className="font-medium text-foreground">Why it happens: </span>
                  {r.why}
                </p>
                <p className="mt-2 text-sm text-muted-foreground">
                  <span className="font-medium text-foreground">The fix: </span>
                  {r.fix}
                </p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {RETURNS_SPINE.sections.map((s, i) => (
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

      {/* The spine: hard links into the grading moat */}
      <section className="border-t px-6 py-16">
        <div className="mx-auto max-w-3xl rounded-xl border bg-muted/30 p-6">
          <h2 className="text-2xl font-bold">Condition accuracy is the fix</h2>
          <p className="mt-3 text-muted-foreground">
            Every condition-driven return is an expectation gap, and a
            standardized condition grade plus a verifiable certificate is how you
            close it. That's the grading moat these returns flow into — start
            with the scale, and let buyers verify before they pay.
          </p>
          <div className="mt-5 flex flex-wrap gap-3">
            <Link to="/grading/scale">
              <Button variant="outline" size="sm">
                The 1.0–10.0 grading scale
                <ArrowRight className="ml-1 h-4 w-4" />
              </Button>
            </Link>
            <Link to="/verify">
              <Button variant="outline" size="sm">
                Verify a condition certificate
                <ArrowRight className="ml-1 h-4 w-4" />
              </Button>
            </Link>
            <Link to="/condition-grading">
              <Button variant="outline" size="sm">
                What condition grading is
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
            {RETURNS_SPINE.faqs.map((faq) => (
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
