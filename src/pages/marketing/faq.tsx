import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import {
  MarketingLayout,
  MarketingCTA,
} from "@/components/marketing/marketing-layout";
import { ALL_FAQS, faqJsonLd } from "@/pages/marketing/marketing-jsonld";

export function FaqPage() {
  return (
    <MarketingLayout
      title="Frequently Asked Questions"
      description="Answers about AI clothing grading, the 1.0–10.0 condition scale, disputes, certificates, pricing, credits, and the GradeThread API."
      canonicalPath="/faq"
      jsonLd={faqJsonLd()}
    >
      <section className="px-6 py-16 lg:py-20">
        <div className="mx-auto max-w-3xl">
          <h1 className="text-4xl font-bold tracking-tight sm:text-5xl">
            Frequently asked questions
          </h1>
          <p className="mt-6 text-lg text-muted-foreground">
            Everything about how GradeThread grades pre-owned clothing — the
            1.0–10.0 condition scale, AI accuracy and human review, disputes,
            public certificates, pricing, and the API. Still stuck? See{" "}
            <Link
              to="/how-it-works"
              className="font-medium text-brand-navy hover:underline dark:text-foreground"
            >
              how it works
            </Link>{" "}
            or the{" "}
            <Link
              to="/condition-grading"
              className="font-medium text-brand-navy hover:underline dark:text-foreground"
            >
              condition-grading guide
            </Link>
            .
          </p>

          <dl className="mt-12 divide-y rounded-lg border bg-card p-6">
            {ALL_FAQS.map((faq) => (
              <div key={faq.q} className="py-5 first:pt-0 last:pb-0">
                <dt className="font-semibold">{faq.q}</dt>
                <dd className="mt-2 text-sm leading-relaxed text-muted-foreground">
                  {faq.a}
                </dd>
              </div>
            ))}
          </dl>

          <div className="mt-10">
            <Link to="/signup">
              <Button
                size="lg"
                className="bg-brand-navy text-white hover:bg-brand-navy/90"
              >
                Start grading free
              </Button>
            </Link>
          </div>
        </div>
      </section>

      <MarketingCTA />
    </MarketingLayout>
  );
}
