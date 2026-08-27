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
  - src/test/legal-page-dates-and-crossrefs.test.ts
reviewed: 2026-08-27
tags: [legal, billing, subscriptions, compliance, counsel]
summary: Every place GradeThread tells a customer about a recurring charge, its ending, or where their data goes — who drafted the wording, and whether counsel has seen it.
---

# Subscription copy review register

> **The operator kill switch cannot suppress any of this (US-2854).**
> `deliverEmail()` checks `emailCategoryDisabled()` before anything else, and
> a disabled category is a terminal no-op that neither retries nor queues.
> `emailCategoryDisabled()` refuses the protected categories by name — auth,
> receipts, payment failures — so nothing an operator can switch off removes
> a disclosure counsel has signed off on. If a category is ever added to this
> register, check it is on that protected list before assuming the same.

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
| iOS paywall footer, interval-aware | `ios/GradeThread/Billing/PaywallView.swift` | agent-drafted, pending review |
| Android paywall, interval-aware | `paywall_renewal_monthly` / `paywall_renewal_yearly` in `android/app/src/main/res/values/strings.xml` (+ `values-es`) | **agent-drafted 2026-08-12, pending review — US-2126** |

One function, four surfaces (pricing page, plan picker, 402 paywall, buyer
billing), plus the in-place upgrade dialog.
`src/test/subscription-disclosure-coverage.test.ts` fails if a component that
calls a subscribe hook does not render it, so a new purchase surface inherits
the disclosure rather than needing to remember it.

> [!warning] The web coverage test cannot see the mobile paywalls
> `subscription-disclosure-coverage.test.ts` scans `src/` only. Android shipped
> Play Billing with a live purchase button and **no disclosure at all** until
> US-2126 on 2026-08-12, and nothing failed — the guard structurally could not
> reach it. The same blind spot covers iOS. Until a cross-client equivalent
> exists, a new mobile purchase surface inherits nothing, and this table is the
> only record that the mobile copy exists.
>
> The mobile wording differs from the web's five-part text on one point that is
> not a drafting choice: the store, not GradeThread, takes the payment and owns
> the cancel route, so it names Google Play / the App Store rather than a
> GradeThread billing page. Counsel should confirm that satisfies ARL's
> how-to-cancel requirement, since the seller cannot cancel a Play subscription
> from inside our app at all.

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

> [!warning] A "cancellation" email that is NOT in this register
> `sendCancellationRequestedEmail` (US-2560) was added to the same file on
> 2026-08-14 and is deliberately absent from the table above. It tells a SELLER
> that a BUYER asked to cancel an eBay ORDER — no recurring charge, no plan, no
> renewal terms, nothing counsel's subscription review covers.
>
> It is recorded here anyway, because `email.ts` now holds two functions whose
> names both read as "cancellation" and only one of them is subscription copy.
> Anyone grepping this file for cancellation wording during a redline will find
> both, and the wrong conclusion is cheap in either direction: adding an order
> notice to a legal review wastes counsel's time, and mistaking it for one that
> HAS been reviewed is worse. The test is whether the copy describes money
> recurring. This one does not.

> [!note] The started email is the one to read first
> It is the only place outside `auto-renewal-copy.ts` that states the full
> renewal terms in prose, so it carries the same obligations as the on-screen
> disclosure and can drift from it independently. `subscription-ack-disclosure_test.ts`
> pins its five requirements, including that its cancellation link reaches the
> actual flow on **both** billing pages rather than merely a billing page.

## Privacy — the Claude connector data flow (US-9127 AC4)

> **Added 2026-08-19. Agent-drafted, counsel has NOT seen it, and it is on a
> different page from everything above** — which is why it is here rather than
> assumed to be covered by the subscription review.

| Where | What it asserts | Status |
|---|---|---|
| `src/pages/legal/privacy.tsx` §5 "The Claude connector" | The seller connects their OWN Claude account; Anthropic is **not** our subprocessor for this flow; connector data is retained under Anthropic's standard policy because the MCP connector is not eligible for zero-data-retention; no photos cross this path; every call is audited for 400 days; the seller can grant read-only and revoke immediately | **agent-drafted 2026-08-19, pending review** |

**The claim most worth a lawyer's eye** is the subprocessor distinction. Section
4 says we send photos to Anthropic under our contract. Section 5 says the
connector conversation is the seller's and is governed by *their* agreement with
Anthropic. That distinction is factually right about how the code works — the
seller's own Claude client calls us, we answer, and we hold no contract covering
what happens in their conversation — but whether it is the right way to *frame*
the responsibility is a determination, not an engineering fact.

**The retention claim is sourced, not inferred.** Anthropic states the Messages
API MCP connector is not eligible for zero-data-retention arrangements. If that
changes, this paragraph is wrong in the direction that matters and should be the
first thing re-read.

