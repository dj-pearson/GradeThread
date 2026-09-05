---
title: The Claude connector rides its own gate flag and its own monthly counter
aliases: [connectorAccess, connector allowance, US-9101]
type: contract
status: current
source_of_truth: code
code_refs:
  - src/lib/constants.ts
  - services/edge-functions/src/lib/pricing-config.ts
  - services/edge-functions/src/lib/connector-allowance.ts
  - services/edge-functions/src/middleware/mcp-auth.ts
  - services/edge-functions/src/lib/mcp-budget.ts
reviewed: 2026-09-05
tags: [pricing, connector, plan-gating, contract]
summary: connectorAccess opens at pro; connector write actions have their own monthly counter derived from the audit log, not a share of aiActionsPerMonth.
---

# The connector's gate and its allowance

> **Re-reviewed 2026-09-05.** Drift flagged `mcp-budget.ts` for a new budget
> kind, `extension_queue` (US-3065), at 20 batches an hour — sized like publish.
>
> ⚠ Worth reading alongside this note's allowance section, because the two
> answer different questions and US-3065's AC asked for something the allowance
> does for no tool. The MONTHLY allowance counts rows in `mcp_tool_calls`, one
> per tool CALL, and there is no weight column — so a per-row charge would need
> the check and the count to agree, and only the check can change without a
> migration. The precedent is also looser already:
> `gradethread_end_listings` takes up to 100 live listings off their
> marketplaces for one allowance action. See [[claude-connector]].

> **Re-reviewed 2026-09-02.** Drift flagged `src/lib/constants.ts` for
> `CREATOR_AFFILIATE` (US-9212). No connector, plan row or gate constant moved.
> Nothing here changed.


> Owner's decision, **2026-08-19** (US-9101). Two questions were open and both
> are answered here. Anything that prices, gates or caps the connector reads
> from this note and from the code it points at.

## The decision

| | Value | Where |
|---|---|---|
| Gate flag | `connectorAccess` | `gateFlags`, both matrices |
| Plans with it | **pro, business** | free and starter are `false` |
| Monthly write allowance | pro **500**, business **2000** | `connectorActionsPerMonth` |
| Counter | its **own**, not `aiActionsPerMonth` | `lib/connector-allowance.ts` |

`apiAccess` is **unchanged and still business-only.** It means raw `/api/v1`
access, which is a different product from the connector — one flag for both
would have meant widening the connector also widened the API, silently.

## Why pro rather than business

The connector is the strongest single reason to pay for GradeThread. Gating it
at $99 means almost nobody encounters it, and a feature nobody encounters cannot
be the reason anyone upgrades. Opening it at pro ($59) makes it the answer to
"why would I move up from starter", and business keeps a materially higher
ceiling (2000 vs 500) so the tier above still has a reason to exist.

**The sandbox tools are exempt and work on every plan, free included.** That is
deliberate and it is the acquisition lever: a seller who cannot see what the
connector does has no reason to pay for it. The exemption lives in the tool
dispatcher (`sandbox: true` skips the plan gate), not in this matrix.

## Why its own counter

Sharing `aiActionsPerMonth` is simpler, and it is the one choice that cannot be
undone later without a repricing. A seller told "750 AI actions" cannot be told
afterwards that some of them were always the connector's. Two consequences the
shared counter would have had:

- the connector could never be sold separately, or metered separately, without a
  migration and a customer-facing change;
- an AutoLister batch could eat the allowance a seller's connector needs, on the
  same afternoon, with nothing saying so.

## There is no new column, and that is the interesting part

`connectorActionsUsed` is a **COUNT over `mcp_tool_calls`**, not an integer to
increment. That table already records every call with its owner, its tool and
its timestamp, and it is already indexed on `(owner_user_id, created_at desc)`.

So there is no migration, nothing held waiting on an operator, no second source
of truth to drift from the audit log — and **no way to spend an action without
leaving a row, because the row IS the spend.** The cost is a count per write
call instead of a read of one integer, which against a partial index on one
seller's month is not the expensive part of a publish.

If the number ever needs to be operator-tunable, add
`connector_actions_per_month` to `pricing_plans` and change one line in
`rowToConfig`. It is deliberately not there yet: a held migration to make a
number editable before anyone has asked to edit it is the wrong trade.

## What counts, and what does not

Only **successful** calls to tools declaring `destructiveHint: true`, and the
list is DERIVED from the registry (`WRITE_TOOL_NAMES`) rather than hand-written,
so a write tool added later is counted without its author remembering.

Reads, previews and refused calls cost nothing. Charging for "can I?" would
teach a model to ask less, which is the opposite of what the whole
preview-then-confirm protocol is for.

## This is not the same thing as the per-action budgets

Two ceilings, different jobs, and both apply:

- **`lib/mcp-budget.ts`** bounds a BURST — twenty publishes an hour, fifty price
  changes an hour. It stops a runaway loop.
- **This** bounds the MONTH, and it is the number a plan is sold on.

A seller can be inside the hourly budget and out of monthly allowance, or the
reverse. Both refuse with their own message and neither is a substitute for the
other.

## Both fail closed

An allowance that cannot be read must not read as unlimited on a path that
publishes listings, so a counter outage or an unresolvable user refuses. The
effective plan is resolved the same way every other gate resolves it, so a
paused subscription or an expired trial falls back to Free — where the allowance
is zero — and a downgrade actually stops the connector rather than
grandfathering it.

## Related

- [[pricing]] — the price of each tier, and the rule that `src/lib/constants.ts`
  changes in the same commit.
- [[flipdesk-plan-gating]] — how every other gated capacity is enforced, and the
  402 protocol the frontends depend on.
- [[subscription-unit-economics]] — where the AI-action caps come from, which is
  the number this one deliberately does not share.

## 2026-09-04: constants.ts moved, but only the grade-score colours

`src/lib/constants.ts` changed in 19d62b6b4 (US-3010). The whole diff is the
four grade-score colour helpers -- `getScoreColor`, `getScoreBorderColor`,
`getProgressColor`, `getTierBadgeClasses` -- dropping from four bands to
three and moving the green boundary from `> 7` to `>= 7`. That contract lives
in [[brand-design-system]] section 3B, which the same commit amended.

Nothing this note asserts is in that diff. Re-read to confirm rather than
assumed, which is the only reason the date below moved.
