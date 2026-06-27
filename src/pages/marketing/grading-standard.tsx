import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import {
  MarketingLayout,
  MarketingCTA,
} from "@/components/marketing/marketing-layout";
import { GRADE_FACTORS } from "@/lib/constants";
import { tierSummaries } from "@/lib/seo/glossary";
import { StandardJustifications } from "@/components/marketing/standard-justifications";
import {
  GRADING_STANDARD_FAQS,
  gradingStandardJsonLd,
} from "@/pages/marketing/marketing-jsonld";
import {
  GRADE_FIELD_NAME,
  GRADE_FIELD_PROPERTY_ID,
  GRADE_ITEM_SPECIFIC,
  GRADE_STANDARD_SCHEMA_URL,
  GRADE_STANDARD_VERSION,
} from "@/lib/grade-standard";

const FACTORS = Object.values(GRADE_FACTORS);
const TIERS = tierSummaries();

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
            Pre-owned clothing has never had a single, objective condition
            standard — &ldquo;Excellent&rdquo; means one thing to one seller and
            something else to the next. GradeThread&rsquo;s 1.0&ndash;10.0 scale
            is that standard. A standard is only a standard if it&rsquo;s
            objective, published, reproducible, and independently verifiable, so
            GradeThread grades every pre-owned garment against one fixed rubric —
            five weighted factors combined into a single 1.0&ndash;10.0 score
            mapped to seven named tiers — and a grade means the same thing no
            matter who is selling. This page documents that methodology in full:
            how the score is built, how we keep it consistent, and how anyone can
            verify it.
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

      {/* The full named scale — every tier on the standard page itself */}
      <section className="border-t px-6 py-16">
        <div className="mx-auto max-w-3xl">
          <h2 className="text-3xl font-bold">The scale: ten to one</h2>
          <p className="mt-3 text-muted-foreground">
            Every grade resolves to a named tier so the number always carries the
            same meaning. This is the complete GradeThread condition scale — the
            same seven tiers a buyer reads on any certificate.
          </p>
          <div className="mt-8 overflow-x-auto rounded-lg border">
            <table className="w-full text-sm">
              <thead className="bg-muted/50">
                <tr>
                  <th className="px-4 py-3 text-left font-semibold">Grade</th>
                  <th className="px-4 py-3 text-left font-semibold">Tier</th>
                  <th className="px-4 py-3 text-left font-semibold">What it means</th>
                </tr>
              </thead>
              <tbody>
                {TIERS.map((t) => (
                  <tr key={t.term} className="border-t align-top">
                    <td className="whitespace-nowrap px-4 py-3 font-semibold tabular-nums">
                      {t.score}
                    </td>
                    <td className="whitespace-nowrap px-4 py-3">
                      <Link
                        to={t.path}
                        className="font-medium text-brand-navy hover:underline dark:text-foreground"
                      >
                        {t.label}
                      </Link>
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">{t.summary}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
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

      {/* Open spec — the machine-readable GradeThread Grade field (US-1284) */}
      <section
        id="grade-field-spec"
        className="border-t bg-card px-6 py-16 scroll-mt-24"
      >
        <div className="mx-auto max-w-3xl">
          <span className="inline-flex items-center rounded-full bg-brand-navy/10 px-3 py-1 text-xs font-semibold text-brand-navy dark:bg-foreground/10 dark:text-foreground">
            Open spec · v{GRADE_STANDARD_VERSION}
          </span>
          <h2 className="mt-4 text-3xl font-bold">
            The {GRADE_FIELD_NAME} field — an open standard
          </h2>
          <p className="mt-3 text-muted-foreground">
            A grade is only useful if it travels. The{" "}
            <span className="font-medium text-foreground">{GRADE_FIELD_NAME}</span>{" "}
            is a published, versioned, machine-readable field anyone can embed in
            a listing — so a pre-owned garment can carry "{GRADE_FIELD_NAME} 8.0"
            the way a trading card carries a third-party grade. This is an{" "}
            <span className="font-medium text-foreground">open specification</span>
            : free to read and implement, with no proprietary lock-in. We publish
            the standard; we don't claim anyone else has adopted it.
          </p>

          <h3 className="mt-10 text-xl font-semibold">The field</h3>
          <p className="mt-2 text-muted-foreground">
            The grade is expressed as a{" "}
            <a
              href="https://schema.org/PropertyValue"
              className="font-medium text-brand-navy hover:underline dark:text-foreground"
              rel="noopener noreferrer"
              target="_blank"
            >
              schema.org <code>PropertyValue</code>
            </a>{" "}
            (an <code>additionalProperty</code> on the item), with a stable{" "}
            <code>propertyID</code> of{" "}
            <code className="break-all">{GRADE_FIELD_PROPERTY_ID}</code>:
          </p>
          <pre className="mt-4 overflow-x-auto rounded-lg border bg-background p-4 text-xs leading-relaxed">
            <code>{`{
  "@type": "PropertyValue",
  "propertyID": "${GRADE_FIELD_PROPERTY_ID}",
  "name": "${GRADE_FIELD_NAME}",
  "value": 8.0,            // 1.0–10.0, half-point increments
  "minValue": 1,
  "maxValue": 10,
  "alternateName": "Excellent",   // the named tier
  "url": "https://gradethread.com/cert/<id>"   // verifiable certificate
}`}</code>
          </pre>
          <p className="mt-4 text-muted-foreground">
            The full field shape is documented by a stable, citable JSON Schema:{" "}
            <a
              href={GRADE_STANDARD_SCHEMA_URL}
              className="font-medium text-brand-navy hover:underline dark:text-foreground"
              rel="noopener noreferrer"
              target="_blank"
            >
              grade-standard.schema.json
            </a>
            . The spec and schema are published under a CC BY 4.0 license.
          </p>

          <h3 className="mt-10 text-xl font-semibold">
            How it's embedded everywhere
          </h3>
          <p className="mt-2 text-muted-foreground">
            Every listing GradeThread publishes carries the field in a consistent
            way, adapted to each marketplace's rules:
          </p>
          <div className="mt-6 overflow-x-auto rounded-lg border">
            <table className="w-full text-sm">
              <thead className="bg-muted/50">
                <tr>
                  <th className="px-4 py-3 text-left font-semibold">Surface</th>
                  <th className="px-4 py-3 text-left font-semibold">
                    How the grade is carried
                  </th>
                </tr>
              </thead>
              <tbody>
                <tr className="border-t">
                  <td className="px-4 py-3 font-medium">eBay</td>
                  <td className="px-4 py-3 text-muted-foreground">
                    A "{GRADE_ITEM_SPECIFIC}" item specific plus the certificate
                    number in the description (eBay disallows off-site links, so
                    no URL).
                  </td>
                </tr>
                <tr className="border-t">
                  <td className="px-4 py-3 font-medium">Shopify · Depop</td>
                  <td className="px-4 py-3 text-muted-foreground">
                    A grade line plus a machine-readable{" "}
                    <code>[gradethread-grade]…[/gradethread-grade]</code> marker
                    and the certificate verify link in the description.
                  </td>
                </tr>
                <tr className="border-t">
                  <td className="px-4 py-3 font-medium">Certificate page</td>
                  <td className="px-4 py-3 text-muted-foreground">
                    The grade is emitted as schema.org structured data on the
                    public <code>/cert/&lt;id&gt;</code> page for any crawler or
                    AI engine to ingest.
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
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
