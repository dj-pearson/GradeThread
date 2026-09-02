import { Link } from "react-router";
import { ArrowRight, Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { MarketingLayout, MarketingCTA } from "@/components/marketing/marketing-layout";
import { CREATOR_AFFILIATE } from "@/lib/constants";

// US-9212: the creator programme's public page.
//
// Every number on it comes from CREATOR_AFFILIATE, which mirrors
// vault/50-business/pricing.md and the edge's default config, so the page
// cannot advertise a rate the ledger does not pay. The terms summarised here
// are vault/50-business/creator-affiliate-terms.md; the version string is on
// the constant, and src/test/creator-affiliate.test.ts fails when they drift.
//
// The page does not say cash is available today. The programme ships with
// payouts off, and admission is by application, both of which it states.

const TERMS: Array<{ heading: string; body: string }> = [
  {
    heading: "What you earn",
    body:
      `${CREATOR_AFFILIATE.commissionPct}% of the subscription revenue we actually collect from each ` +
      `account you refer, for ${CREATOR_AFFILIATE.windowMonths} months from their first paid invoice, ` +
      `up to $${CREATOR_AFFILIATE.capUsd} per account. Nothing is earned on grades, credit packs, refunds or tax.`,
  },
  {
    heading: "How it is tracked",
    body:
      "Your own link, 30-day last-touch. An account that was already subscribed, one that arrived " +
      "through another creator more recently, and your own account earn nothing.",
  },
  {
    heading: "When you are paid",
    body:
      `Each commission is held ${CREATOR_AFFILIATE.holdDays} days from the invoice that earned it, ` +
      "then batched into a monthly Stripe payout once your balance clears the minimum. Revenue we " +
      "refund or lose to a chargeback is voided.",
  },
  {
    heading: "Tax",
    body:
      "No money moves before your tax details are on file. US creators paid $600 or more in a " +
      "calendar year get a 1099. You are a partner, not an employee.",
  },
  {
    heading: "How you may promote it",
    body:
      "Say what FlipDesk does and what it costs. Never claim a grade a garment did not get, never " +
      "call a grade an appraisal or an authentication, and never promise a resale outcome. No paid " +
      "search on our brand terms, no coupon sites, no unsolicited email, no automated posting.",
  },
];

export function PartnersPage() {
  return (
    <MarketingLayout
      title="Creator partner programme"
      description={
        `Reseller creators earn ${CREATOR_AFFILIATE.commissionPct}% of the subscription revenue from ` +
        `accounts they bring to FlipDesk, for ${CREATOR_AFFILIATE.windowMonths} months, up to ` +
        `$${CREATOR_AFFILIATE.capUsd} per account. Read the terms and apply.`
      }
      canonicalPath="/partners"
    >
      <section className="px-6 py-16 lg:py-20">
        <div className="mx-auto max-w-3xl">
          <h1 className="text-4xl font-bold tracking-tight sm:text-5xl">
            Get paid for the sellers you send us
          </h1>
          <p className="mt-6 text-lg text-muted-foreground">
            If you make reselling content, this is the arrangement: you send sellers to
            FlipDesk, and you keep {CREATOR_AFFILIATE.commissionPct}% of what they pay us
            for their first {CREATOR_AFFILIATE.windowMonths} months, up to $
            {CREATOR_AFFILIATE.capUsd} per account. Cash, not credits.
          </p>
          <p className="mt-4 text-muted-foreground">
            The referral link every GradeThread seller already has is a different thing. It
            earns grade credits and always will. This programme is separate, has its own
            terms, and you have to apply to it.
          </p>
          <div className="mt-8 flex flex-wrap gap-3">
            <Button asChild size="lg">
              <Link to="/referrals">
                Apply from your account <ArrowRight className="ml-2 h-4 w-4" />
              </Link>
            </Button>
            <Button asChild size="lg" variant="outline">
              <Link to="/flipdesk">See what FlipDesk does</Link>
            </Button>
          </div>
          <p className="mt-4 text-sm text-muted-foreground">
            Sign in, open Referrals, then the Creator tab. Accepting the terms applies to
            the programme; we admit creators one at a time.
          </p>
        </div>
      </section>

      <section className="border-t bg-card px-6 py-16">
        <div className="mx-auto max-w-3xl">
          <h2 className="text-2xl font-bold sm:text-3xl">The terms, in full</h2>
          <p className="mt-3 text-sm text-muted-foreground">
            Version {CREATOR_AFFILIATE.termsVersion}. We record which version you agreed
            to, so a later change applies only to what comes after it.
          </p>
          <dl className="mt-8 space-y-6">
            {TERMS.map((t) => (
              <div key={t.heading}>
                <dt className="font-semibold">{t.heading}</dt>
                <dd className="mt-1.5 text-muted-foreground">{t.body}</dd>
              </div>
            ))}
            <div>
              <dt className="font-semibold">Ending it</dt>
              <dd className="mt-1.5 text-muted-foreground">
                Either of us can stop at any time. Break the promotion rules and you forfeit
                unpaid commissions on the accounts affected. Anything earned in good faith is
                paid on the normal schedule.
              </dd>
            </div>
          </dl>
        </div>
      </section>

      <section className="border-t px-6 py-16">
        <div className="mx-auto max-w-3xl">
          <h2 className="text-2xl font-bold sm:text-3xl">Why this converts for you</h2>
          <ul className="mt-6 space-y-3">
            {[
              "FlipDesk is a subscription, so one seller who stays pays you every month of the window rather than once.",
              "The grade is the part your audience cannot get anywhere else: a published 1.0 to 10.0 condition scale with a certificate the buyer can check.",
              "Nothing here asks your audience to install something that scrapes another seller's closet. The extension works on their own account, signed in as them.",
            ].map((line) => (
              <li key={line} className="flex gap-3 text-muted-foreground">
                <Check className="mt-1 h-4 w-4 flex-shrink-0 text-brand-navy dark:text-foreground" />
                {line}
              </li>
            ))}
          </ul>
          <p className="mt-6 text-sm text-muted-foreground">
            Payouts run on Stripe and are switched on account by account as creators are
            admitted. If you are reading this before we have admitted you, apply anyway:
            applications are how the first creators get in.
          </p>
        </div>
      </section>

      <MarketingCTA
        heading="Apply to the creator programme"
        sub="Read the terms, accept them from your account, and we will come back to you."
      />
    </MarketingLayout>
  );
}
