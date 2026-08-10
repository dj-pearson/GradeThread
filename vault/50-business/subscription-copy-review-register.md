---
title: Subscription copy — what counsel needs to review, and who wrote it
type: contract
status: current
source_of_truth: code
code_refs:
  - src/lib/auto-renewal-copy.ts
  - services/edge-functions/src/lib/email.ts
  - services/edge-functions/src/tests/subscription-copy-register_test.ts
  - src/test/subscription-disclosure-coverage.test.ts
reviewed: 2026-08-10
tags: [legal, billing, subscriptions, compliance, counsel]
summary: Every place GradeThread tells a customer about a recurring charge or its ending, who drafted the wording, and whether counsel has seen it.
---

# Subscription copy review register

US-2114 is a review gate: the disclosure wording, the consent wording and the
retention period are legal determinations, and that story says plainly **do not
let an agent invent legal language.**

Copy shipped anyway. That was deliberate and the reason is on the record —
US-2115 found that showing *no* disclosure was the actual exposure, so agent-
drafted wording went live rather than nothing, gathered in as few places as
possible so a redline is cheap.

**This page is the inventory that gate needs.** A review is only as good as the
list handed to it, and a list kept in someone's memory is how the seventh email
gets written after counsel signs off on six.

> [!warning] Nothing here has been counsel-reviewed
> Every entry below is **agent-drafted, pending review**. There is no counsel
> record to cite for any of it. `subscription-copy-register_test.ts` fails any
> line in this file that claims review without naming a dated record.

## On-screen disclosure

| Where | Source | Status |
|---|---|---|
| The five-part auto-renewal disclosure rendered at every point of sale | `src/lib/auto-renewal-copy.ts` | agent-drafted, pending review |

One function, four surfaces (pricing page, plan picker, 402 paywall, buyer
billing), plus the in-place upgrade dialog.
`src/test/subscription-disclosure-coverage.test.ts` fails if a component that
calls a subscribe hook does not render it, so a new purchase surface inherits
the disclosure rather than needing to remember it.

The five things the wording must contain, designed to California's ARL as
amended by AB 2863: that it continues until cancelled; the recurring amount;
the frequency **in words**; the first-charge and/or renewal date; and how to
cancel.

## Email

All in `services/edge-functions/src/lib/email.ts`. Each now serves **two**
products — FlipDesk for sellers, GradeThread for buyers — through
`lib/renewal-notice-copy.ts`, so a redline applies to both at once.

| Template | What it says | Status |
|---|---|---|
| `sendSubscriptionStartedEmail` | the purchase acknowledgement; **restates the full renewal disclosure in prose** and deep-links the cancellation flow | agent-drafted, pending review |
| `sendRenewalReminderEmail` | advance notice before a renewal charge, with the amount, the date and how to cancel first | agent-drafted, pending review |
| `sendSubscriptionRenewalReceiptEmail` | the receipt after a renewal charge | agent-drafted, pending review |
| `sendSubscriptionCanceledEmail` | confirms a scheduled cancellation, the end date, and what is retained — **see the warning below** | agent-drafted, pending review |
| `sendPaymentFailedEmail` | dunning: update the card or the plan drops to Free | agent-drafted, pending review |
| `sendPaymentActionRequiredEmail` | a bank challenge is blocking the charge and nothing retries it | agent-drafted, pending review |

> [!warning] Retention is not availability, and the cancellation email got that wrong once
> Its first buyer version said saved items, past checks and certificates "all
> stay available". Nothing IS deleted — but the Free caps apply again from the
> end date, and `condition-alerts.ts` `entitledSearchIds` only matches a buyer's
> **cap oldest** active searches. A Connoisseur cancelling with 25 alerts keeps
> all 25 rows while 22 quietly stop firing. Certificates were worse: those are
> the seller's artifact, never the buyer's to keep. The copy now says the limits
> return, and `buyer-lifecycle-emails_test.ts` fails the phrase. **Any wording
> here that promises something survives must be checked against what the plan
> caps actually do to it.**

> [!note] The started email is the one to read first
> It is the only place outside `auto-renewal-copy.ts` that states the full
> renewal terms in prose, so it carries the same obligations as the on-screen
> disclosure and can drift from it independently. `subscription-ack-disclosure_test.ts`
> pins its five requirements, including that its cancellation link reaches the
> actual flow on **both** billing pages rather than merely a billing page.

## What the gate still owes (US-2114)

1. Review of all of the above, plus the consent mechanism and the cancellation
   flow.
2. A jurisdiction matrix — which state ARLs are in scope, and whether we design
   to a single strictest standard (recommended; there is no state-based logic
   anywhere in the product) or vary by billing address.
3. A determination on whether the 14-day no-card trial is an "automatic renewal
   or continuous service offer" under AB 2863. It lapses to Free rather than
   charging, which may or may not take it out of scope.
4. The consent-record retention period, before the retention work is built.

When any of that comes back, record it here with a date and update the status
column — that is what the register is for, and the test will then accept the
review claim.

## Related

- [[pricing]] — what the plans cost and why
- [[signup-consent-capture]] — how ToS acceptance is recorded, a separate consent
- [[data-retention]] — where the retention period will land
- [[INDEX]]
