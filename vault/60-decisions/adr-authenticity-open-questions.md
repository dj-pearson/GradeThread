---
title: "Open authenticity decisions (awaiting a call)"
type: decision
status: current
source_of_truth: vault
code_refs:
  - services/edge-functions/src/lib/ai-authenticity.ts
  - services/edge-functions/src/lib/authenticity-appeal.ts
  - services/edge-functions/src/lib/buyer-guarantee-claim.ts
reviewed: 2026-07-19
revisit_by: 2026-09-30
tags: [decision, authenticity, open, legal, product]
summary: Four authenticity decisions the engineering work is blocked on, each with options and a recommendation — none is decided yet.
---
# Open authenticity decisions

Four questions the authenticity module cannot answer for itself. Each is written
up with what is already built, the real options, and a recommendation — but
**none is decided**, and the code deliberately stops short of assuming an answer.

This note becomes the record once the calls are made. Until then it is the list
of what is blocking.

Related: [[adr-authenticity-guarantee]] (the parked guarantee, with its own
revisit criteria).

---

## 1. What does a seller see, and when? (blocks US-2145)

**Built:** the appeal mechanics — `disputes.kind = 'authenticity'` (00489), an
upheld appeal clears the verdict, reseals the certificate, and produces an
`authentic` golden-set case. **Not built:** any route a seller can reach.

**The problem.** A `red_flags` verdict is published on a public certificate. It
comes from a pass with no measured error rate, and since US-2141/US-2142 it is
sealed into certificate integrity and written to an append-only passport ledger.
A seller currently has no way to know it happened, and no way to contest it.

### 1a. Do we proactively notify a seller when a verdict publishes?

| Option | For | Against |
|---|---|---|
| **Notify on every assessment** | Nobody is flagged in silence | Draws attention to a signal most sellers would never have noticed |
| **Notify only on `red_flags`** (rec.) | The only case with real consequence | Still tells a seller something they may not want to hear |
| **No notification** | Least alarming | A seller cannot contest what they never saw — makes the appeal path decorative |

**Recommendation: notify on `red_flags` only.** An appeal route nobody knows to
use is not a correction path.

### 1b. What do the certificate and passport render while an appeal is open?

| Option | For | Against |
|---|---|---|
| **Keep showing the verdict** | Honest about current state | We keep publishing a claim we are actively reconsidering |
| **Hide pending review** (rec.) | Stops the harm while it is unresolved | A buyer mid-purchase loses a signal; gameable if appeals are free |
| **Show "under review"** | Most transparent | Tells a buyer there is doubt, which may harm the seller more than the flag did |

**Recommendation: hide while under review**, with a rate limit so an appeal
cannot be used to park a verdict indefinitely. The passport is append-only, so a
withdrawal is a superseding event — decide whether the public passport view
renders superseded verdicts at all.

### 1c. SLA

No SLA exists. Note the coupling: while an appeal is open the item is
effectively unsellable at its stated grade, so a slow SLA is itself a penalty.
**Recommendation: a stated target measured in business days, published in the
notice.** The number is yours.

**Needed from you:** answers to 1a/1b/1c. **Then** the routes get built, and the
notice wording goes through counsel with US-2133 — I will not draft it.

---

## 2. The no-macro confidence cap (blocks nothing; changes past output)

**Built:** `AUTHENTICITY_NO_MACRO_CONFIDENCE_CAP = 0.7` — a verdict backed by no
macro frame (serial/date-code/stamp close-up) cannot exceed 0.7 confidence.

**Why 0.7 specifically.** It sits exactly on two thresholds: `deriveVerdict`
needs `>= 0.7` for `likely_authentic`, and `authenticityNeedsReview` forces human
review *below* 0.7. So 0.7 removes the ability to claim HIGH confidence without
macro evidence, while neither flipping every existing verdict to `inconclusive`
nor flooding the review queue.

| Option | Effect |
|---|---|
| **Keep 0.7** (rec. for now) | No retroactive change; thin-evidence verdicts still publish, just not confidently |
| **Drop below 0.7** | No-macro assessment can never read `likely_authentic` — arguably correct, but **no clothing submission has ever had a macro slot**, so this reclassifies effectively every past verdict |
| **Drop further** | Also routes them all to human review — correct in principle, unworkable without reviewer capacity |

**Recommendation: keep 0.7 until macro slots have been live long enough that
lowering it affects new assessments rather than rewriting old ones.** Revisit
once US-2134's slots have real uptake.

**Needed from you:** confirm 0.7, or name the value and accept the retroactive
reclassification.

---

## 3. Payout semantics on a failed remedy grant (blocks US-2144 AC2)

**Built:** the failure is now observable — `captureException` + a
`guarantee.remedy_grant_failed` metric. **Not built:** what should actually
happen.

**The state today.** `buyer-guarantee-claim.ts` records the claim as
`auto_approved` with `remedy_credits` set, draws down the pool, then grants the
credits. If the grant fails, the first two have already happened. The buyer is
owed credits nobody knows are missing.

| Option | For | Against |
|---|---|---|
| **Leave approved, alert only** (today) | Never removes a payout a buyer was told they had | Relies on someone acting on the alert |
| **Flip to `manual_review`** (rec.) | A human sees it and can grant manually | Status changes after the buyer was told it was approved |
| **Reverse the drawdown too** | Pool accounting stays exact | Silently undoing a payout is worse than silently succeeding |
| **Retry inline** | Fixes the transient case | Hides the persistent case, which is the dangerous one |

**Recommendation: flip to `manual_review`, keep the drawdown.** Keeping the
drawdown reserves the money conservatively; a human resolves it. I did not
implement this because it changes money-path semantics after a buyer has been
told they were approved, and that is your call, not a refactor's.

**Separately, and not optional:** the pool gate reads state *before* the insert
and records the drawdown *after*, so concurrent claims can both pass the same
budget check. That wants a transactional reserve and is worth fixing regardless
of this decision.

---

## 4. Claim framing and substantiation (blocks US-2133, gates US-2143)

**This is the one with outside exposure.** Not drafting language here; framing
the questions counsel needs to answer.

1. **Assessment or verification?** The pipeline is built for the former —
   confidence ceilinged at 0.9, hard-capped to 0.5 on contradiction, a
   limitations constant the model cannot override. Does the public copy match
   that posture everywhere it appears?
2. **Can we publish a verdict from an ungated model at all?** The eval gate has
   never passed (US-2130/2131). Does an unmeasured error rate change what may be
   claimed — particularly on the **unauthenticated public endpoint**?
3. **Naming a brand.** A `red_flags` verdict on a named brand's item is an
   implicit statement about that brand's product and about the seller. Where is
   the line?
4. **The KB contradicts the product.** Seeded brand knowledge says
   `"NEVER auto-authenticate"` while the product ships an authenticity verdict.
   One of them has to change.
5. **eBay policy.** `grade-badge.ts` is already dead because eBay bans grade
   overlays on listing imagery, and eBay runs its own Authenticity Guarantee.
   What may be stated on a listing?

**Recommendation: fold this into the US-2114 subscription-compliance counsel
review** rather than running a second engagement — same lawyer, same
substantiation question, different claim.

**US-2143 (buyer-facing positioning) stays blocked until 4 and the eval gate are
both resolved.** Selling the assessment ahead of the evidence is the exposure the
FTC batch exists to fix.

---

## What I need, shortest path

1. **1a/1b/1c** → unblocks building the seller appeal routes.
2. **§3** → unblocks the guarantee fix.
3. **§2** → one-line confirmation.
4. **§4** → schedule with counsel; everything buyer-facing waits on it.
