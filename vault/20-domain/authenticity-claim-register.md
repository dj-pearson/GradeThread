---
title: Authenticity claims — every string we show, and what actually backs it
type: contract
status: current
source_of_truth: code
code_refs:
  - services/edge-functions/src/lib/ai-authenticity.ts
  - src/pages/tools/authenticity-check.tsx
  - services/edge-functions/src/tests/authenticity-claim-register_test.ts
reviewed: 2026-08-10
tags: [authenticity, legal, compliance, claims]
summary: The inventory US-2133's substantiation review needs — where each authenticity claim renders, what the pipeline can support, and where our own brand KB contradicts the product.
---

# Authenticity claim register

US-2133 asks for a substantiation review of **every** user-facing authenticity
claim, with counsel. Its own note says what an agent may safely do here:
*locate both sides, quote them, and stop.*

**Nothing on this page drafts or revises a claim.** It is the inventory the
review needs, and the evidence beside it, so the reviewer is not the one doing
the archaeology. The same argument as
[[subscription-copy-review-register]], and that register found a false claim
within the hour of existing.

> [!warning] No claim here has been substantiated or reviewed
> The verdicts are live on a paid add-on and on authenticated surfaces today.
> The posture decision (assessment vs verification) is US-2133 AC2 and has not
> been made.

## The three verdicts

`AuthenticityVerdict` = `likely_authentic | inconclusive | red_flags`
(`ai-authenticity.ts`). Derived **deterministically** from findings, not
authored by the model.

| Verdict | Shown as | Where |
|---|---|---|
| `likely_authentic` | "Looks consistent with genuine" | `src/pages/tools/authenticity-check.tsx` |
| `inconclusive` | "Inconclusive" | same |
| `red_flags` | "Red flags found" | same |

The rendered labels are deliberately weaker than the enum names. "Looks
consistent with genuine" is an observation about photographs; `likely_authentic`
would read as a judgement about the item. **That distinction is the product's
entire legal posture and it is one string wide.**

## What the pipeline actually supports

Every one of these is a real constraint in code, not an intention:

- **A fixed limitations disclosure, which the model cannot author.**
  `AUTHENTICITY_LIMITATIONS` states in the output that it is "not a definitive
  authentication, legal opinion, or guarantee", that it cannot inspect materials
  in person, verify serials, or detect a high-quality counterfeit, and that it is
  "one trust signal, not proof". `AUTHENTICITY_NO_MACRO_LIMITATION` is appended
  when no close-up backed the read.
- **Confidence is ceilinged**, and capped harder on a contradiction, on missing
  macro evidence, on thin reference coverage, and on unverified brand tells.
  Caps compose by minimum and never raise.
- **The public endpoint has two independent gates.** `/tools/authenticity-check`
  requires `PUBLIC_AUTHENTICITY_CHECK_ENABLED` **and** a passing eval run. The
  env flag is the *legal* gate (a human read the copy); it says nothing about
  whether the model is any good, which is why they are separate. Authenticated
  surfaces run ungated on purpose — a named account plus the disclosure is a
  different posture from an anonymous public claim.

## What the evidence base actually is

This is the number the review most needs and it is uncomfortable (US-2219,
measured):

- **All 179 seeded `authentication_tells` payloads use the legacy
  `{tell, detail}` shape. Zero use the structured one.** `coerceTell` maps a
  legacy entry to category `other` with no redFlag — so those payloads are prose
  the prompt reads and the verdict cannot use.
- `CANONICAL_TELLS` holds **7 structured tells across 3 brands**, every one
  sourced `seed:… (unverified — review in admin)`.
- So the distinction that matters is between *having tells* and *having usable
  tells*, and almost the whole corpus is on the wrong side of it.

Coverage is disclosed rather than hidden: `classifyTellCoverage` reports the
level, and a thin-coverage assessment carries a stated limitation and a cap
(US-2219's decision was disclose-and-cap, not block the sale).

## ⚠ Our own knowledge base says not to do this (US-2133 AC3)

37 seeded brand packs carry prose such as **"NEVER label a Coach item
authentic"** (`00398`) and **"LUXURY — never auto-authenticate"** (`00399`),
while `deriveVerdict` emits `likely_authentic` on a paid add-on.

Two things make it smaller than it looks, and both are for the reviewer, not for
an agent:

1. It may be a gap of **wording rather than posture** — a capped, disclosed
   "looks consistent with genuine" is arguably not the act that prose forbids.
   AC2 settles it and AC3 follows.
2. **The fix cannot be an edit to the seeds.** Applied migrations are immutable
   (US-2059), so the reconciliation lands in `vault/20-domain/brands/` with the
   seeds left alone.

## What the review still owes

1. Every string above, against what the evidence supports — folded into the
   US-2114 gate rather than run separately (AC1).
2. The posture: assessment-with-limitations vs verification (AC2).
3. The brand-KB reconciliation, in the vault (AC3).
4. eBay exposure — grade overlays on listing imagery are banned and eBay runs
   its own Authenticity Guarantee, so what may be stated on a listing is a
   policy question before it is a build one (AC4).
5. Whether the unauthenticated endpoint should expose verdicts at all (AC5).

## Related

- [[subscription-copy-review-register]] — the same instrument for billing copy
- [[authenticity-coverage-priority]] — the disclose-and-cap decision
- [[brand-taxonomy-overview]] — where the KB's governing rules live
- [[INDEX]]
