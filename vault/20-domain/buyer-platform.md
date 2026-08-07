---
title: The buyer platform — one account, two products, one entitlement rule
aliases: [buyer plan, buyer tier, Guard, Connoisseur, buyer entitlements, buyer gate flags]
type: contract
status: current
source_of_truth: code
code_refs:
  - src/lib/constants.ts
  - src/lib/buyer-features.ts
  - src/lib/__tests__/buyer-plan-limits-parity.test.ts
  - services/edge-functions/src/lib/buyer-plans.ts
  - services/edge-functions/src/lib/buyer-entitlements.ts
reviewed: 2026-08-07
tags: [buyer, plans, entitlements, contract]
summary: A buyer's effective tier is the higher of their buyer subscription and the tier their seller plan already includes; the plan matrix is written twice and only a cross-boundary parity test keeps the halves honest.
---

# The buyer platform

The seller product grades garments. The buyer product sells **confidence at the
point of purchase** on top of that same objective condition data, as its own
recurring subscription. This note owns the identity and entitlement layer that
every buyer feature attaches to. The money that moves inside those features —
reward credits, guarantee claims, what a buyer's search may see — is
[[buyer-economy]], and nothing here restates it.

## One account, two products

There is no second identity. `users.account_type` (`buyer` | `seller` | `both`,
migration `00401_buyer_account_roles.sql`) branches `handle_new_user` so a
buyer-only signup provisions without the seller assumptions, and one person can
hold both products on one Supabase account and one Stripe customer.

That is why plan resolution keys on the **price id**, not on "the customer's
subscription": a customer with both a FlipDesk subscription and a buyer
subscription has two live subscriptions, and asking which one is "theirs" has no
answer.

## The entitlement rule

`resolveBuyerEntitlements` (`lib/buyer-entitlements.ts`) is the only place the
question "what does this buyer get?" is answered on the edge, and it is one rule:

> **effective tier = the HIGHER of (a) the buyer subscription, counted only while
> its status is `active` or `trialing`, and (b) the tier the account's effective
> FlipDesk plan already includes.** Free is the floor for anything unknown,
> lapsed, paused or past due.

Both halves are load-bearing. The status filter is what makes the gate **deny by
default** — a cancelled subscription cannot leave a paid capability switched on.
The seller fold-in (US-1887, `SELLER_PLAN_BUYER_TIER`) is what stops the two-sided
product from billing a seller twice for tools they were already sold: a Business
seller *is* a Connoisseur buyer without a second subscription. It reuses
`effectivePlanFor`, so a lapsed seller loses the buyer bump on exactly the same
grace window they lose seller caps on, rather than on a second timetable nobody
maintains.

Routes gate through `requireBuyerFeature(c, flag)`, which returns a 402 carrying
`product: "buyer"` and `current_plan`. The buyer plan is **personal, never
workspace-shared**, so the read is scoped to the authenticated `c.get("userId")`
and never to a workspace owner or a request-body id.

## The matrix is written twice, and one test is why that is survivable

The tier matrix exists in two files by necessity — the web bundle cannot import
Deno source, and the edge should not carry marketing copy:

| | Where | Holds |
|---|---|---|
| Advertised | `BUYER_PLANS`, `src/lib/constants.ts` | prices, `features[]` copy, allowances, `gateFlags` |
| Enforced | `BUYER_PLAN_ENTITLEMENTS`, `services/edge-functions/src/lib/buyer-plans.ts` | allowances, `gateFlags` |

Comments on both files say "keep in lockstep", which is not a mechanism.
`src/lib/__tests__/buyer-plan-limits-parity.test.ts` is the mechanism: it reads
the edge file as **text** across the project boundary and compares every numeric
allowance and every advertised gate flag, per plan. A drift there is the
advertised-vs-enforced defect class — the pricing page selling a capability the
server refuses.

Two consequences for anyone editing the matrix:

- Adding a flag or an allowance means adding its name to that test's
  `BUYER_GATE_FLAGS` / `ALLOWANCES` lists too. The test enumerates; a key it does
  not name is a key it does not guard.
- Renaming a flag on one side silently un-gates the feature rather than failing to
  compile, because the two `BuyerGateFlags` interfaces are separate declarations.

## `live` is not a gate flag

`BUYER_FEATURES` (`src/lib/buyer-features.ts`) carries a `live` boolean per
feature and it answers a different question from `gateFlags`:

- `gateFlags[f]` — **does this plan unlock f?** Entitlement.
- `BUYER_FEATURES[f].live` — **has f's buyer surface shipped at all?** It mirrors
  the `/buyer/*` route table, and a route still rendering `BuyerPlaceholderPage`
  is not live.

`live: false` is what puts the "Coming soon" badge on a pricing bullet. Treating
the two as the same field is how a placeholder gets sold.

One sharp edge in that mapping: `buyerFeatureForBullet` is **first-match-wins over
the key order** of `BUYER_FEATURES`. A bullet naming two features ("3 authenticity
+ 2 video-grade credits / month") badges only on the first one that matches, so
flipping the second feature's `live` changes nothing visible. A feature that needs
its own badge needs its own bullet.

## Known gap: buyer video-grade credits are advertised but not reachable

Verified 2026-08-07. Both paid tiers advertise `videoGradeCreditsPerMonth`
(Guard 2, Connoisseur 10), the `videoGrading` gate flag is true on both, and
`BUYER_METER_ALLOWANCE` maps a `video_grades` meter key onto that allowance — but
**no route calls `withBuyerMeter(…, "video_grades", …)`**. The clip path in
`routes/grade.ts` gates on `videoGradingPlanAllowed(effectiveFlipdeskPlan, …)`
alone, so a Guard buyer whose seller plan is free is sold two credits the server
answers with `UPGRADE_REQUIRED`, and the usage meter on the buyer billing page can
never move.

This is the advertised-vs-enforced class again, and the parity test cannot catch
it: both sides agree the allowance is 2. What is missing is the *binding* — the
call site that spends it. **US-1841** owns that; do not "fix" it by lowering the
advertised number, which would confirm the wrong half.

`authenticityAddon` is the worked example of the shape the video binding should
take: `routes/buyer-authenticity.ts` checks the flag, then wraps the action in
`withBuyerMeter` so the allowance is actually debited.

## Related

- [[buyer-economy]] — credits, claims and buyer-facing visibility, once a buyer is entitled
- [[grade-accuracy-guarantee]] — what the guarantee flag may actually pay
- [[pricing]] — the seller tier matrix this one folds into
- [[INDEX]]
