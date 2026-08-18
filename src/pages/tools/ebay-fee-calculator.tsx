import { useMemo, useState } from "react";
import { Link } from "react-router";
import { ArrowRight } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { MarketingLayout, MarketingCTA } from "@/components/marketing/marketing-layout";
import {
  AD_RATE_MAX,
  AD_RATE_MIN,
  EBAY_FEES_RETRIEVED_ON,
  FEE_CATEGORY_LABELS,
  FREE_LISTINGS_PER_MONTH,
  INSERTION_FEE,
  SELLER_STANDING_LABELS,
  STORE_MONTHLY_COST,
  STORE_TIER_LABELS,
  calculateEbayFees,
  type FeeCategory,
  type ListingFormat,
  type SellerStanding,
  type StoreTier,
} from "@/lib/ebay-fee-schedule";
import { getCalculatorBySlug, calculatorContent, calculatorPath } from "@/lib/seo/calculators";
import { calculatorJsonLd, calculatorBreadcrumbLdItems } from "@/pages/marketing/marketing-jsonld";

// US-9003. The arithmetic is in src/lib/ebay-fee-schedule.ts and runs entirely
// in the browser: nothing about a seller's prices is sent anywhere. Every table
// and every word of explanation lives outside the interactive state, so the
// page is useful to a reader and readable by a crawler before any script
// arrives — which is the whole reason tool pages are the best-converting
// surface on this site.

const CALC = getCalculatorBySlug("ebay-fee-calculator");

const dollars = (n: number) =>
  n.toLocaleString("en-US", { style: "currency", currency: "USD" });

/** A number input that keeps its raw string, so a half-typed "1." is not eaten. */
function useMoney(initial: string) {
  const [raw, setRaw] = useState(initial);
  const value = Number(raw);
  return { raw, setRaw, value: Number.isFinite(value) && value >= 0 ? value : 0 };
}

