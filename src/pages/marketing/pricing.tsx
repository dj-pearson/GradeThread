import { useState } from "react";
import { Link } from "react-router";
import { Check, ShoppingBag } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  MarketingLayout,
  MarketingCTA,
} from "@/components/marketing/marketing-layout";
import { HelpCategoryLink } from "@/components/marketing/help-category-link";
import {
  GRADETHREAD_TIERS,
  CREDIT_PACKS,
  FLIPDESK_PLANS,
  BUYER_PLANS,
  SELLER_PLAN_BUYER_TIER,
  formatListingAllowance,
  type BuyerPlanKey,
} from "@/lib/constants";
import { AutoRenewalDisclosure } from "@/components/billing/auto-renewal-disclosure";
import type { FlipdeskPlan as FlipdeskPlanKey } from "@/types/database";
import { PRICING_FAQS, pricingJsonLd } from "@/pages/marketing/marketing-jsonld";
import { isBulletComingSoon } from "@/lib/buyer-features";

// US-1902: a buyer feature whose surface isn't live yet is labeled so a paying
// visitor never clicks a promised feature and lands on a placeholder.
function ComingSoonBadge() {
  return (
    <span className="ml-1.5 inline-flex items-center rounded-full border border-amber-500/40 bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-amber-700 dark:text-amber-300">
      Coming soon
    </span>
  );
}

const dollars = (cents: number) =>
  cents === 0 ? "$0" : `$${(cents / 100).toFixed(cents % 100 === 0 ? 0 : 2)}`;

// US-2514: where a purchase actually happens. Billing lives in the Account hub
// (US-2511), so the tab is part of the path and any extra parameter is appended
// with `&`.
const BILLING_PATH = "/dashboard/account?tab=billing";
const SUBMIT_PATH = "/dashboard/submissions/new";

type BillingInterval = "monthly" | "yearly";

type PricedPlan = { priceMonthlyCents: number; priceYearlyCents: number };

function priceFor(plan: PricedPlan, interval: BillingInterval): number {
  return interval === "yearly" ? plan.priceYearlyCents : plan.priceMonthlyCents;
}

/** Whole-percent saving of paying yearly, or 0 when there is none to claim. */
function yearlySavingPct(plan: PricedPlan): number {
  const twelve = plan.priceMonthlyCents * 12;
  if (twelve <= 0 || plan.priceYearlyCents <= 0) return 0;
  return Math.round(((twelve - plan.priceYearlyCents) / twelve) * 100);
}

const GRADE_TIER_ROWS = [
  { key: "standard" as const, ...GRADETHREAD_TIERS.standard },
  { key: "premium" as const, ...GRADETHREAD_TIERS.premium },
  { key: "express" as const, ...GRADETHREAD_TIERS.express },
];

const FLIPDESK_ORDER: FlipdeskPlanKey[] = ["free", "starter", "pro", "business"];
const BUYER_ORDER: BuyerPlanKey[] = ["free", "guard", "connoisseur"];

