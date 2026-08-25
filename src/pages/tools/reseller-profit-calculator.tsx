import { useMemo, useState } from "react";
import { Link } from "react-router";
import { CalculatorHandoff } from "@/components/marketing/calculator-funnel";
import { useCalculatorFunnel } from "@/lib/calculator-funnel";
import { ArrowRight } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { MarketingLayout, MarketingCTA } from "@/components/marketing/marketing-layout";
import { track } from "@/lib/analytics";
import {
  COMPARISON_ORDER,
  MARKETPLACE_FEES,
  quoteMarketplace,
  type MarketplaceKey,
} from "@/lib/marketplace-fee-schedules";
import {
  CONDITION_CURVE_DERIVED_ON,
  CONDITION_VALUE_CURVE,
  adjustForCondition,
  conditionRatio,
  ratioFromCurve,
  tierLabelForGrade,
} from "@/lib/condition-value-curve";
import { useConditionIndexHub, useConditionIndexCurve } from "@/hooks/use-condition-index";
import { getCalculatorBySlug, calculatorContent, calculatorPath } from "@/lib/seo/calculators";
import { calculatorJsonLd, calculatorBreadcrumbLdItems } from "@/pages/marketing/marketing-jsonld";

// US-9006. The one calculator in the family that no competitor has, because it
// is the one that needs data nobody else collected: what a condition grade does
// to the price. The curve is derived from GradeThread's own published Condition
// Index and the page says so, including how wide the spread is.
//
// The Condition Index lookup is a browser-only enhancement. Everything the page
// is FOR works in the prerendered HTML with the default curve, so a crawler and
// a reader with no JavaScript still get the answer.

const CALC = getCalculatorBySlug("reseller-profit-calculator");

const dollars = (n: number) => n.toLocaleString("en-US", { style: "currency", currency: "USD" });

function useMoney(initial: string) {
  const [raw, setRaw] = useState(initial);
  const value = Number(raw);
  return { raw, setRaw, value: Number.isFinite(value) && value >= 0 ? value : 0 };
}

const GRADE_OPTIONS = [10, 9.5, 9, 8.5, 8, 7.5, 7, 6.5, 6, 5.5, 5, 4.5, 4, 3.5, 3];

