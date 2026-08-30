---
title: FlipDesk plan gating contract
type: contract
status: current
source_of_truth: code
code_refs:
  - services/edge-functions/src/lib/plan-gate.ts
  - services/edge-functions/src/lib/active-listings.ts
  - services/edge-functions/src/tests/plan-gate-coverage_test.ts
  - src/lib/constants.ts
reviewed: 2026-08-30
tags: [flipdesk, plans, billing, contract]
summary: Every FlipDesk endpoint touching a gated capacity or feature calls requireFlipdesk; the 80%-warning and 402 responses are a protocol two frontends depend on.
---

# FlipDesk plan gating contract

`requireFlipdesk()` is the single gate for plan limits. This is a contract every
new FlipDesk endpoint must honour — enforcement lives in the handler, so an
endpoint that forgets simply has no limits.

## The rule

> "every FlipDesk-side endpoint that touches a gated capacity (active listings,
> AI actions, marketplace connections) or a gated feature (bulk actions,
> sub-accounts, API access, reconciliation) should call `requireFlipdesk()` at
> the top of the handler. If the call returns a Response, return it directly —
> otherwise proceed."

Returning the Response directly matters: the gate does not throw, so a handler
that ignores the return value proceeds past a limit it was told to enforce.

Since US-2179 the rule has teeth: `plan-gate-coverage_test.ts` walks
`src/routes/` and fails CI when a route puts an item live, connects a
marketplace, or ends a listing without the matching enforcement. It exists
because the rule was silently broken for every non-eBay channel — see below.

An exemption goes in that test's `GOES_LIVE_ALLOWLIST` with a written reason,
never in the route. The one entry today is the automations crosslist action
(US-2378): it only runs against listings that are already live, so its
`markItemListed` call repairs the count rather than consuming a new slot, and
gating it would refuse to FIX the number for a seller sitting at their cap.

## Two capacities are enforced outside the gate

`requireFlipdesk` resolves all five caps, but it is only the *gate* for three.
Reading `getLimit` as the enforcement point for the other two is the trap:

| Capacity | Enforced by | Why not the gate |
|---|---|---|
| `aiActions` | `reserve_ai_action` (CAS) via `lib/ai-metering.ts`, cap resolved by `checkQuota` | A check-then-act gate races: concurrent requests at the boundary collectively overshoot. The CAS refuses inside one statement |
| `includedGrades` | `runPaymentPrecedence` in `lib/grade-billing.ts` | An exhausted monthly bundle must fall THROUGH to credits/checkout, not 402. Blocking would refuse a grade the seller can pay for |

The cost of that split is drift: every one of those paths has to re-derive the
effective plan the same way the gate does. `checkQuota` did not, and paid for it
twice — a `past_due` account past the dunning grace window kept full paid AI
allowances (the omitted `past_due_since` made `effectivePlanFor` fail open), and
the cap came from a compiled table rather than the operator-editable matrix, so
admin edits silently did nothing. Both fixed in US-2179; both are the kind of bug
a second copy of plan resolution will keep producing.

## The AI cap is a min of three, not one

`getLimit(plan, 'aiActions', user)` does not return the plan number. It returns
`aiCapFor(planLimit, user.ai_action_limit, user.subscription_status)`, which is a
**min-of-caps**: the plan allowance, the seller's own `ai_action_limit` self-cap,
and `TRIAL_AI_ACTION_CAP` (100) while `subscription_status = 'trialing'`. Each
input can only lower the answer, so a fourth added later cannot accidentally
raise one. `-1` means unlimited and is handled inside `effectiveAiCap`; a trial
never produces `-1`, which is the point (US-2288 — a 14-day Pro trial is
resettable by deleting the account and re-registering, so the top tier would
otherwise be the cheapest thing to farm).

Three properties that look like details and are the contract:

- It keys on the subscription **state**, not the plan. A converted customer on
  Pro gets the full 750; only `trialing` is throttled.
- It composes on the **enforcement** path only. `requiredPlanForCapacity` asks a
  plan-shopping question ("which tier covers N?"), and answering it with a
  trial-throttled number would recommend an upgrade the trial itself caused.
