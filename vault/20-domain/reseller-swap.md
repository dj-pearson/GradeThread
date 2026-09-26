---
title: Reseller Swap - stale stock matched to sellers who move it
type: contract
status: current
source_of_truth: vault
code_refs:
  - services/edge-functions/src/routes/flipdesk-swap.ts
  - services/edge-functions/src/lib/reseller-swap.ts
  - services/edge-functions/src/lib/ebay-affiliate.ts
  - supabase/migrations/00847_reseller_swap.sql
  - src/components/flipdesk/reseller-swap-card.tsx
reviewed: 2026-09-26
tags: [flipdesk, sourcing, ebay, privacy, affiliate]
summary: Seller A's stale eBay listing is shown as a tip to seller B, whose own sales say B sells that brand fast; B buys on eBay, and GradeThread is never a party to the sale.
---
# Reseller Swap

A reseller's listing that has sat for months often belongs in a different
reseller's store, because buyers follow stores, not items. FlipDesk already
knows which brands each seller moves and how fast, so it can point one seller's
stuck listing at another seller who sells that brand quickly. US-3541.

## The rule that shapes everything: we are not the marketplace

The owner decided GradeThread must not act as a marketplace or middleman. So:

1. **The sale happens on eBay.** A tip is a link to the other seller's existing
   eBay listing. eBay takes the payment, issues the label, collects sales tax,
   files the 1099-K and settles disputes. We never hold money, set a price,
   hold an item or take a fee from either seller.
2. **No per-trade fee from sellers.** The feature is part of the subscription.
3. **The only money per sale is an eBay Partner Network commission**, paid by
   eBay out of its own side when `EBAY_EPN_CAMPAIGN_ID` is set. It does not
   change the buyer's price or the seller's payout. The UI says so in plain
   words next to the tips (FTC disclosure) and marks the link `rel="sponsored"`.
   Unset means plain links and the feature works the same.

Changing any of these three turns the feature into something a lawyer has to
look at again. The Terms of Service section for it should be read by counsel
once before launch.

## Consent

- Two switches, both **off by default**, stored in `reseller_swap_settings`:
  `share_stale` (my stuck listings may be shown) and `receive_tips` (show me
  others'). Either works without the other.
- Only the account owner or an admin may change them (`requireWorkspaceRoleForWrites("admin")`
  on `/api/flipdesk/swap/settings`), because sharing is about the owner's stock.
- "Stuck" is each sharer's own `stale_after_days`, 14 to 365, default 60.

## Privacy

- A tip carries only what the public eBay listing already shows: title, brand,
  size, price, one listing photo (front, flatlay, on-model or on-hanger roles
  only, never `internal` or `tag`), days listed, and the public grade.
- A tip **never** carries the sharer's user id, cost, profit or sales numbers.
  `reseller-swap_test.ts` pins the tip's exact key set.
- The "fit" line on a tip ("you sold 6 of this brand, usually in 9 days") is the
  VIEWER's own numbers. Nobody's sales numbers are shown to anyone else.
- Dismissing a tip is accepted only for a live shared tip; any other id answers
  404 exactly like an unknown id, so the endpoint cannot probe whether an item
  exists. Case in `tenant-isolation_test.ts`.

## Matching

- Fit window 180 days. A brand counts when the viewer sold at least 2 of it and,
  where listing dates exist, the median days from listing to sale is 30 or less.
- Brands match after folding case and punctuation (`Levi's` = `LEVIS`).
- Candidates: active eBay listings of sharing sellers past the sharer's own stale
  line, item not sold or archived, with a URL that is a real ebay.com `/itm/`
  link (anything else is rebuilt from the item id or dropped).
- Order: the viewer's volume in that brand, then their speed, then oldest first.
  At most 20 tips.

## Known limits of v1

- Matching runs on read with capped queries (5,000 sharers, 1,500 candidate
  listings). Fine while the network is small; a nightly precompute is the next
  step if it grows.
- eBay only. Other platforms can join once their listings carry a reliable
  public URL.

Related: [[thrift-radar]] (the Radar page this lives on).
