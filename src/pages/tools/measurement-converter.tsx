import { useMemo, useState } from "react";
import { Link } from "react-router";
import { ArrowRight } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { MarketingLayout, MarketingCTA } from "@/components/marketing/marketing-layout";
import {
  MEASUREMENT_HOWTO,
  MENS_TOP_SIZES,
  MENS_TO_WOMENS_TOP,
  MENS_TO_WOMENS_TOP_CAVEAT,
  SHOE_SIZES,
  SIZE_TABLE_CAVEAT,
  WOMENS_SIZES,
  convertLength,
  flatToWorn,
} from "@/lib/size-conversion";
import { isCircumferenceMeasurement } from "@/lib/measurements";
import { getCalculatorBySlug, calculatorContent, calculatorPath } from "@/lib/seo/calculators";
import { calculatorJsonLd, calculatorBreadcrumbLdItems } from "@/pages/marketing/marketing-jsonld";

// US-9007. The converter itself is deterministic and runs entirely in the
// browser — nothing is sent anywhere, so an anonymous visitor leaves no trace.
// All interactive state lives inside the component so the explanatory copy and
// every table prerender as static HTML: the page is useful to a reader and to a
// crawler before a single byte of script arrives.

const CALC = getCalculatorBySlug("measurement-converter");

function useConverter() {
  const [raw, setRaw] = useState("21");
  const [unit, setUnit] = useState<"in" | "cm">("in");
  const [key, setKey] = useState("chest");

  const result = useMemo(() => {
    const value = Number(raw);
    if (!Number.isFinite(value) || value <= 0) return null;
    const other = unit === "in" ? "cm" : "in";
    return {
      converted: convertLength(value, unit, other),
      otherUnit: other,
      worn: flatToWorn(key, value),
      wornOther: flatToWorn(key, convertLength(value, unit, other)),
      doubles: isCircumferenceMeasurement(key),
    };
  }, [raw, unit, key]);

  return { raw, setRaw, unit, setUnit, key, setKey, result };
}

