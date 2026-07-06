import { Link } from "react-router-dom";
import { Download, ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  MarketingLayout,
  MarketingCTA,
} from "@/components/marketing/marketing-layout";
import { GRADE_FACTORS } from "@/lib/constants";
import {
  scaleBands,
  GRADETHREAD_SCALE_DEFINITION,
} from "@/lib/seo/grading-scale";
import {
  GRADING_SCALE_FAQS,
  gradingScaleJsonLd,
} from "@/pages/marketing/marketing-jsonld";

const BANDS = scaleBands();
const FACTORS = Object.values(GRADE_FACTORS);
const FAQS = GRADING_SCALE_FAQS;

// The free, printable one-page chart (US-1664 AC2). Generated deterministically
// by scripts/generate-scale-chart.mjs and committed to public/ (like the OG
// images), so it's served as a plain static asset and carries the GradeThread name.
const CHART_ASSET = "/gradethread-condition-grading-scale.png";

export function GradingScalePage() {
  return (
    <MarketingLayout
      title="Clothing Condition Grading Scale (1–10)"
      description="The GradeThread Scale is the canonical 1.0–10.0 standard for pre-owned clothing condition — every grade defined, plus a free printable chart."
      canonicalPath="/grading/scale"
      jsonLd={gradingScaleJsonLd()}
    >
      {/* Hero — H1 + the quotable, self-contained definition */}
      <section className="px-6 py-16 lg:py-20">
        <div className="mx-auto max-w-3xl">
          <p className="text-sm font-semibold uppercase tracking-wide text-brand-red">
            The standard
          </p>
          <h1 className="mt-3 text-4xl font-bold tracking-tight sm:text-5xl">
            The Clothing Condition Grading Scale
          </h1>
          {/* 40–60 word quotable definition directly under the H1 (snippet + AI
              citation unit). Kept byte-identical with the canonical scale data. */}
          <p className="mt-6 text-lg text-foreground">
            {GRADETHREAD_SCALE_DEFINITION}
          </p>
          <div className="mt-8 flex flex-wrap gap-3">
            <a href={CHART_ASSET} download>
              <Button
                size="lg"
                className="bg-brand-navy text-white hover:bg-brand-navy/90"
              >
                <Download className="mr-2 h-4 w-4" />
                Download the printable chart
              </Button>
            </a>
            <Link to="/signup">
              <Button size="lg" variant="outline">
                Grade an item free
                <ArrowRight className="ml-2 h-4 w-4" />
              </Button>
            </Link>
          </div>
        </div>
      </section>

      {/* The centerpiece: the grade table (US-1664 AC2) */}
      <section className="border-t px-6 py-16">
        <div className="mx-auto max-w-5xl">
          <h2 className="text-3xl font-bold">The GradeThread Scale, grade by grade</h2>
          <p className="mt-3 max-w-3xl text-muted-foreground">
            One row per grade band, from a perfect 10 down to Poor. Each label
            links to its full definition, what graders look for, and real
            examples. This is the complete, canonical scale — the same seven tiers
            a buyer reads on any GradeThread certificate.
          </p>
          <div className="mt-8 overflow-x-auto rounded-lg border">
            <table className="w-full min-w-[860px] text-sm">
              <caption className="sr-only">
                The GradeThread Clothing Condition Grading Scale: grade, label,
                criteria, typical flaws, and marketplace equivalent for each band.
              </caption>
              <thead className="bg-muted/50">
                <tr>
                  <th scope="col" className="px-4 py-3 text-left font-semibold">
                    Grade
                  </th>
                  <th scope="col" className="px-4 py-3 text-left font-semibold">
                    Label
                  </th>
                  <th scope="col" className="px-4 py-3 text-left font-semibold">
                    Criteria
                  </th>
                  <th scope="col" className="px-4 py-3 text-left font-semibold">
                    Typical flaws
                  </th>
                  <th scope="col" className="px-4 py-3 text-left font-semibold">
                    Marketplace equivalent
                  </th>
                </tr>
              </thead>
              <tbody>
                {BANDS.map((b) => (
                  <tr key={b.term} className="border-t align-top">
                    <td className="whitespace-nowrap px-4 py-4 text-lg font-bold tabular-nums text-brand-navy dark:text-foreground">
                      {b.score}
                    </td>
                    <td className="whitespace-nowrap px-4 py-4">
                      <Link
                        to={b.path}
                        className="font-medium text-brand-navy hover:underline dark:text-foreground"
                      >
                        {b.label}
                      </Link>
                    </td>
                    <td className="px-4 py-4 text-muted-foreground">{b.criteria}</td>
                    <td className="px-4 py-4 text-muted-foreground">
                      {b.typicalFlaws}
                    </td>
                    <td className="px-4 py-4 text-muted-foreground">
                      {b.marketplaceEquivalent}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-6 text-sm text-muted-foreground">
            Grades fall on a continuous 1.0–10.0 scale in half-point increments, so
            a garment can land precisely between two named tiers (an 8.5 sits
            between Excellent and NWOT). For the full rubric behind the number, see
            the{" "}
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

      {/* How the number is built — the five weighted factors */}
      <section className="border-t bg-card px-6 py-16">
        <div className="mx-auto max-w-3xl">
          <h2 className="text-3xl font-bold">How each grade is built</h2>
          <p className="mt-3 text-muted-foreground">
            The overall grade isn't a single impression — it's a weighted blend of
            five factors, fixed at 100%, so the same evidence always produces the
            same score. The result is rounded to the nearest half point and mapped
            to its named tier.
          </p>
          <div className="mt-8 overflow-x-auto rounded-lg border">
            <table className="w-full text-sm">
              <thead className="bg-muted/50">
                <tr>
                  <th scope="col" className="px-4 py-3 text-left font-semibold">
                    Factor
                  </th>
                  <th scope="col" className="px-4 py-3 text-right font-semibold">
                    Weight
                  </th>
                </tr>
              </thead>
              <tbody>
                {FACTORS.map((f) => (
                  <tr key={f.label} className="border-t">
                    <td className="px-4 py-3">{f.label}</td>
                    <td className="px-4 py-3 text-right font-medium tabular-nums">
                      {(f.weight * 100).toFixed(0)}%
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-6 text-sm text-muted-foreground">
            For a factor-by-factor walkthrough of what each one measures, see the{" "}
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

      {/* Printable chart callout (US-1664 AC2) */}
      <section className="border-t px-6 py-16">
        <div className="mx-auto flex max-w-3xl flex-col items-start gap-6 rounded-xl border bg-muted/30 p-8 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 className="text-2xl font-bold">Free printable grade chart</h2>
            <p className="mt-2 text-muted-foreground">
              A one-page reference of the full GradeThread Scale — every band with
              its criteria, typical flaws, and marketplace equivalent. Keep it at
              your sorting station or share it with buyers. Free to download and
              print.
            </p>
          </div>
          <a href={CHART_ASSET} download className="shrink-0">
            <Button
              size="lg"
              className="bg-brand-red text-white hover:bg-brand-red/90"
            >
              <Download className="mr-2 h-4 w-4" />
              Download chart
            </Button>
          </a>
        </div>
      </section>

      {/* Certificates reference the scale — the flywheel (US-1664 AC5) */}
      <section className="border-t bg-card px-6 py-16">
        <div className="mx-auto max-w-3xl">
          <h2 className="text-3xl font-bold">Every certificate points here</h2>
          <p className="mt-3 text-muted-foreground">
            When a buyer opens a GradeThread certificate and wonders "what does an
            8.5 grade mean?", the certificate links straight back to this scale.
            The scale is the definition; the certificate is the proof that a
            specific garment meets it. Grade an item and it gets a public,
            verifiable certificate that carries its grade on this exact standard.
          </p>
          <div className="mt-8">
            <Link to="/verify">
              <Button variant="outline">
                Verify a grade
                <ArrowRight className="ml-2 h-4 w-4" />
              </Button>
            </Link>
          </div>
        </div>
      </section>

      {/* FAQ — question-phrased, self-contained answers (GEO extraction) */}
      <section className="border-t px-6 py-16">
        <div className="mx-auto max-w-2xl">
          <h2 className="text-center text-3xl font-bold">
            Clothing condition scale FAQ
          </h2>
          <dl className="mt-10 space-y-6">
            {FAQS.map((faq) => (
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
