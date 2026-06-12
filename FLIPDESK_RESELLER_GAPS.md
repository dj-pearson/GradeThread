# FlipDesk Reseller Feature Gap Triage (US-469)

**Audit date:** 2026-06-03 · **Triaged:** 2026-06-12 · **Owner:** FlipDesk

This document triages the reseller/store-management features that a power eBay
seller might expect but that FlipDesk does **not** fully handle today. It exists
so the team has one prioritized gap list, an explicit launch-scope decision for
each item, and a contract that the UI never *implies* an unhandled feature is
handled. Source-of-truth PRDs: `FlipDesk_PRD_v1.docx`, `ebay-flips-prd.md`.

The guiding principle for v1 launch: FlipDesk owns the **source → list → sell →
reconcile** lifecycle. Post-sale *negotiation and dispute* surfaces (offers,
buyer messages, returns/cancellations) stay in eBay Seller Hub for launch and
are tracked here as deferred. We do **not** put non-functional buttons in the UI
for them.

---

## 1. Prioritized gap list

Priority key: **P1** = expected by most sellers, revisit first post-launch ·
**P2** = nice-to-have · **P3** = niche / low demand.

| # | Gap | What FlipDesk does today | Launch scope | Priority |
|---|-----|--------------------------|--------------|----------|
| 1 | **Best Offer — respond to incoming offers** (accept / decline / counter) | Can *enable* Best Offer on a listing at publish (`best_offer_enabled`), but cannot read or respond to buyer offers. | **Out of scope** — respond in Seller Hub. | P1 |
| 2 | **Returns / cancellations workflow** (approve, issue refund, RMA) | Read-only: `returned` status is ingested from order data and shown as a Listings tab; no action can be taken from FlipDesk. | **Out of scope** — manage in Seller Hub; FlipDesk reflects the outcome in P&L. | P1 |
| 3 | **Buyer messages / inbox** | None. | **Out of scope.** | P2 |
| 4 | **Promoted Listings — push ad rate to eBay** | Automations can set/track a `set_promo_rate_pct` value, but it is stored in FlipDesk only and **not** pushed to eBay. UI says so inline. | **Out of scope** (tracked-only is intentional). | P2 |
| 5 | **Send Offer to Watchers** | Watcher *counts* are synced and can trigger a price-drop automation; cannot send a direct offer to watchers. | **Out of scope.** | P2 |
| 6 | **Combined-shipping / order discounts** | None. | **Out of scope.** | P3 |

---

## 2. Scope decisions (required by AC#1)

### Best Offer responses — **Deferred (out of scope for launch)**
- **In today:** enabling Best Offer on a listing at publish time only.
- **Not in:** retrieving incoming offers and accepting/declining/countering them.
- **Rationale:** responding to offers requires the eBay Negotiation API plus an
  offer inbox UI and notification path — a sizeable surface for a flow sellers
  already do comfortably in Seller Hub/the eBay app, often on mobile. Not worth
  blocking launch.
- **Re-evaluate when:** auto-accept/auto-decline-by-margin would meaningfully
  reduce seller toil (pairs naturally with the existing margin-floor automation).

### Returns & cancellations — **Deferred (out of scope for launch)**
- **In today:** the `returned` lifecycle status is ingested and surfaced as a
  read-only Listings tab; returns are reflected in P&L/reconciliation once the
  order data lands.
- **Not in:** approving/denying returns, issuing refunds, or cancelling orders
  from inside FlipDesk.
- **Rationale:** money-movement and dispute actions carry policy/financial risk
  and require the eBay Post-Order API + careful idempotency. Reflecting the
  outcome in P&L (which we do) covers the bookkeeping need without owning the
  decision. Returns ingestion reliability is tracked separately under US-471/US-472.
- **Re-evaluate when:** post-launch, after order/return webhook ingestion
  (US-471) is proven reliable end-to-end.

---

## 3. UI honesty audit (AC#2)

Verified 2026-06-12 — **no UI element implies an unhandled feature is handled:**

- **Promoted Listings** (`src/pages/flipdesk/automations.tsx`): the
  `set_promo_rate_pct` action shows the inline note *"Tracked in FlipDesk for
  now — the rate isn't pushed to eBay Promoted Listings yet."*
- **Best Offer** (`src/pages/flipdesk/autolister-bulk-edit.tsx`, publish dialog):
  the only control is **enable** Best Offer on a listing. There is no
  accept/decline/counter UI anywhere, so nothing implies offer handling.
- **Returns** (`src/pages/flipdesk/listings.tsx`): the `returned` tab is a status
  filter with read-only empty copy (*"Returned orders will be tracked here."*).
  No approve/refund/cancel actions are presented.
- **Watchers** (`listing-performance.tsx`, `automations.tsx`): exposed only as a
  read-only metric and a price-drop automation trigger. No "send offer to
  watchers" control exists.
- **Messages / inbox:** no buyer-messaging surface exists in the FlipDesk nav or
  any page, so nothing to mislabel.

**Outcome:** no code change required for AC#2 — the surfaces audited are already
honest. This section is the standing contract: do **not** add a control for any
deferred feature above without wiring it to a real backend, or it violates AC#2.

---

## 4. Deferred / out-of-scope for launch (AC#3)

The following are explicitly **out of scope for v1 launch** and are expected to
be performed in eBay Seller Hub (or the eBay mobile app):

1. Responding to Best Offers (accept / decline / counter).
2. Returns and cancellations workflow (approve, refund, RMA, cancel order).
3. Buyer messaging / inbox.
4. Pushing Promoted Listings ad rates to eBay (FlipDesk tracks the rate only).
5. Send Offer to Watchers.
6. Combined-shipping and order-level discounts.

Each will be re-triaged post-launch against real seller demand. New stories
should be filed (not appended here) when any item is promoted into scope.
