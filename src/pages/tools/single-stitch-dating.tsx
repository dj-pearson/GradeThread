import { useMemo, useState } from "react";
import { Link } from "react-router";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { MarketingLayout, MarketingCTA } from "@/components/marketing/marketing-layout";
import { CalculatorHandoff } from "@/components/marketing/calculator-funnel";
import { useCalculatorFunnel } from "@/lib/calculator-funnel";
import {
  dateVintageTee,
  isPlausiblePrintedYear,
  type Answer,
  type DatingInput,
} from "@/lib/single-stitch-dating";
import {
  getCalculatorBySlug,
  calculatorContent,
  calculatorPath,
} from "@/lib/seo/calculators";
import {
  calculatorJsonLd,
  calculatorBreadcrumbLdItems,
} from "@/pages/marketing/marketing-jsonld";

// US-9020. "Single stitch shirt" and its variants are 8,850 searches a month
// and GradeThread had nothing on it. The obvious page repeats "single stitch
// means pre-1994" and stops; this one combines the tells and reports when they
// disagree, because a conflicting garment is the finding that saves a buyer
// money and every competing page misses it.
//
// Everything is client-side, so the explanation, the tells and the FAQ
// prerender as static HTML and the page answers the query with script disabled.

const CALC = getCalculatorBySlug("single-stitch-dating");

const ANSWERS: { value: Answer; label: string }[] = [
  { value: "unsure", label: "Not sure" },
  { value: "yes", label: "Yes" },
  { value: "no", label: "No" },
];

const TELLS: { key: keyof Omit<DatingInput, "printedYear">; label: string; hint: string }[] = [
  {
    key: "singleStitch",
    label: "Single stitching at the hem and sleeves",
    hint: "One line of stitching where the fabric folds under, rather than two parallel lines.",
  },
  {
    key: "taglessLabel",
    label: "Tagless neck label",
    hint: "The brand is printed straight onto the fabric instead of sewn in on a separate tag.",
  },
  {
    key: "madeInUsa",
    label: "Made in USA on the tag",
    hint: "Only counts if the tag says it. A cut tag is a no answer, not a yes.",
  },
  {
    key: "blendedFabric",
    label: "Poly-cotton blend on the tag",
    hint: "50/50, 60/40 or similar, rather than 100% cotton.",
  },
];

const CONFIDENCE_TONE: Record<string, string> = {
  conflicting: "text-brand-red-text",
  narrow: "text-emerald-600 dark:text-emerald-400",
  indicative: "text-amber-600 dark:text-amber-400",
  insufficient: "text-muted-foreground",
};