export function PricingPage() {
  // Monthly is the default so the prerendered HTML a crawler sees carries the
  // monthly prices, which is what the JSON-LD and the ads quote.
  const [interval, setInterval] = useState<BillingInterval>("monthly");

  return (
    <MarketingLayout
      title="Pricing"
      description="GradeThread pricing: a free plan with 3 grades/month, pay-per-grade tiers from $2.99, credit packs, and FlipDesk reseller subscriptions."
      canonicalPath="/pricing"
      jsonLd={pricingJsonLd()}
    >
      {/* Answer-first intro */}
      <section className="px-6 py-16 lg:py-20">
        <div className="mx-auto max-w-3xl text-center">
          <h1 className="text-4xl font-bold tracking-tight sm:text-5xl">
            Simple, transparent pricing
          </h1>
          <p className="mx-auto mt-6 max-w-2xl text-lg text-muted-foreground">
            One account, both sides of the closet. Subscribe to FlipDesk to run
            your whole reseller workflow — every plan includes Standard grades
            each month, which is the part a crosslisting tool cannot do for you.
            Grading on its own is free to start: every account gets{" "}
            {FLIPDESK_PLANS.free.includedStandardGradesPerMonth} Standard grades
            a month at no cost, and beyond that you can pay per grade (from{" "}
            {dollars(GRADETHREAD_TIERS.standard.priceCents)}) or buy credit
            packs that never expire. Buyer plans are included with every
            FlipDesk plan, so sellers get both. No setup fees, change plans
            anytime.
          </p>
          {/* US-1470: automatic_tax is enabled at checkout, so surface the
              tax/currency disclaimer here (it previously existed only on the
              authenticated in-app billing page). */}
          <p className="mx-auto mt-4 max-w-2xl text-sm text-muted-foreground">
            All prices are shown in USD and exclude tax — sales tax/VAT is
            calculated at checkout based on your billing location.
          </p>
        </div>
      </section>

      {/* FlipDesk subscriptions. US-9211: FIRST, ahead of pay-per-grade. The
          reseller workflow is what the visitor is shopping for; the grade is
          the reason to buy it here rather than from a crosslister, which is a
          differentiator on the card and not the opening price. */}
      <section className="border-t bg-card px-6 py-16">
        <div className="mx-auto max-w-5xl">
          <h2 className="text-3xl font-bold">FlipDesk subscriptions</h2>
          <p className="mt-3 text-muted-foreground">
            The full reseller workflow — catalog, photograph, draft, list, sell,
            ship, reconcile — with grading built in.
          </p>
          {/* US-2514: monthly/annual. The prices were already in
              FLIPDESK_PLANS and on both in-app billing pages; a logged-out
              visitor had no way to see the annual ones. */}
          <div
            className="mt-6 inline-flex rounded-lg border p-1"
            role="group"
            aria-label="Billing interval"
          >
            {(["monthly", "yearly"] as const).map((iv) => (
              <button
                key={iv}
                type="button"
                onClick={() => setInterval(iv)}
                aria-pressed={interval === iv}
                className={
                  interval === iv
                    ? "rounded-md bg-brand-navy px-4 py-1.5 text-sm font-medium text-white dark:bg-foreground dark:text-background"
                    : "rounded-md px-4 py-1.5 text-sm font-medium text-muted-foreground hover:text-foreground"
                }
              >
                {iv === "monthly" ? "Monthly" : "Annual"}
              </button>
            ))}
          </div>
          <div className="mt-8 grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
            {FLIPDESK_ORDER.map((key) => {
              const plan = FLIPDESK_PLANS[key];
              return (
                <div
                  key={key}
                  className="flex flex-col rounded-lg border bg-background p-6"
                >
                  <h3 className="text-lg font-semibold">{plan.name}</h3>
                  <p className="mt-2 text-3xl font-bold text-brand-navy dark:text-foreground">
                    {dollars(priceFor(plan, interval))}
                    <span className="text-sm font-normal text-muted-foreground">
                      {interval === "yearly" ? "/yr" : "/mo"}
                    </span>
                  </p>
                  {/* US-2514: annual pricing existed in FLIPDESK_PLANS and on
                      both in-app billing pages, and was invisible to anyone who
                      had not signed up yet. */}
                  {interval === "yearly" && yearlySavingPct(plan) > 0 && (
                    <p className="mt-1 text-xs font-medium text-emerald-700 dark:text-emerald-400">
                      Save {yearlySavingPct(plan)}% vs monthly
                    </p>
                  )}
                  {/* US-2115: on a paid tile the price IS the point of sale, so
                      the renewal terms sit with it rather than only in the
                      legal pages. Free tiles have nothing to renew. */}
                  {priceFor(plan, interval) > 0 && (
                    <AutoRenewalDisclosure
                      className="mt-2"
                      amountCents={priceFor(plan, interval)}
                      interval={interval}
                      billingBegins="on-subscribe"
                    />
                  )}
                  {/* US-2483: the listing allowance, stated as its own line.
                      Every crosslisting tool a reseller is comparing us against
                      prices by listing volume — it is the first number they look
                      for, and ours was buried in a features bullet three lines
                      down. The value comes from activeListingCap, which is what
                      the edge actually enforces, so this can never become an
                      aspirational number the server does not grant. */}
                  <p className="mt-4 border-t pt-4 text-sm">
                    <span className="font-semibold text-foreground">
                      {formatListingAllowance(plan.activeListingCap)}
                    </span>{" "}
                    <span className="text-muted-foreground">
                      active listings
                      {plan.activeListingCap === -1 ? "" : " at a time"}
                    </span>
                  </p>
                  {/* US-1110: render the full feature list (sourced from
                      FLIPDESK_PLANS — the single source of truth) so Pro vs
                      Business differentiators (AutoLister, AI comp pulls,
                      scheduled actions, API, sub-accounts, reconciliation) are
                      visible instead of truncated. Each tier's features[]
                      already includes its listing cap + included grades. */}
                  <ul className="mt-4 flex-1 space-y-2 text-sm text-muted-foreground">
                    {plan.features.map((f) => (
                      <li key={f} className="flex items-start gap-2">
                        <Check className="mt-0.5 h-4 w-4 flex-shrink-0 text-brand-navy dark:text-foreground" />
                        {f}
                      </li>
                    ))}
                  </ul>
                  {/* US-1889: every seller plan bundles tier-matched buyer
                      functions (US-1887). Show the included buyer suite so the
                      two-sided value is explicit. */}
                  {(() => {
                    const buyerPlan = BUYER_PLANS[SELLER_PLAN_BUYER_TIER[key]];
                    return (
                      /* US-2833: a DIVIDER, not a second card. This was a
                         rounded, dashed-bordered box inside the plan card — a
                         card in a card, which CLAUDE.md's craft floor bans and
                         impeccable's browser rule flags. A top rule carries the
                         same grouping signal, keeps the existing dashed
                         treatment, and leaves one container where there were
                         two. */
                      <div className="mt-4 border-t border-dashed border-brand-navy/30 pt-3 dark:border-foreground/20">
                        <p className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-brand-navy dark:text-foreground">
                          <ShoppingBag className="h-3.5 w-3.5" />
                          Includes {buyerPlan.name} buyer tools
                        </p>
                        <ul className="mt-2 space-y-1 text-xs text-muted-foreground">
                          {buyerPlan.features.slice(0, 3).map((f) => (
                            <li key={f}>
                              • {f}
                              {isBulletComingSoon(f) && <ComingSoonBadge />}
                            </li>
                          ))}
                        </ul>
                      </div>
                    );
                  })()}
                  {/* US-2514: the point of sale. `?upgrade=<plan>` is the
                      deep-link US-940 already built — Billing opens its plan
                      picker on that plan. A signed-out visitor is routed through
                      login by ProtectedRoute and returned here afterwards,
                      because sanitizeReturnTo preserves the query string. */}
                  <Button
                    asChild
                    className="mt-5 w-full"
                    variant={key === "pro" ? "default" : "outline"}
                  >
                    <Link
                      to={
                        key === "free"
                          ? "/signup"
                          : `${BILLING_PATH}&upgrade=${key}`
                      }
                    >
                      {key === "free" ? "Start free" : `Choose ${plan.name}`}
                    </Link>
                  </Button>
                </div>
              );
            })}
          </div>
          <p className="mt-8 text-sm text-muted-foreground">
            New to grading? Start with{" "}
            <Link
              to="/how-it-works"
              className="font-medium text-brand-navy hover:underline dark:text-foreground"
            >
              how it works
            </Link>{" "}
            or read the{" "}
            <Link
              to="/faq"
              className="font-medium text-brand-navy hover:underline dark:text-foreground"
            >
              FAQ
            </Link>
            .
          </p>
        </div>
      </section>

      {/* Per-grade tiers */}
      <section className="px-6 py-16">
        <div className="mx-auto max-w-4xl">
          <h2 className="text-3xl font-bold">Pay-per-grade</h2>
          <p className="mt-3 text-muted-foreground">
            One-time grades, billed per item. Faster tiers carry a quicker
            service-level target.
          </p>
          <div className="mt-8 grid gap-6 sm:grid-cols-3">
            {GRADE_TIER_ROWS.map((tier) => (
              <div
                key={tier.key}
                className="rounded-lg border bg-background p-6"
              >
                <h3 className="text-lg font-semibold">{tier.label}</h3>
                <p className="mt-2 text-3xl font-bold text-brand-navy dark:text-foreground">
                  {dollars(tier.priceCents)}
                </p>
                <ul className="mt-4 space-y-2 text-sm text-muted-foreground">
                  <li className="flex items-center gap-2">
                    <Check className="h-4 w-4 text-brand-navy dark:text-foreground" />
                    {tier.slaHours}h service-level target
                  </li>
                  <li className="flex items-center gap-2">
                    <Check className="h-4 w-4 text-brand-navy dark:text-foreground" />
                    {tier.creditCost} credit{tier.creditCost > 1 ? "s" : ""} per
                    grade
                  </li>
                </ul>
                {/* US-2514: every price on this page now carries the action that
                    buys it. A per-grade tier is chosen inside the submission
                    flow, so that is where this lands; a signed-out visitor is
                    routed through login by ProtectedRoute and returned here,
                    because sanitizeReturnTo keeps the query string. */}
                <Button asChild variant="outline" className="mt-5 w-full">
                  <Link to={`${SUBMIT_PATH}?tier=${tier.key}`}>
                    Grade an item at {tier.label}
                  </Link>
                </Button>
              </div>
            ))}
          </div>

          {/* Credit packs */}
          <h3 className="mt-12 text-xl font-semibold">Credit packs</h3>
          <p className="mt-2 text-sm text-muted-foreground">
            Buy in bulk and save. Credits never expire.
          </p>
          <div className="mt-6 grid gap-4 sm:grid-cols-4">
            {CREDIT_PACKS.map((pack) => (
              <div
                key={pack.credits}
                className="rounded-lg border bg-background p-4 text-center"
              >
                <p className="text-2xl font-bold text-brand-navy dark:text-foreground">
                  {pack.credits}
                </p>
                <p className="text-xs text-muted-foreground">credits</p>
                <p className="mt-2 font-medium">{dollars(pack.priceCents)}</p>
                {/* US-2514: `?buy=credits` opens the credit-pack dialog on
                    arrival, so this tile does not just deposit the visitor on
                    Billing and leave them to find the button. */}
                <Button asChild variant="outline" size="sm" className="mt-3 w-full">
                  <Link to={`${BILLING_PATH}&buy=credits`}>Buy</Link>
                </Button>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Buyer plans (US-1889) — standalone for non-sellers; included with any
          FlipDesk plan for sellers (tier-matched, US-1887). */}
      <section className="border-t bg-card px-6 py-16">
        <div className="mx-auto max-w-5xl">
          <h2 className="text-3xl font-bold">Buyer plans</h2>
          <p className="mt-3 text-muted-foreground">
            Shop secondhand with confidence — a second opinion on any listing's
            condition, condition-based alerts, and fit. Grade-locked purchase
            protection is on the way.{" "}
            <span className="font-medium text-foreground">
              Already sell with FlipDesk? These come included with your plan
            </span>{" "}
            (Starter &amp; Pro include Guard, Business includes Connoisseur) — no
            separate purchase.
          </p>
          <div className="mt-8 grid gap-6 sm:grid-cols-3">
            {BUYER_ORDER.map((key) => {
              const plan = BUYER_PLANS[key];
              return (
                <div key={key} className="flex flex-col rounded-lg border bg-background p-6">
                  <h3 className="text-lg font-semibold">{plan.name}</h3>
                  <p className="mt-2 text-3xl font-bold text-brand-navy dark:text-foreground">
                    {dollars(plan.priceMonthlyCents)}
                    <span className="text-sm font-normal text-muted-foreground">/mo</span>
                  </p>
                  {/* US-2115: same rule as the seller tiles above. */}
                  {plan.priceMonthlyCents > 0 && (
                    <AutoRenewalDisclosure
                      className="mt-2"
                      amountCents={plan.priceMonthlyCents}
                      interval="monthly"
                      billingBegins="on-subscribe"
                    />
                  )}
                  <ul className="mt-4 flex-1 space-y-2 text-sm text-muted-foreground">
                    {plan.features.map((f) => (
                      <li key={f} className="flex items-start gap-2">
                        <Check className="mt-0.5 h-4 w-4 flex-shrink-0 text-brand-navy dark:text-foreground" />
                        <span>
                          {f}
                          {isBulletComingSoon(f) && <ComingSoonBadge />}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              );
            })}
          </div>
        </div>
      </section>

      {/* Pricing FAQ */}
      <section className="border-t bg-card px-6 py-16">
        <div className="mx-auto max-w-2xl">
          <h2 className="text-center text-3xl font-bold">Pricing FAQ</h2>
          <dl className="mt-10 space-y-6">
            {PRICING_FAQS.map((faq) => (
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
                Start free
              </Button>
            </Link>
          </div>
        </div>
      </section>

      <MarketingCTA />
      <div className="px-6 pb-12 lg:px-12">
        <div className="mx-auto max-w-5xl">
          <HelpCategoryLink category="billing" label="Plans, credits, refunds and invoices, explained:" />
        </div>
      </div>

    </MarketingLayout>
  );
}
