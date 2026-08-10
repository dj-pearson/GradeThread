---
title: The buyer product is a second tenant of every seller mechanism
type: learning
status: current
source_of_truth: vault
code_refs:
  - services/edge-functions/src/routes/webhooks.ts
  - services/edge-functions/src/routes/payments.ts
  - services/edge-functions/src/lib/renewal-notice-copy.ts
  - services/edge-functions/src/lib/appstore/precedence.ts
reviewed: 2026-08-10
tags: [buyer, billing, parity, agent, quality]
summary: Ten defects in one day, all the same shape — a control built for FlipDesk, reused for the buyer product as an early return. The checklist that finds the eleventh.
---

# The buyer product is a second tenant

On 2026-08-10 a single session found **ten** defects with one shape. Not ten
related bugs — ten instances of the same sentence:

> A control was built for the SELLER product. The buyer product got an early
> return instead.

They were in five different files, written by different people at different
times, and every one of them looked deliberate in review.

## The ten

| Where | What a buyer got |
|---|---|
| `/buyer/subscribe` in-place change | charged a prorated amount on one click, no disclosure |
| `handleInvoiceUpcoming` | no advance renewal notice at all |
| `handleInvoicePaymentSucceeded` | no receipt |
| `handleInvoicePaymentFailed` / `…ActionRequired` | no dunning, no bank-challenge notice |
| `applyBuyerSubscriptionChange` | no purchase acknowledgement, no cancellation confirmation |
| `handleSubscriptionDeleted` | no audit row |
| `handleTrialWillEnd` | the SELLER's trial email — the inverse: confidently wrong rather than silent |
| `appstore.ts` verify | no audit row, no agreed-terms row |
| `/portal` return | returned to the seller billing page |
| `PastDueBanner` | nothing in the app, on any page |

Plus two that are the same shape one level up: buyer audit rows read as seller
signals by the reconciler, and no admin surface reading a buyer column at all.

## Why it keeps happening, and it is not carelessness

**The early return is usually CORRECT.** `if (invoiceIsBuyer(invoice)) return;`
guards the seller cycle resets, the dunning transition and the plan columns —
all of which genuinely must not run for a buyer invoice. The bug is never the
return. It is that something which was *not* seller-specific had been written
inside the region the return protects.

So the reviewer sees a guard with a good reason, and the reason is true.

**The comments make it worse.** One skip said *"so a buyer doesn't get a
seller-shaped email."* An honest statement of intent whose consequence — silence
— nobody re-read. Another said the buyer path *"is carried by
subscription.updated"*, which is true of the STATUS and false of the EMAIL
sitting three lines below it.

**Half a feature working hides the other half.** Buyer charges show in the admin
tools, because charges are listed customer-wide. So the money half of a support
call worked while the state half was blank — and a gap that breaks half a
workflow is a gap nobody reports.

## The checklist

Before shipping anything that touches the seller subscription:

1. **Does the buyer product have this?** Not "is it guarded" — *does the
   equivalent exist somewhere*. Name the file.
2. **If there is an early return, what is BELOW it that is not seller-specific?**
   Notices, audit rows, receipts and agreements almost never are.
3. **Split the send out; do not widen the skip.** Threading `isBuyer` past every
   write below is how a buyer's renewal resets a seller's quota. One missed
   branch is worse than the bug being fixed.
4. **Product is a PARAMETER, never inferred.** A person can hold both and be
   past_due on one. Inferring shows the alarm in the app where they cannot act
   on it, with a button to the wrong page.
5. **Copy: is the sentence true of the buyer product?** "Thanks for going pro"
   and "your saved items stay available" were both false — the second one
   materially, because the Free caps come back.
6. **Does the guard name a route, or find them?** Every one of these survived a
   guard that named the seller path. Derive the set from the source.

## The enum trap, four times

`flipdesk_subscription_events.from_plan` / `to_plan` are typed
`public.flipdesk_plan` (`00037`). Buyer tiers are `public.buyer_plan` (`00402`).
Writing `to_plan: "guard"` raises **22P02** — and every one of these inserts is
best-effort by design, so the row silently never appears while the charge goes
through. Put buyer plans in `raw_payload`, which is `jsonb`.

Namespace the `event_type` too (`buyer.`), or the reconciler reads a buyer
cancellation as a seller one — see US-2457 in the backlog.

## Related

- [[buyer-platform]] — what the buyer product actually is
- [[subscription-copy-review-register]] — every billing sentence, and who wrote it
- [[structural-guards]] — why the guards that should have caught these did not
- [[shipped-but-unwired]] — the sibling failure: built, never called
- [[INDEX]]
