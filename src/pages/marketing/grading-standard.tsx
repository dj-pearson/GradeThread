import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import {
  MarketingLayout,
  MarketingCTA,
} from "@/components/marketing/marketing-layout";
import { GRADE_FACTORS } from "@/lib/constants";
import {
  GRADING_STANDARD_FAQS,
  gradingStandardJsonLd,
} from "@/pages/marketing/marketing-jsonld";

const FACTORS = Object.values(GRADE_FACTORS);

// What makes the standard a *standard* — the properties an authority publishes.
const PRINCIPLES = [
  {
    title: "One published rubric",
    body: "Every garment is scored against the same five factors with the same fixed weights — disclosed up front, not hidden in a black box.",
  },
  {
    title: "Objective and reproducible",
    body: "Because the factors and weights are fixed, two items in the same condition earn the same grade, regardless of who submits them or when.",
  },
  {
    title: "Confidence-checked",
    body: "Each grade carries a confidence score. Low-confidence submissions are routed for human review before the grade is finalized.",
  },
  {
    title: "Independently verifiable",
    body: "Every grade produces a public certificate buyers can open and check against the standard — the score, the tiers, and the photos behind it.",
  },
];

const FAQS = GRADING_STANDARD_FAQS;

export function GradingStandardPage() {
  return (
    <MarketingLayout
      title="The GradeThread Grading Standard"
      description="The objective methodology behind every GradeThread condition grade: a published 1.0–10.0 rubric, five weighted factors, half-point precision, confidence scoring, and human review."
      canonicalPath="/grading-standard"
      jsonLd={gradingStandardJsonLd()}
    >
      <section className="px-6 py-16 lg:py-20">
        <div className="mx-auto max-w-3xl">
          <h1 className="text-4xl font-bold tracking-tight sm:text-5xl">
            The GradeThread grading standard
          </h1>
          <p className="mt-6 text-lg text-muted-foreground">
            A standard is only a standard if it's objective, published, and
            reproducible. GradeThread grades every pre-owned garment against one
            fixed rubric — five weighted factors combined into a single 1.0–10.0
            score mapped to seven named tiers — so a grade means the same thing
            no matter who is selling. This page documents that methodology in
            full: how the score is built, how we keep it consistent, and how
            anyone can verify it.
          </p>
        </div>
      </section>

      {/* What makes it a standard */}
      <section className="border-t bg-card px-6 py-16">
        <div className="mx-auto max-w-3xl">
          <h2 className="text-3xl font-bold">What makes it a standard</h2>
          <div className="mt-8 grid gap-6 sm:grid-cols-2">
            {PRINCIPLES.map((p) => (
              <div key={p.title} className="rounded-lg border bg-background p-5">
                <h3 className="font-semibold text-brand-navy dark:text-foreground">{p.title}</h3>
                <p className="mt-2 text-sm text-muted-foreground">{p.body}</p>
              </div>
            ))}
          </div>
        </div>
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
