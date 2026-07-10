import { Link } from "react-router-dom";
import { Check, ShoppingBag } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  MarketingLayout,
  MarketingCTA,
} from "@/components/marketing/marketing-layout";
import {
  GRADETHREAD_TIERS,
  CREDIT_PACKS,
  FLIPDESK_PLANS,
  BUYER_PLANS,
  SELLER_PLAN_BUYER_TIER,
  type BuyerPlanKey,
} from "@/lib/constants";
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

const GRADE_TIER_ROWS = [
  { key: "standard" as const, ...GRADETHREAD_TIERS.standard },
  { key: "premium" as const, ...GRADETHREAD_TIERS.premium },
  { key: "express" as const, ...GRADETHREAD_TIERS.express },
];

const FLIPDESK_ORDER: FlipdeskPlanKey[] = ["free", "starter", "pro", "business"];
const BUYER_ORDER: BuyerPlanKey[] = ["free", "guard", "connoisseur"];

export function PricingPage() {
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
            One account, both sides of the closet. GradeThread is free to start —
            every account gets{" "}
            {FLIPDESK_PLANS.free.includedStandardGradesPerMonth} Standard grades
            a month at no cost. Pay per grade (from{" "}
            {dollars(GRADETHREAD_TIERS.standard.priceCents)}), buy credit packs
            that never expire, subscribe to FlipDesk to run your whole reseller
            workflow, or take a buyer plan to shop secondhand with confidence.
            Every FlipDesk plan includes buyer tools, so sellers get both. No
            setup fees, change plans anytime.
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

      {/* Per-grade tiers */}
      <section className="border-t bg-card px-6 py-16">
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
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* FlipDesk subscriptions */}
      <section className="px-6 py-16">
        <div className="mx-auto max-w-5xl">
          <h2 className="text-3xl font-bold">FlipDesk subscriptions</h2>
          <p className="mt-3 text-muted-foreground">
            The full reseller workflow — catalog, photograph, draft, list, sell,
            ship, reconcile — with grading built in.
          </p>
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
                    {dollars(plan.priceMonthlyCents)}
                    <span className="text-sm font-normal text-muted-foreground">
                      /mo
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
                      <div className="mt-4 rounded-md border border-dashed border-brand-navy/30 p-3 dark:border-foreground/20">
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
    </MarketingLayout>
  );
}