export function SingleStitchDatingPage() {
  const [answers, setAnswers] = useState<Omit<DatingInput, "printedYear">>({
    singleStitch: "unsure",
    taglessLabel: "unsure",
    madeInUsa: "unsure",
    blendedFabric: "unsure",
  });
  const [yearRaw, setYearRaw] = useState("");

  const result = useMemo(() => {
    const parsed = Number(yearRaw);
    const printedYear =
      yearRaw.trim() !== "" && isPlausiblePrintedYear(parsed) ? parsed : null;
    return dateVintageTee({ ...answers, printedYear });
  }, [answers, yearRaw]);

  useCalculatorFunnel(CALC?.slug ?? "", `${JSON.stringify(answers)}|${yearRaw}`);

  if (!CALC) throw new Error("[single-stitch-dating] not in the calculator registry");
  const { intro, faqs } = calculatorContent(CALC);

  return (
    <MarketingLayout
      title={CALC.title}
      description={CALC.description}
      canonicalPath={calculatorPath(CALC.slug)}
      breadcrumbs={calculatorBreadcrumbLdItems(CALC)}
      jsonLd={calculatorJsonLd(CALC)}
    >
      <section className="px-6 py-16 lg:py-20">
        <div className="mx-auto max-w-3xl">
          <h1 className="text-4xl font-bold tracking-tight sm:text-5xl">{CALC.h1}</h1>
          <p className="mt-6 text-lg text-foreground">{intro}</p>
        </div>
      </section>

      <section className="border-t bg-card px-6 py-12">
        <div className="mx-auto max-w-3xl">
          <h2 className="text-2xl font-bold">Check the tells</h2>
          <p className="mt-3 text-muted-foreground">
            Answer what you can see and leave the rest. Not sure is a real answer here
            and it is treated as one.
          </p>

          <div className="mt-6">
            <Label htmlFor="ss-year">Copyright or event year printed on the graphic</Label>
            <Input
              id="ss-year"
              inputMode="numeric"
              value={yearRaw}
              onChange={(e) => setYearRaw(e.target.value)}
              placeholder="1991"
              className="mt-1 max-w-40"
            />
            <p className="mt-2 text-sm text-muted-foreground">
              Usually along the bottom edge of the print or under the artwork. This is
              the tell worth hunting for, because it is the only one that cannot be
              older than it says.
            </p>
          </div>

          <div className="mt-8 grid gap-5">
            {TELLS.map((t) => (
              <fieldset key={t.key}>
                <legend className="text-sm font-medium">{t.label}</legend>
                <p className="mt-1 text-sm text-muted-foreground">{t.hint}</p>
                <div className="mt-2 flex flex-wrap gap-2">
                  {ANSWERS.map((a) => {
                    const selected = answers[t.key] === a.value;
                    return (
                      <button
                        key={a.value}
                        type="button"
                        aria-pressed={selected}
                        onClick={() => setAnswers((prev) => ({ ...prev, [t.key]: a.value }))}
                        className={
                          "rounded-md border px-3 py-1.5 text-sm transition-colors " +
                          (selected
                            ? "border-primary bg-primary text-primary-foreground"
                            : "bg-background hover:bg-muted")
                        }
                      >
                        {a.label}
                      </button>
                    );
                  })}
                </div>
              </fieldset>
            ))}
          </div>

          <div className="mt-8 rounded-xl border p-5">
            <p className={"text-lg font-semibold " + (CONFIDENCE_TONE[result.confidence] ?? "")}>
              {result.headline}
            </p>
            {result.signals.length > 0 ? (
              <ul className="mt-5 grid gap-4">
                {result.signals.map((s) => (
                  <li key={s.label}>
                    <p className="text-sm font-semibold">
                      {s.label}
                      <span className="ml-2 rounded bg-muted px-1.5 py-0.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                        {s.kind}
                      </span>
                    </p>
                    <p className="mt-1 text-sm text-muted-foreground">{s.detail}</p>
                  </li>
                ))}
              </ul>
            ) : null}
            <p className="mt-5 text-sm text-muted-foreground">
              This is a read of the tells you entered, not an appraisal or an
              authentication. Nothing you type is sent anywhere.
            </p>
          </div>
        </div>
      </section>

      <section className="border-t px-6 py-12">
        <div className="mx-auto max-w-3xl">
          <h2 className="text-2xl font-bold">What single stitch does not prove</h2>
          <p className="mt-3 text-muted-foreground">
            The phrase carries a premium on resale sites, which is exactly why it is
            worth being careful with. Four things it is not.
          </p>
          <dl className="mt-6 grid gap-5">
            <div className="rounded-xl border p-5">
              <dt className="font-semibold">It is not a date</dt>
              <dd className="mt-2 text-sm text-muted-foreground">
                Single-needle hems were standard on US-made blanks through the 1980s
                and disappeared through the middle 1990s, one manufacturer at a time
                rather than on a date. Any page giving you a single year is more
                confident than the evidence is.
              </dd>
            </div>
            <div className="rounded-xl border p-5">
              <dt className="font-semibold">It is not hard to reproduce</dt>
              <dd className="mt-2 text-sm text-muted-foreground">
                It is one line of stitching. Reproduction blanks made to read as
                vintage use it, and so do small modern runs. On its own it is the
                easiest tell on the garment to fake.
              </dd>
            </div>
            <div className="rounded-xl border p-5">
              <dt className="font-semibold">It is not a condition grade</dt>
              <dd className="mt-2 text-sm text-muted-foreground">
                Age and condition are separate questions and the second one is what
                buyers pay for. A 1988 tee with a cracked print, thin shoulders and
                pinholes is an old shirt in poor condition.{" "}
                <Link to="/condition-grading" className="font-medium text-primary hover:underline">
                  How condition grading works
                </Link>
                .
              </dd>
            </div>
            <div className="rounded-xl border p-5">
              <dt className="font-semibold">It is not authentication</dt>
              <dd className="mt-2 text-sm text-muted-foreground">
                Dating the blank says nothing about whether the print is a licensed
                original or a later bootleg on period stock. Those are different
                questions and the second one moves the price more.{" "}
                <Link to="/tools/authenticity-check" className="font-medium text-primary hover:underline">
                  Run an authenticity check
                </Link>
                .
              </dd>
            </div>
          </dl>
        </div>
      </section>

      <section className="border-t bg-card px-6 py-12">
        <div className="mx-auto max-w-3xl">
          <h2 className="text-2xl font-bold">Common questions</h2>
          <dl className="mt-6 grid gap-5">
            {faqs.map((f) => (
              <div key={f.q} className="rounded-xl border p-5">
                <dt className="font-semibold">{f.q}</dt>
                <dd className="mt-2 text-sm text-muted-foreground">{f.a}</dd>
              </div>
            ))}
          </dl>
          <p className="mt-8 text-sm text-muted-foreground">
            Once you know what it is, find what it sells for with the{" "}
            <Link to="/tools/ebay-sold-listings" className="font-medium text-primary hover:underline">
              eBay sold listings search
            </Link>
            .
          </p>
        </div>
      </section>

      <CalculatorHandoff calc={CALC} />

      <MarketingCTA
        heading="Age is half the listing"
        sub="A buyer looking at a thirty-year-old tee wants to know what the last thirty years did to it. A GradeThread grade answers that on the listing, with a certificate they can check."
      />
    </MarketingLayout>
  );
}
