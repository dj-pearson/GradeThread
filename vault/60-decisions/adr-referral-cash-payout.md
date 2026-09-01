---
title: "ADR: referral cash payouts"
type: decision
status: accepted
source_of_truth: vault
code_refs: []
reviewed: 2026-09-01
revisit_by: 2027-03-01
tags: [decision, referrals, payouts, bizdev]
summary: Whether referral rewards pay cash. Credits-only for user referral; since 2026-09-01, cash for a separate creator affiliate programme; and the compliance and abuse constraints that shape both.
---
# Referral / Affiliate Program — Cash Payouts vs. Credits-Only (US-1141)

> **Revised 2026-09-01: GO for a creator affiliate programme paid in cash.
> User referral stays credits-only. See section 6.** The original decision below
> stands for user referral and is kept as written.
>
> **Decision (2026-06-21): NO-GO on cash payouts for now. Credits-only is INTENTIONAL.** The
> affiliate/referral program rewards both parties in **grade credits** (via
> `grant_grade_credits()`), not money. This is a `[NO-CODE]` spike/decision
> deliverable — a documented founder decision, not shippable code. No production
> code change is required to close it (AC#3). Revisit when (and only when) the
> threshold in §3 is met.

Mirrors the format of [[adr-poshmark-via-extension]].
Feeds the Marketplaces/copy-truthfulness posture and any future "FlipDesk affiliate
program" epic.

---

## 1. Current state (AC#1 — documented as-built, no optimism)

The referral and affiliate channels are **credits-only**. Every reward path
terminates in the `grant_grade_credits()` RPC — there is **no money movement, no
`affiliate_payouts` ledger, and no Stripe Connect account for referrers.**

**Code map (as of 2026-06-21):**

- **`services/edge-functions/src/routes/referrals.ts`** — user-facing referral
  endpoints (`GET /me`, `POST /redeem`, `POST /campaign-codes/redeem`,
  `PUT /leaderboard`). The reward sizes it surfaces (`credits.per_referral`,
  `earned`, `pending`) are denominated in **grade credits**. Campaign-code redeem
  grants via `grant_grade_credits(... p_reason: "admin_grant" ...)`.
- **`services/edge-functions/src/routes/affiliate.ts`** — the earned-link/badge
  channel (`POST /click` public, `GET /me` authed). It explicitly states in its
  header comment: *"Rewards/payouts are NOT here — affiliate conversions ride the
  existing `referral_events` ledger."* It only tracks clicks/conversions; it pays
  nothing directly.
- **`services/edge-functions/src/lib/referrals.ts`** — the qualification + grant
  engine. `grantReferralReward()`, `awardReferralMilestones()`, and
  `applyReferredSignupIncentive()` **all** call `grant_grade_credits()` (plus an
  optional free-month Stripe **coupon** stashed on `users.pending_referral_coupon`).
  Credits, not cash. There is no transfer, no payout row, no 1099 surface.
- **Reward economics** are admin-tunable in `system_settings`
  (`referral_reward_config`, `referred_signup_incentive`, milestone tiers in
  `referral-rewards.ts`) — all expressed in credits (and an optional coupon).

**Contrast — the one place GradeThread DOES pay cash** is the **consignor**
payout path (`lib/consignor-payout.ts` + `consignor-payout-math.ts`, US-1112):
it uses **Stripe Connect** (`consignors.stripe_connect_account_id`,
`payouts_enabled`), a durable `consignor_payouts` ledger, idempotent
`stripe.transfers.create(...)`, queue-until-onboarded semantics, and a batched
sweep cron. That is the pattern a cash referral program would have to mirror.

**Marketing / copy (AC#2 — already matches credits-only):**

- `src/pages/referrals.tsx` — *"When a friend joins and qualifies, you both earn
  **grade credits** — added to your balance automatically"* and *"You earn N grade
  credits each time a [friend qualifies]"*. Stat tiles read **"Credits earned" /
  "Credits pending."**
- `src/components/referral/invite-friend-card.tsx` — no cash/payout/PayPal/
  commission language (verified by grep).
- No referral surface promises money, cash, withdrawal, or commission. **Copy is
  already truthful for a credits-only program; no copy change is required.**

---

## 2. Go/No-Go recommendation (AC#2)

### Verdict: **NO-GO — credits-only is intentional.**

Cash payouts to referrers are deliberately **not** built. Rationale:

1. **Credits are strictly cheaper and self-reinforcing.** A grade credit costs us
   marginal AI inference, not cash out the door, and it pulls the rewardee *back
   into the product* (they must grade something to spend it). A cash payout is a
   pure outflow that leaves the funnel. For an acquisition incentive, credits are
   the better unit of reward.
2. **Cash payouts to individuals = a materially heavier compliance + ops surface.**
   Paying referrers real money turns every referrer into a payee and pulls in:
   - **Stripe Connect onboarding/KYC** for every referrer who wants cash (the
     consignor pattern, but applied to potentially *every user*, not the small set
     of consignment sellers).
   - **US tax reporting** — 1099-NEC/1099-K thresholds, W-9 collection, year-end
     filing. Credits are not reportable income to the recipient; cash referral
     bounties generally are.
   - **Fraud & AML exposure** — cash bounties invite self-referral rings, fake
     signups, and money-out abuse that a credit (locked inside the product, gated
     on a *paid* qualifying action) largely neutralizes.
   - **A real payout ledger + reconciliation + dispute/clawback flow** — none of
     which exists for referrals today (only consignors have it).
3. **Pre-launch, there is no demand signal that justifies the spend.** GradeThread
   is pre-launch with no cohort of high-volume referrers asking to be paid in cash.
   Building Stripe Connect + a payout ledger + tax plumbing for referrers now is
   speculative infrastructure against a customer who does not yet exist.
4. **We already have a graceful upgrade path if the answer changes.** The
   `referral_events` ledger, attribution, qualification, and milestone machinery
   are all in place. If cash ever becomes warranted, we layer a payout ledger +
   Stripe Connect on top (see §4) — we are not boxed in.

**→ Keep the program credits-only. Do not build Stripe Connect for referrers, an
`affiliate_payouts` ledger, or any cash-out flow at this time.**

---

## 3. Re-evaluation trigger (when to reopen this decision)

Reopen and re-run this decision **only** when a concrete demand signal appears —
ALL should hold before building cash payouts:

- [ ] A **repeatable cohort of high-intent affiliates** (e.g. creators / power
      resellers) explicitly asking to be **paid in cash**, where credits are a
      demonstrated dealbreaker for participation, AND
- [ ] referral-driven signups are a **material, measured** acquisition channel
      (worth the compliance load), AND
- [ ] we have the **ops capacity** to own KYC, 1099 reporting, fraud review, and
      payout reconciliation for individual payees.

Absent all three, credits-only stands.

---

## 4. If-GO design sketch (AC#2 — so a future build starts from facts)

Documented so a future re-evaluation starts from a design, not a blank page.
**Mirror the consignor Stripe Connect pattern (US-1112)** — do NOT invent a new one.

1. **Stripe Connect for referrers.** Add `stripe_connect_account_id` +
   `payouts_enabled` to a referrer profile (a `referral_payout_accounts` table, or
   reuse the `consignors` shape generalized). Express onboarding via Stripe
   Connect account links, exactly as consignors onboard. `payouts_enabled` gates
   whether a cash transfer can fire vs. queue.
2. **`affiliate_payouts` ledger** (new migration `NNNNN_affiliate_payouts.sql`),
   modeled on `consignor_payouts`: `user_id` (tenant scope), `referral_event_id`,
   `amount`, `status` (pending/paid/failed), `source` (auto|manual), idempotency
   via a partial UNIQUE index `(referral_event_id) WHERE source='auto'` (mirrors
   `uniq_consignor_payouts_auto_sale`). Service-role-only; add to rls-guard
   `SERVICE_ROLE_ONLY` with an `owner_user_id`-style column (per the
   rls-guard service-role-tables convention: new deny-all operator tables must
   be added to `SERVICE_ROLE_ONLY` in `rls-guard_test.ts`, the owner column
   named `owner_user_id`, and a literal `user_id` kept out of the CREATE TABLE.
   That convention currently lives only in agent memory — it becomes a vault
   note in US-2062, at which point this should be a link again.)
3. **Payout engine** `lib/affiliate-payout.ts` mirroring `consignor-payout.ts`:
   on `referral_events → granted`, decide create-vs-transfer-vs-queue; fire
   `stripe.transfers.create(...)` when onboarded, else queue until
   `payouts_enabled` flips; a batched `/api/jobs/affiliate-payouts` sweep cron
   retries queued rows. Keep the split/amount math PURE in
   `lib/affiliate-payout-math.ts` (unit-testable, no env) per the consignor split.
4. **Config gate** `system_settings.affiliate_payout_mode` (`off|batched|immediate`)
   — `off` by default so the feature ships dark, exactly like
   `consignor_auto_payout_mode`.
5. **Compliance plumbing** (the genuinely new work, not in the consignor path):
   W-9 collection + 1099-NEC/1099-K threshold tracking + year-end reporting; a
   fraud-review queue for cash bounties; a clawback/dispute path.
6. **Copy/UX truthfulness** — only then may the referral surfaces advertise cash;
   until built, copy stays credits-only (it already is — §1).

**Follow-up stories to file IF this flips to GO** (use `prd.json.nextId`, then bump
it — never `max(id)+1`, since done stories live in `prd.archive.json`):

- *Referrer Stripe Connect onboarding* (account link + `payouts_enabled` webhook).
- *`affiliate_payouts` ledger + migration + rls-guard registration.*
- *Affiliate payout engine + batched sweep cron* (mirror `consignor-payout.ts`).
- *Referrer tax compliance: W-9 capture + 1099 threshold tracking + year-end export.*
- *Affiliate fraud-review queue + payout clawback/dispute flow.*
- *Referral UI/plan-copy: surface cash-payout option + onboarding state.*

---

## 5. Decision record

| Field | Value |
|---|---|
| Decision date | 2026-06-21 |
| Decision | **NO-GO on cash payouts — credits-only is intentional** |
| Decided by | Founder (Dan Pearson) |
| Production code change | **None** (credits-only is already as-built; copy already matches) |
| Re-evaluation trigger | A cash-demanding affiliate cohort + material referral channel + ops capacity for KYC/1099/fraud (see §3) |
| If-GO blueprint | Mirror consignor Stripe Connect pattern (US-1112) — see §4 |
| Next review | When the §3 trigger is met (no scheduled date — demand-driven) |
| Revision 2026-09-01 | **GO for a creator affiliate programme paid in cash; user referral stays credits-only.** Decided by Founder (Dj Pearson). Story: US-9212 in `prd-crosslisting.json`. Next review 2027-03-01 (see section 6). |

## 6. Revision, 2026-09-01: cash for creators, credits for users

Decided by Dj on 2026-09-01 during the cross-listing competitiveness review
(`prd-crosslisting.json`, US-9212). The section 3 trigger was written for the
user referral programme, and none of its three conditions was measured before
this call. The decision is strategic, and this note says so rather than
pretending the trigger fired. The reasoning: reseller YouTube and TikTok
creators are the channel Vendoo and List Perfectly were built on, creators do
not promote for grade credits, and fourteen months of credits-only has
produced no creators.

What changes:

- A **creator affiliate programme, separate from user referral,** pays cash:
  20 to 30 percent of first-year subscription revenue, monthly, after the
  refund window, capped per referred account. The numbers are set in the
  story's acceptance criteria and land in [[pricing]] and `src/lib/constants.ts`
  in the same commit once built.
- **User referral stays credits-only.** Sections 1 to 3 still describe it and
  nothing there changes.
- **The build follows the section 4 blueprint unchanged:** mirror the
  consignor Stripe Connect pattern, an `affiliate_payouts` ledger registered
  as a service-role table, a batched engine, a config gate that ships off, and
  W-9 capture plus 1099 threshold tracking before any copy advertises cash.

What does not change: section 4.5 is still the gate. No cash moves before the
tax plumbing exists, and the programme launches dark behind
`affiliate_payout_mode` exactly as the consignor payouts did.

Revisit 2027-03-01 against three numbers: creators signed, paid accounts they
referred, and the monthly ops cost of payouts and tax handling. If the first
two are near zero the programme goes back to a non-cash kit and this section
records that.

## Related

- [[adr-poshmark-via-extension]] — the ADR format this mirrors
- [[pricing]] — referral economics ride on these prices
- [[INDEX]]