export function ResellerProfitCalculatorPage() {
  const comp = useMoney("60");
  const cost = useMoney("18");
  const shippingCharged = useMoney("0");
  const shippingCost = useMoney("7.61");
  const tax = useMoney("0");
  const [compGrade, setCompGrade] = useState(9);
  const [itemGrade, setItemGrade] = useState(7);
  const [platform, setPlatform] = useState<MarketplaceKey>("ebay");
  const [indexSlug, setIndexSlug] = useState("");

  useCalculatorFunnel(CALC?.slug ?? "", comp.raw);

  const hub = useConditionIndexHub();
  const curve = useConditionIndexCurve(indexSlug || null);

  // A live per-item curve when the seller picked one and it is thick enough,
  // otherwise the default table. Which one was used is stated in the output.
  const liveRatio = useMemo(
    () => (curve.data?.points ? ratioFromCurve(curve.data.points) : null),
    [curve.data],
  );

  const adjustment = useMemo(
    () =>
      liveRatio
        ? adjustForCondition(comp.value, compGrade, itemGrade, liveRatio, "condition-index-item")
        : adjustForCondition(comp.value, compGrade, itemGrade, conditionRatio),
    [comp.value, compGrade, itemGrade, liveRatio],
  );

  const salePrice = adjustment.adjustedPrice;

  const quote = useMemo(
    () =>
      quoteMarketplace(platform, {
        itemPrice: salePrice,
        shippingCharged: shippingCharged.value,
        salesTax: tax.value,
        itemCost: cost.value,
        shippingCost: shippingCost.value,
      }),
    [platform, salePrice, shippingCharged.value, tax.value, cost.value, shippingCost.value],
  );

  const gross = salePrice + shippingCharged.value;
  const totalCost = cost.value + shippingCost.value;
  const margin = gross > 0 ? Math.round((quote.profit / gross) * 1000) / 10 : 0;
  const roi = totalCost > 0 ? Math.round((quote.profit / totalCost) * 1000) / 10 : 0;

  if (!CALC) throw new Error("[reseller-profit-calculator] not in the calculator registry");
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

      <section className="border-y bg-card px-6 py-12">
        <div className="mx-auto max-w-3xl">
          <h2 className="text-2xl font-bold">The comp, and the item you actually have</h2>

          <div className="mt-5 grid gap-4 sm:grid-cols-2">
            <div>
              <Label htmlFor="rp-comp">Comparable sold price</Label>
              <Input
                id="rp-comp"
                inputMode="decimal"
                value={comp.raw}
                onChange={(e) => comp.setRaw(e.target.value)}
                className="mt-1"
              />
              <p className="mt-1 text-xs text-muted-foreground">
                What one like it actually sold for, not what one is listed at.
              </p>
            </div>
            <div>
              <Label htmlFor="rp-compgrade">Condition of that comp</Label>
              <select
                id="rp-compgrade"
                value={compGrade}
                onChange={(e) => setCompGrade(Number(e.target.value))}
                className="mt-1 h-9 w-full rounded-md border bg-background px-3 text-sm"
              >
                {GRADE_OPTIONS.map((g) => (
                  <option key={g} value={g}>
                    {g.toFixed(1)} — {tierLabelForGrade(g)}
                  </option>
                ))}
              </select>
              <p className="mt-1 text-xs text-muted-foreground">
                Comps skew clean. A photographed, well-described listing is
                usually a 9.
              </p>
            </div>
            <div>
              <Label htmlFor="rp-itemgrade">Condition of YOUR item</Label>
              <select
                id="rp-itemgrade"
                value={itemGrade}
                onChange={(e) => setItemGrade(Number(e.target.value))}
                className="mt-1 h-9 w-full rounded-md border bg-background px-3 text-sm"
              >
                {GRADE_OPTIONS.map((g) => (
                  <option key={g} value={g}>
                    {g.toFixed(1)} — {tierLabelForGrade(g)}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <Label htmlFor="rp-platform">Where you will list it</Label>
              <select
                id="rp-platform"
                value={platform}
                onChange={(e) => setPlatform(e.target.value as MarketplaceKey)}
                className="mt-1 h-9 w-full rounded-md border bg-background px-3 text-sm"
              >
                {COMPARISON_ORDER.map((k) => (
                  <option key={k} value={k}>
                    {MARKETPLACE_FEES[k].name}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <Label htmlFor="rp-cost">What the item cost you</Label>
              <Input
                id="rp-cost"
                inputMode="decimal"
                value={cost.raw}
                onChange={(e) => cost.setRaw(e.target.value)}
                className="mt-1"
              />
            </div>
            <div>
              <Label htmlFor="rp-shipcost">Postage you pay</Label>
              <Input
                id="rp-shipcost"
                inputMode="decimal"
                value={shippingCost.raw}
                onChange={(e) => shippingCost.setRaw(e.target.value)}
                className="mt-1"
              />
              <p className="mt-1 text-xs text-muted-foreground">
                Not sure?{" "}
                <Link to="/tools/ebay-shipping-calculator" className="underline">
                  Work it out
                </Link>
                .
              </p>
            </div>
            <div>
              <Label htmlFor="rp-shipcharged">Shipping you charge the buyer</Label>
              <Input
                id="rp-shipcharged"
                inputMode="decimal"
                value={shippingCharged.raw}
                onChange={(e) => shippingCharged.setRaw(e.target.value)}
                className="mt-1"
              />
            </div>
            <div>
              <Label htmlFor="rp-tax">Sales tax collected</Label>
              <Input
                id="rp-tax"
                inputMode="decimal"
                value={tax.raw}
                onChange={(e) => tax.setRaw(e.target.value)}
                className="mt-1"
              />
            </div>
          </div>

          {hub.data && hub.data.length > 0 && (
            <div className="mt-5">
              <Label htmlFor="rp-index">
                Use a measured curve for a specific item (optional)
              </Label>
              <select
                id="rp-index"
                value={indexSlug}
                onChange={(e) => setIndexSlug(e.target.value)}
                className="mt-1 h-9 w-full rounded-md border bg-background px-3 text-sm"
              >
                <option value="">Use the average curve across all items</option>
                {hub.data.map((i) => (
                  <option key={i.slug} value={i.slug}>
                    {i.label}
                  </option>
                ))}
              </select>
              <p className="mt-1 text-xs text-muted-foreground">
                Some items hold their value far better than the average. A
                Carhartt double knee sells for the same at 8.0 as at 10.0; a
                Lululemon Scuba does not.
              </p>
            </div>
          )}

          <div className="mt-8 rounded-xl border p-5">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h3 className="text-lg font-semibold">
                Estimated sale price {dollars(salePrice)}
              </h3>
              <p className="text-sm text-muted-foreground">
                {adjustment.multiplier === 1
                  ? "No condition adjustment: your item matches the comp"
                  : `${Math.round(adjustment.multiplier * 1000) / 10}% of the comp`}
              </p>
            </div>

            <p className="mt-3 rounded-md border px-3 py-2 text-sm">
              <strong>The adjustment, in the open.</strong> A {compGrade.toFixed(1)}{" "}
              sells for {Math.round(adjustment.compRatio * 1000) / 10}% of a mint
              example and a {itemGrade.toFixed(1)} for{" "}
              {Math.round(adjustment.itemRatio * 1000) / 10}%, so your comp of{" "}
              {dollars(adjustment.compPrice)} becomes {dollars(salePrice)}, a
              change of {dollars(Math.abs(adjustment.delta))}{" "}
              {adjustment.delta < 0 ? "down" : adjustment.delta > 0 ? "up" : ""}.{" "}
              {adjustment.source === "condition-index-item"
                ? "From this item's own measured curve."
                : "From the average curve across the Condition Index, which is built from active eBay listings."}
            </p>

            <table className="mt-4 w-full text-left text-sm">
              <tbody>
                <tr className="border-b align-top">
                  <th className="py-2 pr-4 font-medium">Gross</th>
                  <td className="py-2 text-right tabular-nums">{dollars(gross)}</td>
                </tr>
                {quote.lines.map((line) => (
                  <tr key={line.label} className="border-b align-top">
                    <th className="py-2 pr-4 font-medium">
                      {line.label}
                      <span className="block text-xs font-normal text-muted-foreground">
                        {line.basis}
                      </span>
                    </th>
                    <td className="py-2 text-right tabular-nums">
                      -{dollars(line.amount)}
                    </td>
                  </tr>
                ))}
                <tr className="border-b align-top">
                  <th className="py-2 pr-4 font-medium">Your costs</th>
                  <td className="py-2 text-right tabular-nums">-{dollars(totalCost)}</td>
                </tr>
              </tbody>
            </table>

            <dl className="mt-5 space-y-1 text-sm">
              <div className="flex justify-between text-base font-semibold">
                <dt>Net profit</dt>
                <dd className="tabular-nums">{dollars(quote.profit)}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="font-medium">Margin</dt>
                <dd className="tabular-nums">{margin}%</dd>
              </div>
              <div className="flex justify-between">
                <dt className="font-medium">Return on what you spent</dt>
                <dd className="tabular-nums">{roi}%</dd>
              </div>
            </dl>

            {quote.profit <= 0 && (
              <p className="mt-4 rounded-md border px-3 py-2 text-sm">
                At this grade the item does not clear its costs. That is the
                answer the calculator exists to give you before you buy it, not
                after.
              </p>
            )}
          </div>
        </div>
      </section>

      <section className="px-6 py-16">
        <div className="mx-auto max-w-3xl">
          <h2 className="text-3xl font-bold">What a grade is worth, measured</h2>
          {/* US-2850: this said "sold comps". Marketplace Insights has never
              been granted, so every comp behind the Condition Index is an
              ACTIVE listing and the share below is a share of asking price.
              The counts came out with the word: they were measured, but they
              were measured on a single day and quoting them alongside a
              corrected label implies a precision nobody has re-checked. */}
          <p className="mt-2 text-muted-foreground">
            Median share of a mint price at each grade, across the GradeThread
            Condition Index, read on {CONDITION_CURVE_DERIVED_ON}. The Index is
            built from active eBay listings, so these are shares of asking
            price, not of sale price.
          </p>
          <div className="mt-6 overflow-x-auto">
            <table className="w-full min-w-[560px] border-collapse text-left text-sm">
              <thead>
                <tr className="border-b">
                  <th className="py-3 pr-4 font-semibold">Grade</th>
                  <th className="py-3 pr-4 font-semibold">Tier</th>
                  <th className="py-3 pr-4 font-semibold">Share of mint price</th>
                  <th className="py-3 font-semibold">Range across items</th>
                </tr>
              </thead>
              <tbody>
                {CONDITION_VALUE_CURVE.map((p) => (
                  <tr key={p.grade} className="border-b align-top">
                    <th className="py-3 pr-4 font-medium">{p.grade.toFixed(1)}</th>
                    <td className="py-3 pr-4 text-muted-foreground">
                      {tierLabelForGrade(p.grade)}
                    </td>
                    <td className="py-3 pr-4 tabular-nums text-muted-foreground">
                      {Math.round(p.ratio * 100)}%
                    </td>
                    <td className="py-3 tabular-nums text-muted-foreground">
                      {Math.round(p.low * 100)}% to {Math.round(p.high * 100)}%
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-4 text-sm text-muted-foreground">
            Read the right-hand column before you trust the middle one. At grade
            9.0 the range runs from 53% to 100% depending on the item, which is
            the difference between a good buy and a bad one. Grades 9.5 and 10
            share a row, and so do 8.5 and 9, because the Index bands them
            together rather than because we rounded.
          </p>
        </div>
      </section>

      <section className="border-t bg-card px-6 py-16">
        <div className="mx-auto max-w-3xl">
          <h2 className="text-3xl font-bold">
            Everything above depends on the grade being right
          </h2>
          <p className="mt-4 text-muted-foreground">
            You have just priced an item on a number you assigned yourself. Every
            seller grades their own stock generously, which is why buyers discount
            what a listing says about condition and why the same garment described
            as excellent by two people sells for two different prices. A
            standardized grade from photographs takes the estimate out of the
            most sensitive input on this page.
          </p>
          <div className="mt-5">
            <Link
              to="/dashboard/grade"
              onClick={() =>
                track("calculator_grading_cta_click", {
                  source: "reseller-profit-calculator",
                  destination: "grading",
                  item_grade: itemGrade,
                  marketplace: platform,
                })
              }
            >
              <span className="inline-flex items-center text-sm font-medium text-brand-red-text hover:underline">
                Grade this item
                <ArrowRight className="ml-1 h-4 w-4" />
              </span>
            </Link>
          </div>
          <p className="mt-4 text-sm text-muted-foreground">
            New to grades?{" "}
            <Link to="/condition-grading" className="underline">
              How condition grading works
            </Link>
            , or see{" "}
            <Link to="/condition-index" className="underline">
              the Condition Index
            </Link>{" "}
            these numbers came from.
          </p>
        </div>
      </section>

      {CALC && <CalculatorHandoff calc={CALC} />}

      <section className="px-6 py-16">
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
