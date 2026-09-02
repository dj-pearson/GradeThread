---
title: Creator affiliate programme — terms
aliases: [creator terms, partner terms, creator programme]
type: contract
status: current
source_of_truth: vault
code_refs:
  - src/lib/constants.ts
  - services/edge-functions/src/routes/affiliate.ts
  - supabase/migrations/00719_creator_affiliate_programme.sql
reviewed: 2026-09-01
tags: [affiliate, creator, growth, contract, legal]
summary: The terms a reseller creator accepts to earn cash commission, and the version string the code records against each acceptance.
---
# Creator affiliate programme — terms

The cash programme decided in [[adr-referral-cash-payout]] section 6. **This is
not the referral programme every seller has.** A user who shares a referral link
earns grade credits and is never paid cash; a creator who accepts these terms and
is admitted by GradeThread earns a percentage of subscription revenue. The two
are separate rows, separate consent, separate money — see [[pricing]] for the
numbers.

**Version:** `2026-09-01`. The version is recorded on every acceptance
(`affiliate_accounts.creator_terms_version`), so a later revision can tell who
agreed to which text. **Changing the terms below means changing
`CREATOR_AFFILIATE.termsVersion` in `src/lib/constants.ts` in the same commit**;
`src/test/creator-affiliate.test.ts` fails otherwise.

## The terms

1. **Who this is for.** Creators who publish reselling content and want to be
   paid for accounts they bring to FlipDesk. Acceptance is an application.
   GradeThread admits creators one at a time and may decline without reason.

2. **What is earned.** 25% of the subscription revenue GradeThread actually
   collects from each referred account, for 12 months from that account's first
   paid invoice, capped at $250 per referred account. Percentages outside the
   20-30% band are not honoured. Nothing is earned on grades, credit packs,
   marketplace fees, refunds, chargebacks or tax.

3. **Attribution.** 30-day last-touch on the creator's own link
   (`src/lib/affiliate.ts`). An account already subscribed, an account that
   arrived through another creator more recently, and a creator's own account
   earn nothing. Self-referral is refused at the database.

4. **When it is paid.** A commission is held 60 days from the invoice that
   earned it (the billing-error window in the refund policy), then batched into
   a monthly payout over Stripe Connect Express once the balance clears the
   minimum. GradeThread pays no commission on revenue it refunded or lost to a
   chargeback; such a commission is voided whether or not it has been paid.

5. **Tax.** No cash moves before a certified tax profile is on file (the W-9
   equivalent, `affiliate_tax_profiles`). US creators paid $600 or more in a
   calendar year are reported on a 1099. Creators are responsible for their own
   taxes; this is a commercial relationship, not employment.

6. **How a creator may promote.** Say what FlipDesk does and what it costs.
   Never claim a grade a garment did not receive, never present a GradeThread
   grade as an appraisal or an authentication, and never state a resale outcome
   as a guarantee. No paid search on GradeThread's own brand terms, no coupon or
   cashback sites, no unsolicited email, no automated posting, no incentivised
   signups that the referred seller does not know about, and no impersonation of
   GradeThread or its staff.

7. **What ends it.** Either side may end the arrangement at any time. A creator
   who breaks clause 6 forfeits unpaid commissions on the accounts affected.
   Commissions already earned in good faith survive ordinary termination and are
   paid on the normal schedule.

8. **Changes.** Terms may change with notice. A change applies to commissions
   accrued after it; the version recorded against an acceptance is the version
   in force for what came before.

> [!note] These are programme terms, not legal review
> The text above was written in the same commit as the code that records
> acceptance of it, so consent could not be recorded against nothing. It has not
> been through a lawyer. Before the programme is advertised or `mode` is flipped
> to `batched`, someone qualified should read clauses 4, 5 and 7.
