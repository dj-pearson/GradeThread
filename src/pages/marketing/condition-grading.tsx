import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import {
  MarketingLayout,
  MarketingCTA,
} from "@/components/marketing/marketing-layout";
import { GRADE_FACTORS } from "@/lib/constants";
import { GLOSSARY_ENTRIES } from "@/lib/seo/glossary";
import {
  CONDITION_GRADING_FAQS,
  conditionGradingJsonLd,
} from "@/pages/marketing/marketing-jsonld";

// The 7 condition tiers, newest→worst, with the score they anchor and a
// concise definition. This is the pillar content the glossary hub (US-303)
// will later expand into one page per tier.
const TIERS = [
  {
    name: "NWT — New With Tags",
    score: "10",
    def: "Brand new, unworn, with original tags still attached. Indistinguishable from retail.",
  },
  {
    name: "NWOT — New Without Tags",
    score: "9",
    def: "New and unworn but the tags have been removed. No signs of wear or laundering.",
  },
  {
    name: "Excellent",
    score: "8",
    def: "Gently used with no notable flaws. May have been worn or washed a few times but looks nearly new.",
  },
  {
    name: "Very Good",
    score: "7",
    def: "Light, normal wear. Minor signs of use that don't affect the overall look or function.",
  },
  {
    name: "Good",
    score: "6",
    def: "Visible but minor wear — slight pilling, faint marks, or small cosmetic issues. Still very wearable.",
  },
  {
    name: "Fair",
    score: "5",
    def: "Noticeable wear or a documented flaw such as a stain, hole, or fading that affects appearance.",
  },
  {
    name: "Poor",
    score: "3–4",
    def: "Significant damage or heavy wear. Often sold for parts, repair, or distressed styling.",
  },
];

const FACTORS = Object.values(GRADE_FACTORS);

const FAQS = CONDITION_GRADING_FAQS;

// Hub-and-spoke: the pillar links to every glossary spoke (US-303).
const TIER_GLOSSARY = GLOSSARY_ENTRIES.filter((e) => e.kind === "tier");
const FACTOR_GLOSSARY = GLOSSARY_ENTRIES.filter((e) => e.kind === "factor");

export function ConditionGradingPage() {
  return (
    <MarketingLayout
      title="What Is Clothing Condition Grading?"
      description="A complete guide to pre-owned clothing condition grading: the 1.0–10.0 scale, the 7 tiers (NWT to Poor), and the 5 weighted factors graders assess."
      canonicalPath="/condition-grading"
      jsonLd={conditionGradingJsonLd()}
    >
      <section className="px-6 py-16 lg:py-20">
        <div className="mx-auto max-w-3xl">
          <h1 className="text-4xl font-bold tracking-tight sm:text-5xl">
            What is clothing condition grading?
          </h1>
          <p className="mt-6 text-lg text-muted-foreground">
            Clothing condition grading is the practice of assigning a
            standardized score to a pre-owned garment based on its wear, damage,
            and overall state. GradeThread uses a 1.0–10.0 scale mapped to seven
            named tiers — from NWT (New With Tags) down to Poor — and derives the
            score from five weighted factors. The result is an objective,
            comparable measure of condition, so buyers and sellers share the same
            definition of "Excellent" instead of guessing from photos.
          </p>
        </div>
      </section>

      {/* The scale / tiers */}
      <section className="border-t bg-card px-6 py-16">
        <div className="mx-auto max-w-3xl">
          <h2 className="text-3xl font-bold">The 1.0–10.0 scale and its tiers</h2>
          <p className="mt-3 text-muted-foreground">
            Each tier anchors a point on the scale. Half-point increments let
            graders place an item precisely between tiers.
          </p>
          <div className="mt-8 space-y-4">
            {TIERS.map((tier) => (
              <div
                key={tier.name}
                className="flex gap-4 rounded-lg border bg-background p-4"
              >
                <div className="flex h-12 w-12 flex-shrink-0 items-center justify-center rounded-full bg-brand-navy font-bold text-white">
                  {tier.score}
                </div>
                <div>
                  <h3 className="font-semibold">{tier.name}</h3>
                  <p className="mt-1 text-sm text-muted-foreground">
                    {tier.def}
                  </p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* The 5 factors */}
      <section className="px-6 py-16">
        <div className="mx-auto max-w-3xl">
          <h2 className="text-3xl font-bold">The five grading factors</h2>
          <p className="mt-3 text-muted-foreground">
            Rather than a single subjective impression, the overall grade is a
            weighted combination of five factors:
          </p>
          <div className="mt-8 overflow-hidden rounded-lg border">
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
            See the process end to end in{" "}
            <Link
              to="/how-it-works"
              className="font-medium text-brand-navy hover:underline"
            >
              how it works
            </Link>
            , or how sellers apply it on the{" "}
            <Link
              to="/for-resellers"
              className="font-medium text-brand-navy hover:underline"
            >
              resellers page
            </Link>
            .
          </p>
        </div>
      </section>

      {/* Glossary hub — links to every tier + factor page (US-303) */}
      <section className="border-t bg-card px-6 py-16">
        <div className="mx-auto max-w-3xl">
          <h2 className="text-3xl font-bold">Condition grading glossary</h2>
          <p className="mt-3 text-muted-foreground">
            A definitive page for every grade tier and grading factor — what each
            term means, what graders look for, and examples.
          </p>

          <h3 className="mt-8 text-lg font-semibold">Grade tiers</h3>
          <div className="mt-3 flex flex-wrap gap-3">
            {TIER_GLOSSARY.map((e) => (
              <Link
                key={e.slug}
                to={e.path}
                className="rounded-full border px-4 py-2 text-sm font-medium text-brand-navy transition-colors hover:bg-brand-navy hover:text-white"
              >
                {e.term}
              </Link>
            ))}
          </div>

          <h3 className="mt-8 text-lg font-semibold">Grading factors</h3>
          <div className="mt-3 flex flex-wrap gap-3">
            {FACTOR_GLOSSARY.map((e) => (
              <Link
                key={e.slug}
                to={e.path}
                className="rounded-full border px-4 py-2 text-sm font-medium text-brand-navy transition-colors hover:bg-brand-navy hover:text-white"
              >
                {e.term}
              </Link>
            ))}
          </div>
        </div>
      </section>

      {/* FAQ */}
      <section className="border-t px-6 py-16">
        <div className="mx-auto max-w-2xl">
          <h2 className="text-center text-3xl font-bold">
            Condition grading FAQ
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