export function EbayFeeCalculatorPage() {
  const price = useMoney("40");
  const shipping = useMoney("8");
  const tax = useMoney("0");
  const cost = useMoney("12");
  const shipCost = useMoney("6.50");
  const adRate = useMoney("0");
  const [category, setCategory] = useState<FeeCategory>("apparel");
  const [storeTier, setStoreTier] = useState<StoreTier>("none");
  const [listingFormat, setListingFormat] = useState<ListingFormat>("fixed");
  const [pastFreeListings, setPastFreeListings] = useState(false);
  const [international, setInternational] = useState(false);
  const [eis, setEis] = useState(false);
  const [standing, setStanding] = useState<SellerStanding>("good");

  const result = useMemo(
    () =>
      calculateEbayFees({
        itemPrice: price.value,
        shippingCharged: shipping.value,
        salesTax: tax.value,
        itemCost: cost.value,
        shippingCost: shipCost.value,
        category,
        storeTier,
        listingFormat,
        startingPrice: price.value,
        pastFreeListings,
        adRatePct: Math.min(adRate.value, AD_RATE_MAX),
        international,
        offersEbayInternationalShipping: eis,
        currencyConverted: false,
        standing,
        lostDispute: false,
      }),
    [
      price.value,
      shipping.value,
      tax.value,
      cost.value,
      shipCost.value,
      category,
      storeTier,
      listingFormat,
      pastFreeListings,
      adRate.value,
      international,
      eis,
      standing,
    ],
  );

  if (!CALC) throw new Error("[ebay-fee-calculator] not in the calculator registry");
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
            Rates read from eBay&apos;s published US fee pages on{" "}
            {EBAY_FEES_RETRIEVED_ON}. eBay prints no effective date on those
            pages, so that is the day this was checked, not the day the rates
            began. Verify before you price a large sale.
          </p>
        </div>
      </section>

      <section className="border-t bg-card px-6 py-12">
        <div className="mx-auto max-w-3xl">
          <h2 className="text-2xl font-bold">Work out one sale</h2>

          <div className="mt-6 grid gap-4 sm:grid-cols-2">
            <div>
              <Label htmlFor="fee-price">Item price</Label>
              <Input
                id="fee-price"
                inputMode="decimal"
                value={price.raw}
                onChange={(e) => price.setRaw(e.target.value)}
                className="mt-1"
              />
            </div>
            <div>
              <Label htmlFor="fee-shipping">Shipping charged to the buyer</Label>
              <Input
                id="fee-shipping"
                inputMode="decimal"
                value={shipping.raw}
                onChange={(e) => shipping.setRaw(e.target.value)}
                className="mt-1"
              />
            </div>
            <div>
              <Label htmlFor="fee-tax">Sales tax collected</Label>
              <Input
                id="fee-tax"
                inputMode="decimal"
                value={tax.raw}
                onChange={(e) => tax.setRaw(e.target.value)}
                className="mt-1"
              />
            </div>
            <div>
              <Label htmlFor="fee-category">Category</Label>
              <select
                id="fee-category"
                value={category}
                onChange={(e) => setCategory(e.target.value as FeeCategory)}
                className="mt-1 h-9 w-full rounded-md border bg-background px-3 text-sm"
              >
                {(Object.keys(FEE_CATEGORY_LABELS) as FeeCategory[]).map((c) => (
                  <option key={c} value={c}>
                    {FEE_CATEGORY_LABELS[c]}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <Label htmlFor="fee-store">Store subscription</Label>
              <select
                id="fee-store"
                value={storeTier}
                onChange={(e) => setStoreTier(e.target.value as StoreTier)}
                className="mt-1 h-9 w-full rounded-md border bg-background px-3 text-sm"
              >
                {(Object.keys(STORE_TIER_LABELS) as StoreTier[]).map((t) => (
                  <option key={t} value={t}>
                    {STORE_TIER_LABELS[t]}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <Label htmlFor="fee-format">Listing format</Label>
              <select
                id="fee-format"
                value={listingFormat}
                onChange={(e) => setListingFormat(e.target.value as ListingFormat)}
                className="mt-1 h-9 w-full rounded-md border bg-background px-3 text-sm"
              >
                <option value="fixed">Fixed price</option>
                <option value="auction">Auction</option>
              </select>
            </div>
            <div>
              <Label htmlFor="fee-adrate">
                Promoted Listings ad rate, % ({AD_RATE_MIN} to {AD_RATE_MAX}, 0 if
                not promoted)
              </Label>
              <Input
                id="fee-adrate"
                inputMode="decimal"
                value={adRate.raw}
                onChange={(e) => adRate.setRaw(e.target.value)}
                className="mt-1"
              />
            </div>
            <div>
              <Label htmlFor="fee-standing">Seller standing</Label>
              <select
                id="fee-standing"
                value={standing}
                onChange={(e) => setStanding(e.target.value as SellerStanding)}
                className="mt-1 h-9 w-full rounded-md border bg-background px-3 text-sm"
              >
                {(Object.keys(SELLER_STANDING_LABELS) as SellerStanding[]).map((s) => (
                  <option key={s} value={s}>
                    {SELLER_STANDING_LABELS[s]}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <Label htmlFor="fee-cost">What the item cost you</Label>
              <Input
                id="fee-cost"
                inputMode="decimal"
                value={cost.raw}
                onChange={(e) => cost.setRaw(e.target.value)}
                className="mt-1"
              />
            </div>
            <div>
              <Label htmlFor="fee-shipcost">What shipping costs you</Label>
              <Input
                id="fee-shipcost"
                inputMode="decimal"
                value={shipCost.raw}
                onChange={(e) => shipCost.setRaw(e.target.value)}
                className="mt-1"
              />
            </div>
          </div>

          <div className="mt-5 space-y-2 text-sm">
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={pastFreeListings}
                onChange={(e) => setPastFreeListings(e.target.checked)}
              />
              Past this month&apos;s free listings (
              {FREE_LISTINGS_PER_MONTH[storeTier].toLocaleString()} on{" "}
              {STORE_TIER_LABELS[storeTier]})
            </label>
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={international}
                onChange={(e) => setInternational(e.target.checked)}
              />
              Buyer registered outside the US, or shipping outside it
            </label>
            {international && (
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={eis}
                  onChange={(e) => setEis(e.target.checked)}
                />
                I offer eBay International Shipping on this listing (waives the
                1.65% fee)
              </label>
            )}
          </div>

          <div className="mt-8 rounded-xl border p-5">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h3 className="text-lg font-semibold">
                Sale total {dollars(result.saleTotal)}
              </h3>
              <p className="text-sm text-muted-foreground">
                Fees are {result.effectiveFeePct}% of it
              </p>
            </div>
            <table className="mt-4 w-full text-left text-sm">
              <tbody>
                {result.lines.map((line) => (
                  <tr key={line.label} className="border-b last:border-b-0 align-top">
                    <th className="py-2 pr-4 font-medium">
                      {line.label}
                      <span className="block text-xs font-normal text-muted-foreground">
                        {line.basis}
                      </span>
                    </th>
                    <td className="py-2 text-right tabular-nums">
                      {dollars(line.amount)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <dl className="mt-5 space-y-1 text-sm">
              <div className="flex justify-between">
                <dt className="font-medium">Total eBay fees</dt>
                <dd className="tabular-nums">{dollars(result.totalFees)}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="font-medium">Paid out to you</dt>
                <dd className="tabular-nums">{dollars(result.payout)}</dd>
              </div>
              <div className="flex justify-between text-base font-semibold">
                <dt>Profit after your costs</dt>
                <dd className="tabular-nums">{dollars(result.profit)}</dd>
              </div>
            </dl>
            <p className="mt-4 text-xs text-muted-foreground">
              Sales tax is collected by eBay and remitted for you, so it is in
              the fee base but never in the payout. A Store subscription is a
              monthly cost, not a per-sale one, so it is not deducted here.
            </p>
          </div>
        </div>
      </section>

      <section className="px-6 py-16">
        <div className="mx-auto max-w-3xl">
          <h2 className="text-3xl font-bold">
            What each Store tier costs, and what it saves
          </h2>
          <p className="mt-2 text-muted-foreground">
            The fee discount starts at Basic. A Starter Store costs money and
            gives you no discount at all, which is the trap in this table.
          </p>
          <div className="mt-6 overflow-x-auto">
            <table className="w-full min-w-[560px] border-collapse text-left text-sm">
              <thead>
                <tr className="border-b">
                  <th className="py-3 pr-4 font-semibold">Tier</th>
                  <th className="py-3 pr-4 font-semibold">Per month, yearly renewal</th>
                  <th className="py-3 pr-4 font-semibold">Apparel fee</th>
                  <th className="py-3 pr-4 font-semibold">Free listings</th>
                  <th className="py-3 font-semibold">Insertion fee after that</th>
                </tr>
              </thead>
              <tbody>
                {(Object.keys(STORE_TIER_LABELS) as StoreTier[]).map((t) => {
                  const discounted = t !== "none" && t !== "starter";
                  return (
                    <tr key={t} className="border-b align-top">
                      <th className="py-3 pr-4 font-medium">{STORE_TIER_LABELS[t]}</th>
                      <td className="py-3 pr-4 tabular-nums text-muted-foreground">
                        {dollars(STORE_MONTHLY_COST[t].yearly)}
                      </td>
                      <td className="py-3 pr-4 text-muted-foreground">
                        {discounted ? "12.7%" : "13.6%"}
                      </td>
                      <td className="py-3 pr-4 tabular-nums text-muted-foreground">
                        {FREE_LISTINGS_PER_MONTH[t].toLocaleString()}
                      </td>
                      <td className="py-3 text-muted-foreground">
                        {dollars(INSERTION_FEE[t].fixed)} fixed price
                        {INSERTION_FEE[t].auction !== INSERTION_FEE[t].fixed
                          ? `, ${dollars(INSERTION_FEE[t].auction)} auction`
                          : ""}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="mt-4 text-sm text-muted-foreground">
            Basic saves 0.9 points on every apparel sale for $21.95 a month, so
            it pays for itself at roughly $2,440 of monthly sales. Below that it
            costs you money.
          </p>
        </div>
      </section>

      <section className="border-t bg-card px-6 py-16">
        <div className="mx-auto max-w-3xl">
          <h2 className="text-3xl font-bold">
            The fee that no calculator prices, because it has not happened yet
          </h2>
          <p className="mt-4 text-muted-foreground">
            A &apos;not as described&apos; return costs you the return shipping,
            the refund and the sale. Let the rate go Very High in a category and
            eBay adds 5 percentage points to every final value fee in it,
            escalating to 6 after four months. That is a larger swing than the
            gap between having a Store and not having one, and condition
            disagreements are what cause it. A standardized condition grade and
            a certificate set the buyer&apos;s expectation before they buy, and
            document that you described the item honestly if they dispute it
            after.
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
