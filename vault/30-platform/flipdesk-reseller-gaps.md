---
title: FlipDesk reseller gaps
type: reference
status: current
source_of_truth: vault
code_refs: []
reviewed: 2026-08-27
tags: [flipdesk, product, gaps]
summary: Where the reseller workflow still falls short of what a working seller needs.
---
# FlipDesk Reseller Feature Gap Triage (US-469)

**Audit date:** 2026-06-03 · **Triaged:** 2026-06-12 · **Re-baselined:** 2026-06-20 (US-1132), 2026-08-27 (US-2926) · **Owner:** FlipDesk

This document triages the reseller/store-management features that a power eBay
seller might expect but that FlipDesk does **not** fully handle today. It exists
so the team has one prioritized gap list, an explicit launch-scope decision for
each item, and a contract that the UI never *implies* an unhandled feature is
handled. Source-of-truth PRD: `FlipDesk_PRD_v1.docx`. (US-2094 archived the older
`ebay-flips-prd.md` as [[ebay-flips-prd]] — it is the superseded v1 draft and is
NOT a source of truth; its non-goals rule out the multi-tenant, multi-marketplace
product that actually shipped.)

> **2026-08-27 re-baseline (US-2926).** The 2026-06-20 note below is superseded.
> It recorded that the post-sale surfaces had *shipped*; this pass measured what
> they shipped *against eBay's actual API* and found whole surfaces missing.
> Closed by US-2927..US-2953:
>
> | Was missing | Now |
> |---|---|
> | **Item Not Received inquiries** — no reader at all. The webhook arrived, triggered a poll with no inquiry source, and the seller was told nothing. | `lib/ebay-inquiries.ts` + four routes + a poll source. |
> | **Money Back Guarantee cases** — zero implementation. The one post-sale event that costs a seller DEFECT was the one only visible in Seller Hub. | `lib/ebay-cases.ts` + five routes + evidence upload. |
> | **Mark return received** — never called, so eBay's clock ran on an item already back with the seller and ended in an automatic refund. | `markReturnReceived` + a state-gated action. |
> | **Return shipping / tracking** — no way to see whether the buyer had actually posted it. | Read off the return DETAIL, not the label endpoint, so a buyer-supplied label still counts. |
> | **Nothing stored** — every return, dispute and offer was a live fetch, so no history, no deadline, no analytics. | `marketplace_post_sale_cases` (00675), `marketplace_offers` (00676), `marketplace_promotions` (00677). |
> | **Auto-counter** — the offer engine could accept, decline or skip. Countering is where the money is. | `decideOffer` gained `counter`, ordered accept > counter > decline. |
> | **CPC keywords** — Promoted Listings Advanced ran with no keyword management, which is its only lever. | `lib/ebay-keywords.ts`, with negative-keyword candidates from the seller's own reported search terms. |
> | **Campaign lifecycle and bulk ads** — a seller could start a campaign here and had to finish it in Seller Hub. | pause/resume/end/clone + bulk create/update with per-listing results. |
> | **Promotion lift** — nothing measured whether a sale sold more. | `computeLift`, comparing the promotion window to the equal window before it. |
> | **Ad fees in the money view** — profit was reported BEFORE advertising. | `lib/ad-spend.ts`, attributed per order. |
> | **Store follower email** — the cheapest channel a seller owns was unreachable. | `lib/ebay-email-campaigns.ts`; every send is a human action. |
>
> Item **#6 (combined shipping / order-level discounts)** in the table below is
> still the only original gap that remains out of scope, and the rationale there
> is unchanged.
>
> **2026-06-20 re-baseline (US-1132):** The original guiding principle — keep
> post-sale negotiation/dispute surfaces in eBay Seller Hub for launch — has been
> **superseded**. Best Offer responses, send-offer, the buyer-message inbox,
> returns/cancellations decisions, payment-dispute handling, and Promoted-Listings
> rate push have all since **shipped** inside FlipDesk. The only item from the
> original list still genuinely out of scope is **combined-shipping / order-level
> discounts** (#6). The sections below are updated to match the shipped code; do
> not treat the pre-launch "defer to Seller Hub" framing as current.

---

## 1. Prioritized gap list

Priority key: **P1** = expected by most sellers · **P2** = nice-to-have ·
**P3** = niche / low demand. Status reflects shipped code as of 2026-06-20.

| # | Gap | Status today | Priority |
|---|-----|--------------|----------|
| 1 | **Best Offer — respond to incoming offers** (accept / decline / counter) | ✅ **Shipped.** `GET /negotiation/offers` + `POST /negotiation/offers/:bestOfferId/respond` (accept/decline/counter) via the eBay Negotiation API; UI in `src/pages/flipdesk/offers.tsx`. (US-673) | P1 |
| 2 | **Returns / cancellations workflow** (approve, refund, RMA, cancel) | ✅ **Shipped.** `GET /returns`, `POST /returns/:id/decide`, `POST /returns/:id/refund`, `GET /cancellations`, `POST /cancellations/:id/approve|reject`, plus payment-dispute handling (`useEbayPaymentDisputes`/`useEbayResolveDispute`/`useEbayAddDisputeEvidence`); UI in `src/pages/flipdesk/post-sale.tsx`. | P1 |
| 3 | **Buyer messages / inbox** | ✅ **Shipped.** `GET /messages` + `POST /messages/:messageId/reply`; inbox UI in `offers.tsx` (`useEbayMessages`/`useEbayReplyMessage`). (US-673) | P2 |
| 4 | **Promoted Listings — push ad rate to eBay** | ✅ **Shipped (manual / at-publish).** `ebay-marketing.ts` find-or-creates the seller's COST_PER_SALE campaign and pushes a real `bidPercentage` via the eBay Marketing API at publish (`attachPromotionAtPublish`) and via a manual update route (`flipdesk-ebay.ts` `updateAdRateForListing`). (US-561) ⚠️ The **automation** `set_promo_rate_pct` action is still local-only (`flipdesk-automations.ts` ~L288 updates `listings.promo_rate_pct` only) and the UI honestly says so. | P2 |
| 5 | **Send Offer to Watchers / interested buyers** | ✅ **Shipped.** `GET /negotiation/eligible` + `POST /negotiation/send-offer` send a discount offer to interested buyers. (US-673) | P2 |
| 6 | **Combined-shipping / order-level discounts** | ❌ **Not built.** No combined-shipping or order-discount handling exists in the edge service or UI. | P3 |

---

## 2. Scope decisions

### Best Offer responses — **Shipped**
Incoming offers are retrieved and can be accepted / declined / countered from the
Offers page. The original deferral rationale (Negotiation API + inbox UI +
notification path) was implemented under US-673. The natural next increment —
auto-accept / auto-decline-by-margin tied to the margin-floor automation — is
**not** built and remains a candidate enhancement.

### Returns & cancellations — **Shipped**
Returns and cancellations can be decided (approve/decline/refund/approve-cancel/
reject-cancel) from the Post-sale page, and payment disputes can be resolved /
have evidence attached. Outcomes still flow into P&L/reconciliation. Returns
ingestion reliability remains tracked under US-471/US-472.

### Combined-shipping / order discounts — **Deferred (still out of scope)**
- **Not in:** combined-shipping invoices or order-level discounts.
- **Rationale:** low demand for the single-item, condition-graded apparel that is
  FlipDesk's core; multi-item-cart mechanics are a sizeable surface.
- **Re-evaluate when:** sellers report bundling/lot sales as a real friction.

---

## 3. UI honesty audit

**Re-verified 2026-06-20.** The features previously listed as "honest because no
control exists" are now backed by real endpoints, so the controls are legitimate:

- **Best Offer / send-offer / messages** (`offers.tsx`): accept/decline/counter,
  send-offer, and reply-to-message all call live eBay endpoints.
- **Returns / cancellations / disputes** (`post-sale.tsx`): all actions call live
  eBay Post-Order / dispute endpoints.
- **Promoted Listings:** rate push to eBay is wired at publish and via the manual
  ad-rate route (`ebay-marketing.ts`). The **automation** `set_promo_rate_pct`
  action remains local-only, and `automations.tsx` (~L354) still honestly says
  *"Tracked in FlipDesk for now — the rate isn't pushed to eBay Promoted Listings
  yet."* — that copy is accurate for the automation path; leave it until the
  automation executor calls the Marketing API.
- **Combined-shipping / order discounts:** no control exists anywhere, so nothing
  implies the one remaining unhandled feature is handled.

**Standing contract (unchanged):** do **not** add a control for a deferred feature
(currently only combined-shipping / order discounts) without wiring it to a real
backend, or it violates the UI-honesty rule that CLAUDE.md depends on.

---

## 4. Deferred / out-of-scope

Only one item from the original triage remains out of scope:

1. Combined-shipping and order-level discounts (#6).

Everything else originally listed here has shipped (see §1). When combined-shipping
is promoted into scope, file a new story (do not append it here).

## Related

- [[flipdesk-dogfood]] — gaps found by actually running the pipeline
- [[cross-listing]] — channel coverage is one of the gaps
- [[INDEX]]
