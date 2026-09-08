---
title: Action Credits are the third answer to a spent allowance
aliases: [action credits, top-up, US-3138, prepaid credits]
type: contract
status: current
source_of_truth: code
code_refs:
  - services/edge-functions/src/lib/action-credits.ts
  - services/edge-functions/src/lib/ai-quota.ts
  - services/edge-functions/src/lib/ai-metering.ts
  - supabase/migrations/00763_action_credits.sql
reviewed: 2026-09-08
tags: [pricing, billing, plan-gating, contract]
summary: A prepaid wallet the AI and connector meters fall through to when a monthly allowance runs out, priced so a small shortfall is cheaper to top up and a large one is still cheaper to upgrade.
---

# Action Credits

Owner's decision, **2026-09-07** (US-3138). Anything that prices, sells or
spends a credit reads from this note and the code it points at.

## The problem it answers

A Starter seller gets 200 AI actions a month. Spending the last one on the 20th
used to leave exactly two options: pay $30/month more for Pro, or stop working
for ten days. One is a forced upgrade they may not need; the other is a paying
customer locked out of the thing they are paying for.

## The decision

One wallet, not one pack per meter.

The reason is App Store Connect. Every new consumable SKU is a manual setup plus
a review. A pack-per-meter design means new Stripe products, new App Store
consumables and new Play products every time a metered feature ships. One shared
wallet means the SKUs are created once, and a new metered feature is one row in
`ACTION_CREDIT_COSTS`.

**Grade credits stay a separate currency.** They are live on Stripe and the App
Store with a price anchored to $2.99 per Standard grade. Folding them in would
mean re-denominating a shipped ledger that holds real money. See [[pricing]].

## The packs

| Pack | Credits | Price | Per credit |
|---|---|---|---|
| Top-up | 50 | $4.99 | 9.98c |
| Standard | 150 | $13.99 | 9.33c |
| Bulk | 400 | $34.99 | 8.75c |
| Power | 1,000 | $79.99 | 8.00c |

Never expire. One credit buys one action, on every meter, in v1.

## THE PRICING RULE, and why it is a test

Each plan implies a per-AI-action rate: Starter $29/200 = 14.5c, Pro $59/750 =
7.9c, Business $99/2000 = 5.0c.

**Every pack must price at or above Pro's implied rate.** Below that line,
buying top-ups beats upgrading on the pure per-action metric, and the plan
ladder inverts.

The largest pack sits at 8.00c against Pro's 7.87c, so this is not a comfortable
margin, it is a deliberate one: the discount runs as deep as it can without
crossing. That also means a future re-price can cross it by a few cents while
looking entirely reasonable, which is exactly why it is enforced by
`action-credits_test.ts` rather than left as a paragraph. The failure message
names both numbers.

Sanity check in both directions:

- 50 more actions costs $4.99. Upgrading costs $30/month. **Top-up wins.**
- 400 more costs $34.99. Pro is +$30/month for 550 more *every month*, plus
  1,000 listings, 30 grades and AutoLister. **Upgrading wins.**

## Where the fallback lives, and why the two meters differ

**AI actions:** inside `reserve_ai_action_v2`'s own `users` row lock (00763).
Not in TypeScript. A check-then-act pair at the route boundary races, and a
wallet debit issued after a separate cap read can double-spend. Because the
fallback is in the RPC, every route already calling `withAiAction` inherited it
with no edit.

**Connector actions:** an explicit debit in `checkConnectorAllowance`. That
meter counts rows in `mcp_tool_calls` rather than reading a counter, so there is
no row to lock and no atomic reserve to push the fallback into. The wallet debit
is itself the reservation. See [[connector-plan-gating]].

## The rules that make it trustworthy

**A seller's own cap is never answered with a purchase.**
`users.ai_action_limit` lets a seller cap themselves below their plan. Hitting
*that* refuses and points at Settings. It exists to stop runaway spend, so
spending money the moment it bites is backwards.

This is harder than it looks, because `limit` reaching the reserve is already
`min(planCap, selfCap)` and nothing downstream can tell which one bound.
`checkQuota` is the only place that knows, so it returns `allowCredits`
alongside the limit, and callers pass the whole quota rather than `quota.limit`.
A source scan enforces that: passing `quota.limit` still compiles, still
reserves, and only misbehaves for the sellers who set a cap.

**A feature gate is never a top-up opportunity.** A plan that does not include
the connector at all (`limit === 0`) is refused before the wallet is consulted.
No quantity of credits opens a capability a tier does not carry.

**Unlimited never touches the wallet.** `limit === -1`, including the
`super_admin` short-circuit, short-circuits before any debit.

**Prepaid credits survive a failing card.** `effectivePlanFor` drops a past-due
account to Free allowances; credits already paid for keep working. A seller
whose card is bouncing can finish the listings they already paid to generate.

**Members spend the owner's wallet.** AI actions are billed to
`workspaceOwnerId` (US-268), and the wallet keys on the same id. A member's
checkout funds the owner's wallet, because that is the one their actions draw
on.

**Refunds route to whoever paid.** `refund_ai_action` keeps its old
single-argument signature because about thirty call sites use it and none know
the source. The routing is decided in SQL from
`users.ai_actions_credit_paid_this_month`, LIFO: credits are only spent after
the allowance is gone, so if any credit-paid action exists this month, the last
spend was a credit.

## Every money function is service-role only

`grant`, `debit`, `refund`, `clawback`, both reserves and the refund all open
with a role check. RLS does not apply inside `SECURITY DEFINER`, and the GRANT
cannot be the control on this image: `CREATE FUNCTION` grants EXECUTE to PUBLIC,
a targeted grant only adds to that, and a REVOKE restarts the database
(US-2403). Without the body check, any authenticated caller could rpc
`grant_action_credits` with their own id and mint a wallet.

This is stricter than the "may only act on your own row" shape 00686 uses, and
deliberately so. `scripts/prove-action-credits.sql` case 12 shows all seven
refusing an authenticated caller.

## Deliberately out of scope

- **Grade credits.** A working, priced, shipped wallet. See [[pricing]].
- **Active listing slots.** Capacity, not consumption. A credit that buys a slot
  has to expire when the slot is released, which is a different product with
  different accounting.
- **Buyer meters** (authenticity, video grades, extension checks). Same wallet,
  a later phase. Doing it closes US-1801.
- **Auto-recharge.** Works on Stripe and is impossible for a StoreKit
  consumable, so shipping it would give web customers a retention feature
  iPhone customers cannot have. Revisit only with a deliberate answer for
  mobile.

## Related

- [[pricing]] — tier prices, and the grade-credit ladder this deliberately does
  not touch.
- [[connector-plan-gating]] — the other meter that falls through to this wallet,
  and why its fallback is shaped differently.
- [[subscription-unit-economics]] — where the AI-action caps come from, which is
  the number the pricing rule above is measured against.
- [[flipdesk-plan-gating]] — how every other gated capacity is enforced.
