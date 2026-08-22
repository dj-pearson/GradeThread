import { useMemo, useState } from "react";
import { Link } from "react-router";
import { CalculatorHandoff } from "@/components/marketing/calculator-funnel";
import { useCalculatorFunnel } from "@/lib/calculator-funnel";
import { ArrowRight } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { MarketingLayout, MarketingCTA } from "@/components/marketing/marketing-layout";
import {
  DIM_DIVISOR,
  FLAT_RATE_OPTIONS,
  GROUND_ADVANTAGE_BY_POUND,
  GROUND_ADVANTAGE_UNDER_1LB,
  USPS_RATES_EFFECTIVE_FROM,
  USPS_RATES_RETRIEVED_ON,
  ZONE_BANDS,
  estimateZone,
  quoteShipping,
  type UspsZone,
} from "@/lib/usps-rate-schedule";
import { zip3Centroid } from "@/lib/zip3-centroids";
import { getCalculatorBySlug, calculatorContent, calculatorPath } from "@/lib/seo/calculators";
import { calculatorJsonLd, calculatorBreadcrumbLdItems } from "@/pages/marketing/marketing-jsonld";

// US-9004. Rates and arithmetic live in src/lib/usps-rate-schedule.ts and run
// entirely in the browser. The zone comes from a packed table of ZIP prefix
// centroids, so there is no network call and nothing to break on a carrier
// outage. Every table and every word of explanation sits outside the
// interactive state, so a crawler and a reader with no JavaScript both get the
// useful half of the page.

const CALC = getCalculatorBySlug("ebay-shipping-calculator");

const dollars = (n: number) => n.toLocaleString("en-US", { style: "currency", currency: "USD" });

function useNumber(initial: string) {
  const [raw, setRaw] = useState(initial);
  const value = Number(raw);
  return { raw, setRaw, value: Number.isFinite(value) && value >= 0 ? value : 0 };
}

/** The packages a clothing seller actually sends, as one-click starting points. */
const PRESETS = [
  { label: "T-shirt, poly mailer", weightOz: 8, l: 12, w: 9, h: 1 },
  { label: "Jeans, poly mailer", weightOz: 22, l: 14, w: 11, h: 3 },
  { label: "Hoodie, poly mailer", weightOz: 26, l: 16, w: 12, h: 4 },
  { label: "Sneakers in their box", weightOz: 48, l: 14, w: 9, h: 5 },
  { label: "Puffer jacket, boxed", weightOz: 32, l: 18, w: 14, h: 10 },
] as const;

