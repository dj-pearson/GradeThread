import { Link } from "react-router";
import { Button } from "@/components/ui/button";
import { GRADING_REVIEW_CONFIDENCE_THRESHOLD } from "@/lib/constants";
import {
  MarketingLayout,
  MarketingCTA,
} from "@/components/marketing/marketing-layout";
import {
  METHODOLOGY_FAQS,
  methodologyJsonLd,
} from "@/pages/marketing/marketing-jsonld";

// US-1677 (E-E-A-T): the methodology page — trust collateral for buyers,
// journalists, and LLMs. How the model is trained + evaluated, what the grade
// claims, error handling, and the human-review loop.
export function GradingMethodologyPage() {
  return (
    <MarketingLayout
      title="How GradeThread Grades: Methodology"
      description="How the GradeThread condition-grading model is trained and evaluated, what a grade does and doesn't claim, how errors are handled, and where human review fits."
      canonicalPath="/grading/methodology"
      jsonLd={methodologyJsonLd()}
    >
      <section className="px-6 py-16 lg:py-20">
        <div className="mx-auto max-w-3xl">
          <h1 className="text-4xl font-bold tracking-tight sm:text-5xl">
            How GradeThread grades
          </h1>
          <p className="mt-6 text-lg text-foreground">
            A condition grade is only trustworthy if the method behind it is open
            to inspection. This page documents how the GradeThread model is
            trained and evaluated, exactly what a grade does and doesn't claim,
            how we handle errors, and where human judgment sits in the loop — the
            same standard we'd want from anyone grading our own items.
          </p>
        </div>
      </section>

      <section className="border-t bg-card px-6 py-16">
        <div className="mx-auto max-w-3xl">
          <h2 className="text-3xl font-bold">How the model is trained</h2>
          <p className="mt-4 text-muted-foreground">
            Every garment is scored against one fixed rubric — five weighted
            factors (Fabric Condition 30%, Structural Integrity 25%, Cosmetic
            Appearance 20%, Functional Elements 15%, Odor &amp; Cleanliness 10%)
            combined into a single 1.0–10.0 grade. The model learns from graded
            examples with expert human reviewers correcting its output, and those
            corrections — plus real post-sale outcomes — feed a continuous
            accuracy loop. See the full rubric on the{" "}
            <Link
              to="/grading-standard"
              className="font-medium text-brand-navy hover:underline dark:text-foreground"
            >
              grading standard
            </Link>
            .
          </p>
        </div>
      </section>

      <section className="px-6 py-16">
        <div className="mx-auto max-w-3xl">
          <h2 className="text-3xl font-bold">What a grade claims — and doesn't</h2>
          <div className="mt-6 grid gap-6 sm:grid-cols-2">
            <div className="rounded-lg border bg-background p-5">
              <h3 className="font-semibold">A grade is</h3>
              <ul className="mt-3 space-y-2 text-sm text-muted-foreground">
                <li>An objective assessment of physical condition</li>
                <li>Reproducible against a published rubric</li>
                <li>Independently verifiable via a certificate</li>
              </ul>
            </div>
            <div className="rounded-lg border bg-background p-5">
              <h3 className="font-semibold">A grade is not</h3>
              <ul className="mt-3 space-y-2 text-sm text-muted-foreground">
                <li>
                  An authentication —{" "}
                  <Link
                    to="/grading/vs-authentication"
                    className="font-medium text-brand-navy hover:underline dark:text-foreground"
                  >
                    condition vs. authenticity
                  </Link>
                </li>
                <li>An appraisal of monetary value</li>
                <li>A guarantee of fit or sizing</li>
              </ul>
            </div>
          </div>
        </div>
      </section>

      <section className="border-t bg-card px-6 py-16">
        <div className="mx-auto max-w-3xl">
          <h2 className="text-3xl font-bold">Error handling &amp; human review</h2>
          <p className="mt-4 text-muted-foreground">
            Every grade carries a confidence score between 0 and 1. When
            confidence falls below{" "}
            <strong>{GRADING_REVIEW_CONFIDENCE_THRESHOLD.toFixed(2)}</strong>, the
            submission is routed to a human reviewer before the grade is finalized
            — low-confidence cases never ship unchecked. Additional triggers force
            review regardless of the score: two or more contradictions found when
            the photos are re-checked against the assessment, an authenticity or
            tampering flag, or an incomplete photo set. A single contradiction
            lowers confidence rather than forcing review, which can route the
            grade anyway once it falls below the threshold. Buyers
            can dispute a grade, and reviewer corrections feed back into the
            accuracy loop. A grading prompt promoted through our admin flow cannot
            serve live traffic unless its most recent run against a golden set of
            expert-graded garments cleared fixed error and agreement thresholds,
            on the same model that will run it. That refusal is enforced in code.
            The prompt that ships inside the service is the fallback when no
            promoted version is active, and changing it is a deploy rather than a
            promotion, so it is held to the same shadow, eval and canary sequence
            by policy rather than by that automatic refusal. We publish the
            resulting platform-wide accuracy on the{" "}
            <Link
              to="/transparency"
              className="font-medium text-brand-navy hover:underline dark:text-foreground"
            >
              transparency report
            </Link>
            .
          </p>
        </div>
      </section>

      <section className="px-6 py-16">
        <div className="mx-auto max-w-2xl">
          <h2 className="text-center text-3xl font-bold">Methodology FAQ</h2>
          <dl className="mt-10 space-y-6">
            {METHODOLOGY_FAQS.map((faq) => (
              <div key={faq.q} className="border-b pb-6 last:border-b-0">
                <dt className="font-medium">{faq.q}</dt>
                <dd className="mt-2 text-sm text-muted-foreground">{faq.a}</dd>
              </div>
            ))}
          </dl>
          <div className="mt-10 text-center">
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
