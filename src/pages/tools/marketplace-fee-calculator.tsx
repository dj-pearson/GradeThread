import { useMemo, useState } from "react";
import { Link } from "react-router";
import { ArrowRight } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { MarketingLayout, MarketingCTA } from "@/components/marketing/marketing-layout";
import {
  COMPARISON_ORDER,
  FEE_BASE_LABELS,
  MARKETPLACE_FEES,
  compareMarketplaces,
  comparePagePath,
  quoteMarketplace,
  type MarketplaceKey,
} from "@/lib/marketplace-fee-schedules";
import { getCalculatorBySlug, calculatorContent, calculatorPath } from "@/lib/seo/calculators";
import { calculatorJsonLd, calculatorBreadcrumbLdItems } from "@/pages/marketing/marketing-jsonld";

// US-9005. ONE component, four routes. The alternative was four near-identical
// page files that would drift apart on the first copy edit, and the story asked
// for the opposite: generated from the shared calculator family. Everything
// that differs between the platforms lives in the fee schedule or the calculator
// registry, so a rate change is a one-file edit and so is a wording change.
//
// eBay is in the comparison table but has no page here — it has its own
// calculator, because its fee model does not fit this shape.

const dollars = (n: number) => n.toLocaleString("en-US", { style: "currency", currency: "USD" });
const pct = (n: number) => `${(n * 100).toFixed(1).replace(/\.0$/, "")}%`;

function useMoney(initial: string) {
  const [raw, setRaw] = useState(initial);
  const value = Number(raw);
  return { raw, setRaw, value: Number.isFinite(value) && value >= 0 ? value : 0 };
}

