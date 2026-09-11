---
title: Pooled sold comps — realized prices, contributed by consenting sellers
aliases: [pooled comps, pooled_comps_opt_in, realized sold prices, sold comp pool]
type: contract
status: current
source_of_truth: vault
code_refs:
  - supabase/migrations/00762_pooled_sold_comps_opt_in.sql
  - services/edge-functions/src/lib/sold-comps.ts
reviewed: 2026-09-10
tags: [comps, pricing, privacy, consent, contract]
summary: Every price GradeThread shows is an asking price, eBay has closed every route to realized ones, and the legitimate answer is the sellers' own orders - pooled opt-in, aggregates only, and deliberately silent until three distinct sellers are in a bucket.
---

# Pooled sold comps

Every price this product shows today is an **active asking price**, which
systematically overstates value. Realized sold prices are the honest fix, and
`00762` (US-3136) is the only route to them this project is willing to take.

## Why there is no API to buy instead

eBay closed all of them:

- `findCompletedItems` was restricted in 2020, and the whole Finding API was
  decommissioned in February 2025.
- Marketplace Insights is a Limited Release that eBay's own documentation says is
  "not open to new users".
- Terapeak is eBay's own product, with no API and no export.

What remains is scraping, which breaches eBay's terms and would put **sellers'
connected accounts** at risk rather than just an IP address. That is not a trade
this project makes. Record the refusal, because the question returns.

## The source is the sellers' own orders

Every seller who connects eBay to FlipDesk grants `sell.fulfillment`, and their
orders already land in `public.sales`. Those rows are better than anything a
scrape could produce, in three specific ways:

- they are **realized** prices, not asks;
- they include **accepted Best Offer amounts**, which no scrape of a listing page
  can see;
- they carry a **condition grade**, which eBay itself does not know.

Pooled across consenting sellers that is a comp set no third party can sell you.

## It is a supplement and is built to stay one

The pool sits **below** eBay sold comps and the seller's own private sales in the
existing ladder in `sold-comps.ts`. When it has nothing it returns nothing, and
the caller falls back exactly as it does today. Nothing about the existing path
changes when the pool is empty, which is most of the time — see the consequence
at the bottom of this note.

## Consent is opt-in and defaults to off

`pooled_comps_opt_in` defaults to **FALSE**. A seller's sales history is their
commercial position, and [[service-role-tables]] and the US-268 rules make
cross-tenant reads deny-by-default for exactly this reason.

**The flag is read live rather than copied into a pool table.** Turning it off
stops a seller's rows counting immediately, and there is no second copy of
anybody's sales to forget to delete. Any future change that materialises the pool
into its own table reintroduces the deletion problem this design avoids.

## What a caller can learn, and what it cannot

The function returns **aggregates only**: a count, a distinct-seller count, and
three percentiles. No sale row, no date, no item, no seller. There is
deliberately no way to ask it for the underlying rows.

It also refuses thin questions, on two floors that do different jobs:

| floor | value | what it protects |
|---|---:|---|
| minimum sales | 5 | the statistic. A median of two is not a median. Mirrors `MIN_PRICE_SAMPLE` in `supply-sampling.ts` and `MIN_SOLD_COMPS` in `sold-comps.ts`. |
| minimum distinct sellers | 3 | the **sellers**. With two in a bucket, either can subtract their own sales from the aggregate and read the other's business off the remainder. |

Three is the floor at which that subtraction stops being arithmetic. It is a
k-anonymity guarantee of the same kind as the ones in
[[market-condition-index-contract]] and [[thrift-radar]], enforced server-side
rather than as a display preference.

> [!warning] With two connected sellers, this function returns NOTHING for every query
> Stated plainly in the migration header because it will otherwise be read as a
> bug and tuned away. That is the design working. **The seller-count floor must
> not be lowered to make the feature produce output sooner.** It starts answering
> when the platform is big enough that answering is safe.

## Related

- [[comp-read-worker]] — the other condition-aware comp source, and what it refuses to spend
- [[market-condition-index-contract]] — the k-anonymity floor and retention rule for ingested listing reads
- [[thrift-radar]] — the same consent-and-floor shape applied to venue supply
- [[sync-source-of-truth]] — where `public.sales` rows come from
- [[INDEX]]
