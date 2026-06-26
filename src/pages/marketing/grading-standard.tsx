import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import {
  MarketingLayout,
  MarketingCTA,
} from "@/components/marketing/marketing-layout";
import { GRADE_FACTORS } from "@/lib/constants";
import { StandardJustifications } from "@/components/marketing/standard-justifications";
import {
  GRADING_STANDARD_FAQS,
  gradingStandardJsonLd,
} from "@/pages/marketing/marketing-jsonld";

const FACTORS = Object.values(GRADE_FACTORS);

const FAQS = GRADING_STANDARD_FAQS;

export function GradingStandardPage() {
  return (
    <MarketingLayout
      title="The GradeThread Grading Standard"
      description="The published, objective methodology behind every grade: a fixed 1.0–10.0 rubric of five weighted factors — reproducible and independently verifiable."
      canonicalPath="/grading-standard"
      jsonLd={gradingStandardJsonLd()}
    >
      <section className="px-6 py-16 lg:py-20">
        <div className="mx-auto max-w-3xl">
          <h1 className="text-4xl font-bold tracking-tight sm:text-5xl">
            The GradeThread grading standard
          </h1>
          <p className="mt-6 text-lg text-muted-foreground">
            A standard is only a standard if it's objective, published,
            reproducible, and independently verifiable. GradeThread grades every
            pre-owned garment against one fixed rubric — five weighted factors
            combined into a single 1.0–10.0 score mapped to seven named tiers —
            so a grade means the same thing no matter who is selling. This page
            documents that methodology in full: how the score is built, how we
            keep it consistent, and how anyone can verify it.
          </p>
        </div>
      </section>

      {/* What makes it a standard — the four justifications (US-1297) */}
      <section className="border-t px-6 py-16">
        <StandardJustifications
          heading="What makes it a standard"
          methodologyLink={false}
        />
      </section>

      {/* The five weighted factors */}
      <section className="px-6 py-16">
        <div className="mx-auto max-w-3xl">
          <h2 className="text-3xl font-bold">The five weighted factors</h2>
          <p className="mt-3 text-muted-foreground">
            The overall grade is not a single impression — it's a weighted blend
            of five factors. The weights are fixed and add up to 100%, so the
            same evidence always produces the same score.
          </p>
          <div className="mt-8 overflow-x-auto rounded-lg border">
            <table className="w-full text-sm">
              <thead className="bg-muted/50">
                <tr>
                  <th className="px-4 py-3 text-left font-semibold">Factor</th>
                  <th className="px-4 py-3 text-right font-semibold">Weight</th>
                </tr>
              </thead>
              <tbody>
                {FACTORS.map((f) => (
                  <tr key={f.label} className="border-t">
                    <td className="px-4 py-3">{f.label}</td>
                    <td className="px-4 py-3 text-right font-medium">
                      {(f.weight * 100).toFixed(0)}%
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-6 text-sm text-muted-foreground">
            For what each factor and tier means in detail, see the{" "}
            <Link
              to="/condition-grading"
              className="font-medium text-brand-navy hover:underline dark:text-foreground"
            >
              condition grading guide
            </Link>
            .
          </p>
        </div>
      </section>

      {/* How the score is computed */}
      <section className="border-t bg-card px-6 py-16">
        <div className="mx-auto max-w-3xl">
          <h2 className="text-3xl font-bold">How the score is computed</h2>
          <ol className="mt-8 space-y-6">
            <li className="flex gap-4">
              <span className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-brand-navy text-sm font-bold text-white">
                1
              </span>
              <p className="text-muted-foreground">
                <span className="font-medium text-foreground">
                  Assess each factor.
                </span>{" "}
                AI vision inspects the garment photos and scores all five
                factors independently against the rubric.
              </p>
            </li>
            <li className="flex gap-4">
              <span className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-brand-navy text-sm font-bold text-white">
                2
              </span>
              <p className="text-muted-foreground">
                <span className="font-medium text-foreground">
                  Apply the weights.
                </span>{" "}
                Each factor score is multiplied by its fixed weight and summed
                into a single 1.0–10.0 grade, resolved to the nearest half
                point.
              </p>
            </li>
            <li className="flex gap-4">
              <span className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-brand-navy text-sm font-bold text-white">
                3
              </span>
              <p className="text-muted-foreground">
                <span className="font-medium text-foreground">
                  Map to a tier.
                </span>{" "}
                The numeric grade anchors a named tier — from NWT (10) down to
                Poor — so the result reads the same to every buyer and seller.
              </p>
            </li>
            <li className="flex gap-4">
              <span className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-brand-navy text-sm font-bold text-white">
                4
              </span>
              <p className="text-muted-foreground">
                <span className="font-medium text-foreground">
                  Check confidence.
                </span>{" "}
                A confidence score accompanies the grade; anything below
                threshold is routed for human review before it's finalized and
                certified.
              </p>
            </li>
          </ol>
        </div>
      </section>

      {/* FAQ */}
      <section className="border-t px-6 py-16">
        <div className="mx-auto max-w-2xl">
          <h2 className="text-center text-3xl font-bold">
            Grading standard FAQ
          </h2>
          <dl className="mt-10 space-y-6">
            {FAQS.map((faq) => (
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
