import { Link } from "react-router";
import { Button } from "@/components/ui/button";
import {
  MarketingLayout,
  MarketingCTA,
} from "@/components/marketing/marketing-layout";
import { getRouteMeta } from "@/lib/seo/public-routes";
import { GRADE_FACTORS } from "@/lib/constants";
import {
  PUBLISHED_SIZE_BUCKETS,
  PUBLISHED_SEVERITY_SCALE,
  PUBLISHED_FLAW_ROUTING,
} from "@/lib/grading-standard";
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

// US-9017: read the title and description from the registry rather than keeping
// a second copy here. They WERE a second copy, and rewriting the registry entry
// for the CTR pass left this one behind — the breadcrumb name is built from the
// title, so jsonld-parity.test.tsx went red on a mismatch between the head the
// crawler gets and the one the SPA renders. One source, no drift.
const META = getRouteMeta("/condition-grading");

export function ConditionGradingPage() {
  if (!META) throw new Error("[condition-grading] not in PUBLIC_ROUTES");
  return (
    <MarketingLayout
      title={META.title}
      description={META.description}
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
          {/* US-2107: a real <table>. Tables are the structure most often
              lifted verbatim into LLM answers and cited as a spec; the previous
              div cards carried the same data in a form nothing could quote. */}
          <div className="mt-8 overflow-x-auto rounded-lg border">
            <table className="w-full text-sm">
              <caption className="sr-only">
                GradeThread condition tiers, their score on the 1.0–10.0 scale,
                and the definition of each tier.
              </caption>
              <thead className="bg-muted/50">
                <tr>
                  <th scope="col" className="px-4 py-3 text-left font-semibold">
                    Score
                  </th>
                  <th scope="col" className="px-4 py-3 text-left font-semibold">
                    Tier
                  </th>
                  <th scope="col" className="px-4 py-3 text-left font-semibold">
                    Definition
                  </th>
                </tr>
              </thead>
              <tbody>
                {TIERS.map((tier) => (
                  <tr key={tier.name} className="border-t align-top">
                    <td className="px-4 py-3 font-bold text-brand-navy dark:text-foreground">
                      {tier.score}
                    </td>
                    <th
                      scope="row"
                      className="whitespace-nowrap px-4 py-3 text-left font-semibold"
                    >
                      {tier.name}
                    </th>
                    <td className="px-4 py-3 text-muted-foreground">{tier.def}</td>
                  </tr>
                ))}
              </tbody>
            </table>
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
            See the process end to end in{" "}
            <Link
              to="/how-it-works"
              className="font-medium text-brand-navy hover:underline dark:text-foreground"
            >
              how it works
            </Link>
            , or how sellers apply it on the{" "}
            <Link
              to="/for-resellers"
              className="font-medium text-brand-navy hover:underline dark:text-foreground"
            >
              resellers page
            </Link>
            .
          </p>
        </div>
      </section>

      {/* US-2107: the measurable half of the standard. These millimetre
          tolerances and the flaw→factor routing are not new claims written for
          this page — they are mirrored from the grading engine, which has
          carried them since US-1028, and are guarded by
          src/test/grading-standard-parity.test.ts. */}
      <section className="border-t px-6 py-16">
        <div className="mx-auto max-w-3xl">
          <h2 className="text-3xl font-bold">How a flaw is measured</h2>
          <p className="mt-3 text-muted-foreground">
            &ldquo;Small hole&rdquo; is an opinion; 3–13&nbsp;mm is not. Every
            defect is sized into a bucket with a stated physical range, so two
            graders — or two regrades — are working from the same definition.
          </p>
          <div className="mt-8 overflow-x-auto rounded-lg border">
            <table className="w-full text-sm">
              <caption className="sr-only">
                Defect size buckets and their physical ranges in millimetres.
              </caption>
              <thead className="bg-muted/50">
                <tr>
                  <th scope="col" className="px-4 py-3 text-left font-semibold">
                    Size bucket
                  </th>
                  <th scope="col" className="px-4 py-3 text-left font-semibold">
                    Physical range
                  </th>
                  <th scope="col" className="px-4 py-3 text-left font-semibold">
                    What it means
                  </th>
                </tr>
              </thead>
              <tbody>
                {PUBLISHED_SIZE_BUCKETS.map((b) => (
                  <tr key={b.bucket} className="border-t align-top">
                    <th
                      scope="row"
                      className="whitespace-nowrap px-4 py-3 text-left font-semibold capitalize"
                    >
                      {b.bucket}
                    </th>
                    <td className="whitespace-nowrap px-4 py-3">{b.range}</td>
                    <td className="px-4 py-3 text-muted-foreground">{b.note}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <h3 className="mt-12 text-2xl font-bold">
            Severity, relative to a moderate flaw
          </h3>
          <p className="mt-3 text-muted-foreground">
            Severity scales the penalty a flaw carries. Published as multiples of
            a moderate flaw so the words have a fixed meaning:
          </p>
          <div className="mt-6 overflow-x-auto rounded-lg border">
            <table className="w-full text-sm">
              <caption className="sr-only">
                Severity levels and their multiplier relative to a moderate flaw.
              </caption>
              <thead className="bg-muted/50">
                <tr>
                  <th scope="col" className="px-4 py-3 text-left font-semibold">
                    Severity
                  </th>
                  <th scope="col" className="px-4 py-3 text-left font-semibold">
                    Weight
                  </th>
                </tr>
              </thead>
              <tbody>
                {PUBLISHED_SEVERITY_SCALE.map((s) => (
                  <tr key={s.severity} className="border-t">
                    <th scope="row" className="px-4 py-3 text-left font-semibold">
                      {s.severity}
                    </th>
                    <td className="px-4 py-3">{s.relative}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <h3 className="mt-12 text-2xl font-bold">
            Which factor each flaw is charged against
          </h3>
          <p className="mt-3 text-muted-foreground">
            A flaw rarely affects one thing. A rip is mostly structural but also
            costs fabric condition; a stain is mostly cleanliness but also shows.
            This is the full routing — the shares for each flaw add up to 100%.
          </p>
          <div className="mt-6 overflow-x-auto rounded-lg border">
            <table className="w-full text-sm">
              <caption className="sr-only">
                Each defect type and the grading factors its penalty is
                distributed across, with the share going to each factor.
              </caption>
              <thead className="bg-muted/50">
                <tr>
                  <th scope="col" className="px-4 py-3 text-left font-semibold">
                    Flaw
                  </th>
                  <th scope="col" className="px-4 py-3 text-left font-semibold">
                    Factor(s) affected
                  </th>
                </tr>
              </thead>
              <tbody>
                {PUBLISHED_FLAW_ROUTING.map((r) => (
                  <tr key={r.flaw} className="border-t align-top">
                    <th
                      scope="row"
                      className="whitespace-nowrap px-4 py-3 text-left font-semibold"
                    >
                      {r.flaw}
                    </th>
                    <td className="px-4 py-3">
                      {r.routes.map(([label, share], i) => (
                        <span key={label}>
                          {i > 0 && <span className="text-muted-foreground"> · </span>}
                          {label}{" "}
                          <span className="text-muted-foreground">
                            {Math.round(share * 100)}%
                          </span>
                        </span>
                      ))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-6 text-sm text-muted-foreground">
            Flaws judged to be intentional design — factory distressing, raw
            hems, acid wash — are not charged against any factor. See{" "}
            <Link
              to="/design-vs-damage"
              className="font-medium text-brand-navy hover:underline dark:text-foreground"
            >
              intentional design vs. damage
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
                className="rounded-full border px-4 py-2 text-sm font-medium text-brand-navy transition-colors hover:bg-brand-navy hover:text-white dark:text-foreground"
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
                className="rounded-full border px-4 py-2 text-sm font-medium text-brand-navy transition-colors hover:bg-brand-navy hover:text-white dark:text-foreground"
              >
                {e.term}
              </Link>
            ))}
          </div>
        </div>
      </section>

      {/* Cornerstone deep-dive guides (US-855) */}
      <section className="px-6 py-16">
        <div className="mx-auto max-w-3xl">
          <h2 className="text-3xl font-bold">Go deeper</h2>
          <p className="mt-3 text-muted-foreground">
            Cornerstone guides that put the standard to work:
          </p>
          <ul className="mt-6 space-y-3">
            {[
              {
                to: "/reseller-grading-guide",
                label: "A reseller's guide to condition grading",
                blurb: "What to grade, how to shoot it, and how to sell on it.",
              },
              {
                to: "/reduce-returns",
                label: "Reduce returns with condition proof",
                blurb: "Close the not-as-described gap before the buyer pays.",
              },
              {
                to: "/resale-value-by-condition",
                label: "Resale value by condition grade",
                blurb: "How value moves with the grade, from real comps.",
              },
              {
                to: "/design-vs-damage",
                label: "Intentional design vs. damage",
                blurb: "Tell factory distressing apart from real wear.",
              },
              {
                to: "/grading-by-category",
                label: "Condition grading by category",
                blurb: "Denim, knits, leather, shoes, and vintage.",
              },
            ].map((g) => (
              <li key={g.to} className="rounded-lg border bg-background p-4">
                <Link
                  to={g.to}
                  className="font-medium text-brand-navy hover:underline dark:text-foreground"
                >
                  {g.label}
                </Link>
                <p className="mt-1 text-sm text-muted-foreground">{g.blurb}</p>
              </li>
            ))}
          </ul>
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