export function MeasurementConverterPage() {
  const { raw, setRaw, unit, setUnit, key, setKey, result } = useConverter();

  if (!CALC) throw new Error("[measurement-converter] not in the calculator registry");
  const { intro, faqs } = calculatorContent(CALC);
  const selected = MEASUREMENT_HOWTO.find((m) => m.key === key);

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
          <h2 className="text-2xl font-bold">Convert a measurement</h2>
          <div className="mt-6 grid gap-4 sm:grid-cols-3">
            <div>
              <Label htmlFor="mc-value">Measurement</Label>
              <Input
                id="mc-value"
                inputMode="decimal"
                value={raw}
                onChange={(e) => setRaw(e.target.value)}
                className="mt-1"
              />
            </div>
            <div>
              <Label htmlFor="mc-unit">Unit</Label>
              <select
                id="mc-unit"
                value={unit}
                onChange={(e) => setUnit(e.target.value === "cm" ? "cm" : "in")}
                className="mt-1 h-9 w-full rounded-md border bg-background px-3 text-sm"
              >
                <option value="in">Inches</option>
                <option value="cm">Centimetres</option>
              </select>
            </div>
            <div>
              <Label htmlFor="mc-key">Taken as</Label>
              <select
                id="mc-key"
                value={key}
                onChange={(e) => setKey(e.target.value)}
                className="mt-1 h-9 w-full rounded-md border bg-background px-3 text-sm"
              >
                {MEASUREMENT_HOWTO.map((m) => (
                  <option key={m.key} value={m.key}>
                    {m.label}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {result ? (
            <div className="mt-6 rounded-xl border p-5">
              <p className="text-lg">
                <span className="font-semibold">
                  {raw} {unit === "in" ? "in" : "cm"}
                </span>{" "}
                is{" "}
                <span className="font-semibold">
                  {result.converted} {result.otherUnit === "in" ? "in" : "cm"}
                </span>
                .
              </p>
              {result.doubles ? (
                <p className="mt-3 text-muted-foreground">
                  Measured flat, so the body has to fit through{" "}
                  <span className="font-semibold text-foreground">
                    {result.worn} {unit === "in" ? "in" : "cm"}
                  </span>{" "}
                  ({result.wornOther} {result.otherUnit === "in" ? "in" : "cm"}). That doubling is
                  the step most buyers skip.
                </p>
              ) : (
                <p className="mt-3 text-muted-foreground">
                  This one is a straight length, so there is nothing to double.
                </p>
              )}
              {selected ? (
                <p className="mt-3 text-sm text-muted-foreground">{selected.pitfall}</p>
              ) : null}
            </div>
          ) : (
            <p className="mt-6 text-muted-foreground">Enter a number above zero.</p>
          )}
        </div>
      </section>

      <section className="px-6 py-16">
        <div className="mx-auto max-w-3xl">
          <h2 className="text-3xl font-bold">Where each measurement is taken</h2>
          <p className="mt-2 text-muted-foreground">
            These are the same definitions GradeThread uses when it records measurements on an
            item, so a number here and a number in a GradeThread listing mean the same thing.
          </p>
          <dl className="mt-6 space-y-6">
            {MEASUREMENT_HOWTO.map((m) => (
              <div key={m.key}>
                <dt className="font-medium">{m.label}</dt>
                <dd className="mt-1 text-muted-foreground">{m.how}</dd>
                <dd className="mt-1 text-sm text-muted-foreground">{m.pitfall}</dd>
              </div>
            ))}
          </dl>
        </div>
      </section>

      <section className="border-t bg-card px-6 py-16">
        <div className="mx-auto max-w-3xl">
          <h2 className="text-3xl font-bold">International size conversion</h2>
          <p className="mt-2 text-muted-foreground">{SIZE_TABLE_CAVEAT}</p>

          <h3 className="mt-8 text-xl font-semibold">Women&rsquo;s clothing</h3>
          <div className="mt-3 overflow-x-auto">
            <table className="w-full min-w-[36rem] text-left text-sm">
              <thead>
                <tr className="border-b">
                  <th className="py-2 pr-4 font-medium">US</th>
                  <th className="py-2 pr-4 font-medium">UK</th>
                  <th className="py-2 pr-4 font-medium">EU</th>
                  <th className="py-2 pr-4 font-medium">JP</th>
                  <th className="py-2 pr-4 font-medium">Letter</th>
                  <th className="py-2 pr-4 font-medium">Bust (in)</th>
                  <th className="py-2 font-medium">Waist (in)</th>
                </tr>
              </thead>
              <tbody>
                {WOMENS_SIZES.map((s) => (
                  <tr key={s.us} className="border-b last:border-b-0">
                    <td className="py-2 pr-4">{s.us}</td>
                    <td className="py-2 pr-4">{s.uk}</td>
                    <td className="py-2 pr-4">{s.eu}</td>
                    <td className="py-2 pr-4">{s.jp}</td>
                    <td className="py-2 pr-4">{s.alpha}</td>
                    <td className="py-2 pr-4">{s.bustIn}</td>
                    <td className="py-2">{s.waistIn}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <h3 className="mt-10 text-xl font-semibold">Men&rsquo;s tops</h3>
          <p className="mt-2 text-sm text-muted-foreground">
            The EU column is the body chest in centimetres, halved. That is where European jacket
            sizing comes from, and it is why a 39 inch chest lands on a 50.
          </p>
          <div className="mt-3 overflow-x-auto">
            <table className="w-full min-w-[36rem] text-left text-sm">
              <thead>
                <tr className="border-b">
                  <th className="py-2 pr-4 font-medium">Letter</th>
                  <th className="py-2 pr-4 font-medium">Chest (in)</th>
                  <th className="py-2 pr-4 font-medium">UK / US</th>
                  <th className="py-2 pr-4 font-medium">EU</th>
                  <th className="py-2 pr-4 font-medium">JP</th>
                  <th className="py-2 font-medium">Neck (in)</th>
                </tr>
              </thead>
              <tbody>
                {MENS_TOP_SIZES.map((s) => (
                  <tr key={s.alpha} className="border-b last:border-b-0">
                    <td className="py-2 pr-4">{s.alpha}</td>
                    <td className="py-2 pr-4">{s.chestIn}</td>
                    <td className="py-2 pr-4">{s.ukUs}</td>
                    <td className="py-2 pr-4">{s.eu}</td>
                    <td className="py-2 pr-4">{s.jp}</td>
                    <td className="py-2">{s.neckIn}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <h3 className="mt-10 text-xl font-semibold">Shoes</h3>
          <div className="mt-3 overflow-x-auto">
            <table className="w-full min-w-[36rem] text-left text-sm">
              <thead>
                <tr className="border-b">
                  <th className="py-2 pr-4 font-medium">US men</th>
                  <th className="py-2 pr-4 font-medium">US women</th>
                  <th className="py-2 pr-4 font-medium">UK</th>
                  <th className="py-2 pr-4 font-medium">EU</th>
                  <th className="py-2 pr-4 font-medium">JP</th>
                  <th className="py-2 font-medium">Foot (cm)</th>
                </tr>
              </thead>
              <tbody>
                {SHOE_SIZES.map((s) => (
                  <tr key={s.usMen} className="border-b last:border-b-0">
                    <td className="py-2 pr-4">{s.usMen}</td>
                    <td className="py-2 pr-4">{s.usWomen}</td>
                    <td className="py-2 pr-4">{s.uk}</td>
                    <td className="py-2 pr-4">{s.eu}</td>
                    <td className="py-2 pr-4">{s.jp}</td>
                    <td className="py-2">{s.footCm}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <h3 className="mt-10 text-xl font-semibold">Men&rsquo;s to women&rsquo;s tops</h3>
          <p className="mt-2 text-sm text-muted-foreground">{MENS_TO_WOMENS_TOP_CAVEAT}</p>
          <div className="mt-3 overflow-x-auto">
            <table className="w-full min-w-[20rem] text-left text-sm">
              <thead>
                <tr className="border-b">
                  <th className="py-2 pr-4 font-medium">Men&rsquo;s</th>
                  <th className="py-2 font-medium">Women&rsquo;s</th>
                </tr>
              </thead>
              <tbody>
                {MENS_TO_WOMENS_TOP.map((s) => (
                  <tr key={s.mens} className="border-b last:border-b-0">
                    <td className="py-2 pr-4">{s.mens}</td>
                    <td className="py-2">{s.womens}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </section>

      <section className="px-6 py-16">
        <div className="mx-auto max-w-3xl">
          <h2 className="text-3xl font-bold">Common questions</h2>
          <dl className="mt-6 space-y-6">
            {faqs.map((f) => (
              <div key={f.q}>
                <dt className="font-medium">{f.q}</dt>
                <dd className="mt-1 text-muted-foreground">{f.a}</dd>
              </div>
            ))}
          </dl>
          <p className="mt-10 text-muted-foreground">
            Measurements say whether an item fits. Condition says whether it is worth the price.
            <Link
              to="/grading/glossary"
              className="ml-1 inline-flex items-center gap-1 font-medium text-brand-navy hover:underline dark:text-foreground"
            >
              What the condition terms mean
              <ArrowRight className="size-4" aria-hidden="true" />
            </Link>
          </p>
        </div>
      </section>

      <MarketingCTA />
    </MarketingLayout>
  );
}
