---
title: FlipDesk plan gating contract
type: contract
status: current
source_of_truth: code
code_refs:
  - services/edge-functions/src/lib/plan-gate.ts
  - src/lib/constants.ts
reviewed: 2026-07-19
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