**What was NOT changed, deliberately:** `subprocessors.tsx` still lists
Anthropic once, for grading. Adding a second row for the connector would assert
the subprocessor relationship section 5 says does not exist. If counsel decides
it does, the row and the paragraph change together.

## Terms and the AUP — the connector half (US-9127 AC4)

> **Added 2026-08-19. Agent-drafted, counsel has NOT seen it.** AC4 asks for the
> privacy policy **and** the ToS. Only the privacy half shipped in the first
> pass; this is the other half, plus the AUP, which is dated in lockstep with
> the Terms by `legal-extension-disclosure-parity.test.ts`.

| Where | What it asserts | Status |
|---|---|---|
| `src/pages/legal/terms.tsx` §8 "The Claude connector" | An action taken through the connector is the seller's own action, on the same footing as doing it in FlipDesk; Claude is not our agent and we do not review the conversation; model output is an Output under §5 including the parts the seller never sees; a confirmation prompt is a safeguard rather than a judgment about the action; actions are metered monthly and additionally capped hourly and daily; access can be withdrawn on the same grounds as the API | **agent-drafted 2026-08-19, pending review** |
| `src/pages/legal/acceptable-use.tsx` §3, one added bullet | Do not defeat a confirmation step in front of an action that spends money or reaches a marketplace, including by scripting a connector client to approve its own requests | **agent-drafted 2026-08-19, pending review** |

**The claim most worth a lawyer's eye** is "actions taken through the connector
are your actions." It is the sentence the whole safety design rests on, and it
is doing work the privacy policy cannot do: the privacy page says where data
goes, this says who is answerable when a listing goes live at the wrong price.
The engineering facts behind it are solid — a confirm token proves the payload
did not change, >25% price moves are refused even when confirmed, and every call
is audited — but whether that allocation of responsibility survives a consumer
claim is a determination.

**The safeguard sentence is deliberately weak.** "Confirmation prompts are a
safeguard, not a review" exists so the confirm step cannot be read as a promise
that we checked the action. Strengthening it into a promise would be the drafting
mistake here, not the cautious wording.

**What was NOT changed, deliberately:**

- **The OAuth consent screen carries no link to the Terms or the AUP.** It is
  server-rendered from the edge and links to neither. The extension's clickwrap
  does link out, and that link is the reason AUP §6 exists at all. Whether the
  connector's approval screen needs the same is a decision, not a typo, so it is
  recorded here rather than changed.
- **AUP §6 stayed about the browser extension**, and the connector got a bullet
  in §3 rather than a section of its own. The extension needed its own section
  because a consent gate pointed at it. Until the connector's consent screen does
  the same, one precise prohibition beats a second section restating the Terms.

**A cross-reference was broken and is now fixed.** Inserting privacy §5 shifted
every later section by one, and AUP §6 still said "Section 6 of our Privacy
Policy" for extension data handling — which had become "Public grade
certificates". `src/test/legal-page-dates-and-crossrefs.test.ts` now resolves
every cross-page "Section N" reference against the target page's real headings,
and pins each legal page's rendered effective date to the `<lastmod>` the sitemap
advertises for it. Both halves were proved to FAIL against the un-fixed files
before being trusted.

## Claim audit — 2026-08-10

Counsel reviews the **wording**. Nobody had checked whether the **claims** were
true of the product, and every guard on these templates is structural (which
branch, which product) — structure cannot see a false sentence.

Each promise below was traced to the code that would have to honour it. Two
failed. Re-run this whenever a plan cap or a cancellation path changes.

| Claim | Checked against | Verdict |
|---|---|---|
| buyer: saved items and certificates "all stay available" after cancelling | `BUYER_PLANS` caps + `condition-alerts.ts` `entitledSearchIds` | ❌ **false** — rows are kept, but only the cap-oldest alerts still fire, and certificates are the seller's artifact. Rewritten. |
| buyer: "thanks for going pro" on the welcome | the buyer product sells buyer tools, not a Pro tier | ❌ **wrong framing** — seller language on a buyer's first message. Rewritten. |
| both: cancelling "keeps your plan active until the end of the period you've paid for" | `POST /api/payments/buyer/cancel` and the seller equivalent both set `cancel_at_period_end: true` | ✅ true |
| both: "no cancellation fee and no need to contact us" | both cancel paths are self-serve; no fee exists anywhere in the plan configs | ✅ true |
| both: "after several failed attempts your plan will drop to Free" | `handleSubscriptionDeleted` resets `buyer_plan` / `flipdesk_plan` to `free` | ✅ true |
| bank challenge: "this one won't retry on its own" | Stripe does not auto-retry a `requires_action` invoice; the hosted page is the only remedy | ✅ true |
| buyer: the welcome's "cancel anytime" link reaches the cancellation control | `src/pages/buyer/billing.tsx` consumes `?cancel=1` and focuses the button | ✅ true, wired the same day |

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