- `subscription_status` is **required** on the internal `UserSlice`, not
  optional. A caller that forgot it would silently take the uncapped path.


## What the caps count

`activeListings` counts **items** — `inventory_items.status = 'listed'` — not
listing rows. One live item is one slot no matter how many marketplaces it is
cross-listed to, and the plan numbers were sized for that. Switching the basis to
`listings` rows would silently re-scale every cap: an item live on eBay + Depop +
Poshmark would start consuming 3 of Free's 25.

That basis is only correct if every channel maintains the item status, and until
US-2179 only the eBay publish paths did. Cross-push (Depop/Etsy/Shopify/Whatnot)
and extension-writeback (Poshmark/Mercari/Grailed) created live listings while
leaving the item in `drafted`, so those listings were **neither capped nor
counted** — a Free account could put unlimited items live off-eBay, and the usage
meter read 0. The lifecycle now lives in `lib/active-listings.ts`
(`markItemListed` / `resyncItemListedStatus`), and the release side matters as
much as the publish side: a route that ends a listing without reconciling the
item leaves the slot consumed forever, which shrinks the seller's usable cap with
no error anywhere.

**Not backfilled, deliberately.** US-2179 fixed the write paths, not history.
Items already live off-eBay stay in `drafted` until something re-publishes or ends
them, so they remain uncounted. That means no seller's usage meter jumps
retroactively and nobody is abruptly over their cap — the enforcement tightens
going forward instead. If the residual undercount ever needs closing, it is a
one-off backfill (`inventory_items.status = 'listed'` where an active non-eBay
`listings` row exists) and it WILL push some existing accounts over their cap on
the next publish, which is a pricing/comms decision before it is a migration.

## A trial does not carry its plan's AI allowance

`aiCapFor(planLimit, userLimit, subscriptionStatus)` composes three inputs
**min-of-caps**, the same shape the grading confidence policy uses: each can only
lower the answer, so a fourth added later cannot accidentally raise one. When
`subscription_status = 'trialing'` the result is capped at
`TRIAL_AI_ACTION_CAP` = **100** — including on an unlimited (`-1`) plan, or the
top tier would be the cheapest thing to farm.

The exposure this closes is the **plan entitlement**, not credits: a fresh trial
account has a `grade_credit_balance` of 0, but Pro carries 750 AI actions a month
against Free's 25, so one signup-delete-resignup cycle was worth thirty times the
free allowance. 100 sits deliberately above 25 (a real evaluator still gets a
real trial) and well below 750 (a farmed one is worth about an eighth of what it
was).

**Owner's choice among three options, 2026-08-17.** The alternatives were a
hashed-email record of prior trials and requiring a card on file. This one was
picked because it adds no signup friction, retains no personal data past account
deletion, and reverses by changing one number. It does not *prevent* a second
trial — it makes each one too cheap to be worth taking.

`subscription_status` is REQUIRED on `UserSlice` rather than optional, so a call
site that forgets it fails to compile instead of silently granting the full plan
cap.

## The response protocol

Two frontends parse these, so the shapes are load-bearing rather than cosmetic:

| Situation | Response |
|---|---|
| **80% of a capacity** | Proceeds, and sets an `X-Plan-Warning` response header — a soft nudge, not a block |
| **100% of a capacity** | **402 PAYMENT_REQUIRED** with a body the frontend (US-210) renders as the `UpgradeRequiredDialog` |

Changing either shape breaks a UI that has no other signal. The 80% warning in
particular is easy to drop accidentally, because nothing fails when it is missing
— the seller just hits a wall with no warning.

## Where the numbers come from

The caps themselves are not defined here. They come from `FLIPDESK_PLANS` in
`src/lib/constants.ts`, mirrored from [[pricing]] — and `-1` means **unlimited**,
not unset. Treating `-1` as missing data silently downgrades Business accounts.

## Related

- [[pricing]] — the plan matrix these gates enforce
- [[subscription-unit-economics]] — why the AI-action caps sit where they do
- [[INDEX]]