export function MarketplaceFeeCalculatorPage({ platform }: { platform: MarketplaceKey }) {
  const schedule = MARKETPLACE_FEES[platform];
  const calc = getCalculatorBySlug(schedule.slug ?? "");

  const price = useMoney("40");
  const shipping = useMoney("8");
  const tax = useMoney("3");
  const cost = useMoney("12");
  const shipCost = useMoney("6.50");
  const [promoted, setPromoted] = useState(false);

  const sale = useMemo(
    () => ({
      itemPrice: price.value,
      shippingCharged: shipping.value,
      salesTax: tax.value,
      itemCost: cost.value,
      shippingCost: shipCost.value,
      promoted,
    }),
    [price.value, shipping.value, tax.value, cost.value, shipCost.value, promoted],
  );

  const result = useMemo(() => quoteMarketplace(platform, sale), [platform, sale]);
  const comparison = useMemo(() => compareMarketplaces(sale), [sale]);
  const best = comparison[0];

  if (!calc) throw new Error(`[marketplace-fee-calculator] ${platform} is not in the registry`);
  const { intro, faqs } = calculatorContent(calc);

  return (
    <MarketingLayout
      title={calc.title}
      description={calc.description}
      canonicalPath={calculatorPath(calc.slug)}
      breadcrumbs={calculatorBreadcrumbLdItems(calc)}
      jsonLd={calculatorJsonLd(calc)}
    >
      <section className="px-6 py-16 lg:py-20">
        <div className="mx-auto max-w-3xl">
          <h1 className="text-4xl font-bold tracking-tight sm:text-5xl">{calc.h1}</h1>
          <p className="mt-6 text-lg text-foreground">{intro}</p>
          <p className="mt-4 text-sm text-muted-foreground">
            Rates read from {schedule.name}&apos;s own fee page on {schedule.retrievedOn}
            {schedule.effectiveFrom
              ? `, which states they took effect on ${schedule.effectiveFrom}`
              : `. ${schedule.name} publishes no effective date, so that is the day this was checked rather than the day the rates began`}
            . US sellers only.
          </p>
        </div>
      </section>

      <section className="border-y bg-card px-6 py-12">
        <div className="mx-auto max-w-3xl">
          <h2 className="text-2xl font-bold">Your sale</h2>
          <div className="mt-5 grid gap-4 sm:grid-cols-2">
            <div>
              <Label htmlFor="mf-price">Item price</Label>
              <Input
                id="mf-price"
                inputMode="decimal"
                value={price.raw}
                onChange={(e) => price.setRaw(e.target.value)}
                className="mt-1"
              />
            </div>
            <div>
              <Label htmlFor="mf-shipping">Shipping charged to the buyer</Label>
              <Input
                id="mf-shipping"
                inputMode="decimal"
                value={shipping.raw}
                onChange={(e) => shipping.setRaw(e.target.value)}
                className="mt-1"
              />
            </div>
            <div>
              <Label htmlFor="mf-tax">Sales tax collected</Label>
              <Input
                id="mf-tax"
                inputMode="decimal"
                value={tax.raw}
                onChange={(e) => tax.setRaw(e.target.value)}
                className="mt-1"
              />
              <p className="mt-1 text-xs text-muted-foreground">
                Remitted by the marketplace, never paid to you. It still counts
                toward the fee on some platforms.
              </p>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <Label htmlFor="mf-cost">Item cost</Label>
                <Input
                  id="mf-cost"
                  inputMode="decimal"
                  value={cost.raw}
                  onChange={(e) => cost.setRaw(e.target.value)}
                  className="mt-1"
                />
              </div>
              <div>
                <Label htmlFor="mf-shipcost">Postage you pay</Label>
                <Input
                  id="mf-shipcost"
                  inputMode="decimal"
                  value={shipCost.raw}
                  onChange={(e) => shipCost.setRaw(e.target.value)}
                  className="mt-1"
                />
              </div>
            </div>
          </div>

          {schedule.promotionRate !== null && (
            <label className="mt-5 flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={promoted}
                onChange={(e) => setPromoted(e.target.checked)}
              />
              {schedule.promotionLabel} on this listing ({pct(schedule.promotionRate)})
            </label>
          )}

          <div className="mt-8 rounded-xl border p-5">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h3 className="text-lg font-semibold">
                {schedule.name} keeps {dollars(result.totalFees)}
              </h3>
              <p className="text-sm text-muted-foreground">
                {result.effectiveRatePct}% of the item price
              </p>
            </div>
            <table className="mt-4 w-full text-left text-sm">
              <tbody>
                {result.lines.map((line) => (
                  <tr key={line.label} className="border-b align-top last:border-b-0">
                    <th className="py-2 pr-4 font-medium">
                      {line.label}
                      <span className="block text-xs font-normal text-muted-foreground">
                        {line.basis}
                      </span>
                    </th>
                    <td className="py-2 text-right tabular-nums">{dollars(line.amount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <dl className="mt-5 space-y-1 text-sm">
              <div className="flex justify-between">
                <dt className="font-medium">Paid out to you</dt>
                <dd className="tabular-nums">{dollars(result.payout)}</dd>
              </div>
              <div className="flex justify-between text-base font-semibold">
                <dt>Profit after your costs</dt>
                <dd className="tabular-nums">{dollars(result.profit)}</dd>
              </div>
            </dl>
            {schedule.buyerFee && result.buyerPays > 0 && (
              <p className="mt-4 text-xs text-muted-foreground">
                The buyer also pays a {schedule.buyerFee.label}{" "}
                {pct(schedule.buyerFee.rate)}
                {schedule.buyerFee.fixed > 0
                  ? ` plus ${dollars(schedule.buyerFee.fixed)}`
                  : ""}
                , about {dollars(result.buyerPays)} on this sale. That is not your
                cost, but it is on the screen when they decide.
              </p>
            )}
          </div>
        </div>
      </section>

      <section className="px-6 py-16">
        <div className="mx-auto max-w-3xl">
          <h2 className="text-3xl font-bold">The same sale on all five platforms</h2>
          <p className="mt-2 text-muted-foreground">
            Your numbers, run through every fee schedule. eBay is modelled as
            apparel with no Store and good standing; its full model has more
            levers than that.
          </p>
          <div className="mt-6 overflow-x-auto">
            <table className="w-full min-w-[640px] border-collapse text-left text-sm">
              <thead>
                <tr className="border-b">
                  <th className="py-3 pr-4 font-semibold">Platform</th>
                  <th className="py-3 pr-4 font-semibold">Fees</th>
                  <th className="py-3 pr-4 font-semibold">Payout</th>
                  <th className="py-3 pr-4 font-semibold">Profit</th>
                  <th className="py-3 font-semibold">Charged on</th>
                </tr>
              </thead>
              <tbody>
                {comparison.map((row) => {
                  const s = MARKETPLACE_FEES[row.key];
                  const compare =
                    row.key === platform ? null : comparePagePath(platform, row.key);
                  return (
                    <tr key={row.key} className="border-b align-top">
                      <th className="py-3 pr-4 font-medium">
                        {row.key === platform ? (
                          row.name
                        ) : s.slug ? (
                          <Link to={calculatorPath(s.slug)} className="hover:underline">
                            {row.name}
                          </Link>
                        ) : (
                          <Link to="/tools/ebay-fee-calculator" className="hover:underline">
                            {row.name}
                          </Link>
                        )}
                        {compare && (
                          <Link
                            to={compare}
                            className="block text-xs font-normal text-muted-foreground hover:underline"
                          >
                            {schedule.name} vs {row.name}
                          </Link>
                        )}
                      </th>
                      <td className="py-3 pr-4 tabular-nums text-muted-foreground">
                        {dollars(row.totalFees)}
                      </td>
                      <td className="py-3 pr-4 tabular-nums text-muted-foreground">
                        {dollars(row.payout)}
                      </td>
                      <td className="py-3 pr-4 tabular-nums text-muted-foreground">
                        {dollars(row.profit)}
                      </td>
                      <td className="py-3 text-muted-foreground">
                        {FEE_BASE_LABELS[s.commissionBase]}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {best && (
            <p className="mt-4 text-sm text-muted-foreground">
              On these numbers {best.name} pays the most, {dollars(best.payout)},
              and{" "}
              {comparison[comparison.length - 1]!.name} pays the least,{" "}
              {dollars(comparison[comparison.length - 1]!.payout)}. That spread is{" "}
              {dollars(best.payout - comparison[comparison.length - 1]!.payout)} on
              one item. Where an item sells fastest still matters more than where
              it nets a dollar more.
            </p>
          )}
        </div>
      </section>

      <section className="border-t bg-card px-6 py-16">
        <div className="mx-auto max-w-3xl">
          <h2 className="text-3xl font-bold">What each platform actually charges on</h2>
          <p className="mt-2 text-muted-foreground">
            Headline rates are not comparable, because the five platforms charge
            them on five different bases. This is the part that decides who is
            really cheapest.
          </p>
          <dl className="mt-6 space-y-5">
            {COMPARISON_ORDER.map((key) => {
              const s = MARKETPLACE_FEES[key];
              return (
                <div key={key} className="border-b pb-5 last:border-b-0">
                  <dt className="font-medium">
                    {s.name}
                    {s.commissionRate > 0 ? `, ${pct(s.commissionRate)} on ` : ", "}
                    {s.commissionRate > 0
                      ? FEE_BASE_LABELS[s.commissionBase]
                      : "no selling fee for US sellers"}
                  </dt>
                  <dd className="mt-2 text-sm text-muted-foreground">{s.gotcha}</dd>
                </div>
              );
            })}
          </dl>
        </div>
      </section>

      <section className="px-6 py-16">
        <div className="mx-auto max-w-3xl">
          <h2 className="text-3xl font-bold">
            The fee no schedule prints is the item that comes back
          </h2>
          <p className="mt-4 text-muted-foreground">
            A return on used clothing costs you both shipping legs, the refund and
            the sale, which is larger than the gap between any two platforms on
            this page. Most of those returns are condition disputes: the buyer
            expected one thing and opened another. A standardized grade sets that
            expectation before they buy, and documents what you described if they
            argue after.
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

export function PoshmarkFeeCalculatorPage() {
  return <MarketplaceFeeCalculatorPage platform="poshmark" />;
}

export function MercariFeeCalculatorPage() {
  return <MarketplaceFeeCalculatorPage platform="mercari" />;
}

export function DepopFeeCalculatorPage() {
  return <MarketplaceFeeCalculatorPage platform="depop" />;
}

export function EtsyFeeCalculatorPage() {
  return <MarketplaceFeeCalculatorPage platform="etsy" />;
}