export function EbayShippingCalculatorPage() {
  const weight = useNumber("26");
  const length = useNumber("16");
  const width = useNumber("12");
  const height = useNumber("4");
  const [originZip, setOriginZip] = useState("10001");
  const [destZip, setDestZip] = useState("90210");
  const [zoneOverride, setZoneOverride] = useState<UspsZone | null>(null);

  const pkg = useMemo(
    () => ({
      weightOz: weight.value,
      lengthIn: length.value,
      widthIn: width.value,
      heightIn: height.value,
    }),
    [weight.value, length.value, width.value, height.value],
  );

  useCalculatorFunnel(CALC?.slug ?? "", weight.raw);

  const estimated = useMemo(
    () => estimateZone(originZip, destZip, zip3Centroid),
    [originZip, destZip],
  );

  const zone = zoneOverride ?? estimated?.zone ?? null;
  const quote = useMemo(() => (zone ? quoteShipping(pkg, zone) : null), [pkg, zone]);

  function applyPreset(p: (typeof PRESETS)[number]) {
    weight.setRaw(String(p.weightOz));
    length.setRaw(String(p.l));
    width.setRaw(String(p.w));
    height.setRaw(String(p.h));
  }

  if (!CALC) throw new Error("[ebay-shipping-calculator] not in the calculator registry");
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
          <p className="mt-4 text-sm text-muted-foreground">
            USPS commercial prices, effective {USPS_RATES_EFFECTIVE_FROM} and
            cross-checked against the published tables on {USPS_RATES_RETRIEVED_ON}.
            That is the tier you pay buying a label through eBay or any online
            provider, not the Post Office counter price, which runs 30 to 40
            percent higher. eBay&apos;s own rates are at or below this, so read a
            result as a ceiling rather than a quote.
          </p>
        </div>
      </section>

      <section className="border-y bg-card px-6 py-12">
        <div className="mx-auto max-w-3xl">
          <h2 className="text-2xl font-bold">What are you sending?</h2>

          <div className="mt-5 flex flex-wrap gap-2">
            {PRESETS.map((p) => (
              <button
                key={p.label}
                type="button"
                onClick={() => applyPreset(p)}
                className="rounded-full border px-3 py-1.5 text-sm text-muted-foreground hover:bg-background"
              >
                {p.label}
              </button>
            ))}
          </div>

          <div className="mt-6 grid gap-4 sm:grid-cols-2">
            <div>
              <Label htmlFor="ship-weight">Weight, ounces</Label>
              <Input
                id="ship-weight"
                inputMode="decimal"
                value={weight.raw}
                onChange={(e) => weight.setRaw(e.target.value)}
                className="mt-1"
              />
              <p className="mt-1 text-xs text-muted-foreground">
                Packed weight, including the mailer. 16 ounces is a pound.
              </p>
            </div>
            <div className="grid grid-cols-3 gap-2">
              <div>
                <Label htmlFor="ship-l">Length</Label>
                <Input
                  id="ship-l"
                  inputMode="decimal"
                  value={length.raw}
                  onChange={(e) => length.setRaw(e.target.value)}
                  className="mt-1"
                />
              </div>
              <div>
                <Label htmlFor="ship-w">Width</Label>
                <Input
                  id="ship-w"
                  inputMode="decimal"
                  value={width.raw}
                  onChange={(e) => width.setRaw(e.target.value)}
                  className="mt-1"
                />
              </div>
              <div>
                <Label htmlFor="ship-h">Height</Label>
                <Input
                  id="ship-h"
                  inputMode="decimal"
                  value={height.raw}
                  onChange={(e) => height.setRaw(e.target.value)}
                  className="mt-1"
                />
              </div>
            </div>
            <div>
              <Label htmlFor="ship-origin">Your ZIP</Label>
              <Input
                id="ship-origin"
                inputMode="numeric"
                value={originZip}
                onChange={(e) => {
                  setOriginZip(e.target.value);
                  setZoneOverride(null);
                }}
                className="mt-1"
              />
            </div>
            <div>
              <Label htmlFor="ship-dest">Buyer&apos;s ZIP</Label>
              <Input
                id="ship-dest"
                inputMode="numeric"
                value={destZip}
                onChange={(e) => {
                  setDestZip(e.target.value);
                  setZoneOverride(null);
                }}
                className="mt-1"
              />
            </div>
          </div>

          <div className="mt-4 text-sm">
            {estimated ? (
              <p className="text-muted-foreground">
                About {estimated.miles.toLocaleString()} miles apart, which is{" "}
                <strong className="text-foreground">Zone {estimated.zone}</strong> (
                {estimated.band}).{" "}
                {zoneOverride !== null && zoneOverride !== estimated.zone
                  ? `Showing Zone ${zoneOverride} instead.`
                  : ""}
              </p>
            ) : (
              <p className="text-muted-foreground">
                One of those ZIP codes is not one we recognise. Pick a zone
                directly instead.
              </p>
            )}
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <span className="text-xs text-muted-foreground">Or set the zone:</span>
              {ZONE_BANDS.map((b) => (
                <button
                  key={b.zone}
                  type="button"
                  onClick={() => setZoneOverride(b.zone)}
                  className={
                    "rounded-md border px-2 py-1 text-xs " +
                    (zone === b.zone
                      ? "border-foreground font-medium text-foreground"
                      : "text-muted-foreground hover:bg-background")
                  }
                >
                  {b.zone}
                </button>
              ))}
            </div>
          </div>

          {quote && (
            <div className="mt-8 rounded-xl border p-5">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <h3 className="text-lg font-semibold">
                  Billed as {quote.weight.billableLb} lb to Zone {quote.zone}
                </h3>
                {quote.cheapest && (
                  <p className="text-sm text-muted-foreground">
                    Cheapest is {quote.cheapest.name} at {dollars(quote.cheapest.price)}
                  </p>
                )}
              </div>

              {quote.weight.dimApplies && (
                <p className="mt-3 rounded-md border px-3 py-2 text-sm">
                  <strong>Dimensional weight applies.</strong> The box is{" "}
                  {quote.weight.cubicInches.toLocaleString()} cubic inches, which
                  is over a cubic foot, so USPS charges on{" "}
                  {quote.weight.cubicInches.toLocaleString()} divided by{" "}
                  {DIM_DIVISOR}, or {quote.weight.dimLb} lb, rather than the{" "}
                  {quote.weight.actualLb} lb on your scale. Pack it smaller and
                  this goes away.
                </p>
              )}

              <table className="mt-4 w-full text-left text-sm">
                <thead>
                  <tr className="border-b">
                    <th className="py-2 pr-4 font-semibold">Service</th>
                    <th className="py-2 pr-4 font-semibold">Speed</th>
                    <th className="py-2 text-right font-semibold">Cost</th>
                  </tr>
                </thead>
                <tbody>
                  {quote.services.map((s) => (
                    <tr key={s.key} className="border-b align-top last:border-b-0">
                      <th className="py-2 pr-4 font-medium">
                        {s.name}
                        {s.note && (
                          <span className="block text-xs font-normal text-muted-foreground">
                            {s.note}
                          </span>
                        )}
                      </th>
                      <td className="py-2 pr-4 text-muted-foreground">{s.speed}</td>
                      <td className="py-2 text-right tabular-nums">{dollars(s.price)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>

              {quote.cheapestFlatRate && quote.cheapestWeightBased && (
                <p className="mt-5 text-sm text-muted-foreground">
                  {quote.cheapestFlatRate.price < quote.cheapestWeightBased.price
                    ? `Flat rate wins here by ${dollars(quote.cheapestWeightBased.price - quote.cheapestFlatRate.price)}. It ignores both weight and zone, which is why it pulls ahead on heavy packages going a long way.`
                    : `Weight-based wins here by ${dollars(quote.cheapestFlatRate.price - quote.cheapestWeightBased.price)}. Flat rate only pays off once the package is heavy, far, or both.`}
                </p>
              )}

              {!quote.cheapestFlatRate && (
                <p className="mt-5 text-sm text-muted-foreground">
                  No flat-rate box or envelope is big enough for these
                  dimensions, so weight-based pricing is the only option.
                </p>
              )}

              <p className="mt-4 text-xs text-muted-foreground">
                Nothing you type here is sent anywhere. The zone is estimated from
                the distance between your two ZIP prefixes, which is close but not
                the official USPS chart, so it can be one zone out near a boundary.
              </p>
            </div>
          )}
        </div>
      </section>

      <section className="px-6 py-16">
        <div className="mx-auto max-w-3xl">
          <h2 className="text-3xl font-bold">The cliff at 16 ounces</h2>
          <p className="mt-2 text-muted-foreground">
            Ground Advantage charges one price for everything under a pound, and
            it is lower than the one pound price. So the cheapest thing you can
            do to a 17 ounce package is take an ounce out of it.
          </p>
          <div className="mt-6 overflow-x-auto">
            <table className="w-full min-w-[560px] border-collapse text-left text-sm">
              <thead>
                <tr className="border-b">
                  <th className="py-3 pr-4 font-semibold">Zone</th>
                  <th className="py-3 pr-4 font-semibold">Distance</th>
                  <th className="py-3 pr-4 font-semibold">Under 1 lb</th>
                  <th className="py-3 pr-4 font-semibold">Exactly 1 lb</th>
                  <th className="py-3 font-semibold">What the extra ounce costs</th>
                </tr>
              </thead>
              <tbody>
                {ZONE_BANDS.map((b) => {
                  const under = GROUND_ADVANTAGE_UNDER_1LB[b.zone - 1]!;
                  const one = GROUND_ADVANTAGE_BY_POUND[0]![b.zone - 1]!;
                  return (
                    <tr key={b.zone} className="border-b align-top">
                      <th className="py-3 pr-4 font-medium">Zone {b.zone}</th>
                      <td className="py-3 pr-4 text-muted-foreground">{b.label}</td>
                      <td className="py-3 pr-4 tabular-nums text-muted-foreground">
                        {dollars(under)}
                      </td>
                      <td className="py-3 pr-4 tabular-nums text-muted-foreground">
                        {dollars(one)}
                      </td>
                      <td className="py-3 tabular-nums text-muted-foreground">
                        {dollars(one - under)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="mt-4 text-sm text-muted-foreground">
            A folded t-shirt in a poly mailer is comfortably under a pound. The
            same shirt in a box usually is not, and the box has bought you
            nothing.
          </p>
        </div>
      </section>

      <section className="border-t bg-card px-6 py-16">
        <div className="mx-auto max-w-3xl">
          <h2 className="text-3xl font-bold">Flat rate, and what actually fits</h2>
          <p className="mt-2 text-muted-foreground">
            Same price to any zone, up to 70 lb. The catch is the interior, which
            is smaller than sellers picture, and the price, which is above
            Ground Advantage for anything light.
          </p>
          <div className="mt-6 overflow-x-auto">
            <table className="w-full min-w-[640px] border-collapse text-left text-sm">
              <thead>
                <tr className="border-b">
                  <th className="py-3 pr-4 font-semibold">Container</th>
                  <th className="py-3 pr-4 font-semibold">Price</th>
                  <th className="py-3 pr-4 font-semibold">Inside dimensions</th>
                  <th className="py-3 font-semibold">What it holds</th>
                </tr>
              </thead>
              <tbody>
                {FLAT_RATE_OPTIONS.map((o) => (
                  <tr key={o.key} className="border-b align-top">
                    <th className="py-3 pr-4 font-medium">{o.name}</th>
                    <td className="py-3 pr-4 tabular-nums text-muted-foreground">
                      {dollars(o.price)}
                    </td>
                    <td className="py-3 pr-4 text-muted-foreground">{o.fits}</td>
                    <td className="py-3 text-muted-foreground">{o.holds}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </section>

      <section className="px-6 py-16">
        <div className="mx-auto max-w-3xl">
          <h2 className="text-3xl font-bold">
            The postage you pay twice is on the item that comes back
          </h2>
          <p className="mt-4 text-muted-foreground">
            A return costs you the label out, the label back, and the sale. On
            used clothing most returns are not about fit, they are about
            condition: the buyer expected one thing and opened another. Postage
            is the only cost on this page you can plan for. Setting the
            condition expectation before the buyer clicks buy is how you avoid
            paying it twice.
          </p>
          <div className="mt-5">
            <Link to="/condition-grading">
              <span className="inline-flex items-center text-sm font-medium text-brand-red-text hover:underline">
                How condition grading works
                <ArrowRight className="ml-1 h-4 w-4" />
              </span>
            </Link>
          </div>
        </div>
      </section>

      {CALC && <CalculatorHandoff calc={CALC} />}

      <section className="border-t px-6 py-16">
        <div className="mx-auto max-w-2xl">
          <h2 className="text-center text-3xl font-bold">Common questions</h2>
          <dl className="mt-10 space-y-6">
            {faqs.map((faq) => (
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
