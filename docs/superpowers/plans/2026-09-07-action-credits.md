# Action Credits Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a seller buy prepaid Action Credits that pay for AI actions and connector actions once their monthly plan allowance is empty, so a small shortfall no longer forces a tier upgrade or a ten-day wait.

**Architecture:** One wallet table plus an append-only ledger, cloned from the proven `api_credit_wallet` shape (00415). The fallback is pushed down into the existing `reserve_ai_action` row lock so every route already calling `withAiAction` / `reserveAiActionSafe` inherits it. Refund routing is decided server-side by a second counter (`ai_actions_credit_paid_this_month`) so the ~30 existing `refundAiAction(ownerId)` call sites need no change at all.

**Tech Stack:** Postgres (plpgsql, SECURITY DEFINER RPCs), Deno + Hono edge, React 19 + TanStack Query, Stripe Checkout, StoreKit 2, Google Play Billing.

**Spec:** `docs/superpowers/specs/2026-09-07-action-credits-design.md`

## Global Constraints

- Currency name: **Action Credits**. Never "boosts", "power-ups" or "tokens" in code or copy.
- Product ids, permanent once created: iOS `com.gradethread.actions.{50,150,400,1000}`; Play `action_credits_{50,150,400,1000}`; Stripe env vars `STRIPE_PRICE_ACTION_CREDITS_{50,150,400,1000}`.
- Packs: 50/$4.99, 150/$13.99, 400/$34.99, 1000/$79.99. Never expire.
- Spend rate v1: 1 credit = 1 action, for `ai_action` and `connector_action`.
- Migration triple (US-1108): idempotent SQL + `EXPECTED_SCHEMA_VERSION` bumped in the SAME commit + self-record footer. Migration number is **00763**.
- Never `REVOKE` in a new migration; copy the no-revoke block from 00609.
- Tenant isolation (US-268): every wallet read/write scopes to `workspaceOwnerId ?? userId`.
- Lock order is always `users` then `action_credit_wallet`. Never the reverse.
- US spelling. No em dashes in new prose. ASCII only in SQL, TS, Swift, Kotlin.
- A commit containing a migration is committed LOCALLY and NOT pushed until the owner says so.

---

### Task 1: Migration 00763, the wallet and the reserve fallback

**Files:**
- Create: `supabase/migrations/00763_action_credits.sql`
- Modify: `services/edge-functions/src/lib/schema-version.ts:60` (`00762` to `00763`)
- Modify: `PENDING_MIGRATIONS.md`

**Interfaces produced:**
- `grant_action_credits(p_user_id uuid, p_credits int, p_reason text, p_session_id text, p_notes text) RETURNS int`
- `debit_action_credits(p_user_id uuid, p_credits int, p_meter text, p_notes text) RETURNS int` (new balance, or `-1` when short)
- `refund_action_credits(p_user_id uuid, p_credits int, p_meter text, p_notes text) RETURNS int`
- `reserve_ai_action(p_user_id uuid, p_limit int) RETURNS boolean` — unchanged signature, delegates with credits allowed
- `reserve_ai_action_v2(p_user_id uuid, p_limit int, p_allow_credits boolean) RETURNS text` — returns `'allowance'` | `'credits'` | `'exhausted'`
- `refund_ai_action(p_user_id uuid) RETURNS void` — unchanged signature, now LIFO-aware
- New column `users.ai_actions_credit_paid_this_month int NOT NULL DEFAULT 0`

**Design notes that must land in the SQL comments:**
- Why the wallet is its own table and not a `users` column: the 00526 self-update guard.
- Lock order `users` then wallet.
- The LIFO refund rule and its one known imprecision: if a seller upgrades mid-month after spending credits, a later refund returns a credit rather than an allowance slot. That favors the seller and self-corrects.
- `ai_actions_credit_paid_this_month` resets on the same lazy month rollover as `ai_actions_used_this_month`.

- [ ] **Step 1:** Write `00763_action_credits.sql`: two tables, RLS enable, owner-read policies, three wallet RPCs, `reserve_ai_action_v2`, the 2-arg `reserve_ai_action` wrapper, the rewritten `refund_ai_action`, the new users column, the no-revoke block, the `applied_migrations` footer.
- [ ] **Step 2:** Bump `EXPECTED_SCHEMA_VERSION` to `00763`.
- [ ] **Step 3:** Add the 00763 row to `PENDING_MIGRATIONS.md`.
- [ ] **Step 4:** Run `npm run verify:db` (needs Docker). Expected: migrations apply on a fresh schema.
- [ ] **Step 5:** Commit locally. Do not push.

---

### Task 2: Edge lib `action-credits.ts`

**Files:**
- Create: `services/edge-functions/src/lib/action-credits.ts`
- Create: `services/edge-functions/src/tests/action-credits_test.ts`

**Interfaces produced:**
```ts
export type ActionMeter = "ai_action" | "connector_action";
export const ACTION_CREDIT_COSTS: Record<ActionMeter, number>;   // all 1 in v1
export interface ActionCreditPack { key: ActionCreditPackKey; credits: number; priceCents: number; priceEnv: string }
export type ActionCreditPackKey = "50" | "150" | "400" | "1000";
export const ACTION_CREDIT_PACKS: Record<ActionCreditPackKey, ActionCreditPack>;
export function isActionCreditPackKey(v: string): v is ActionCreditPackKey;
export function pricePerCredit(pack: ActionCreditPack): number;
export const LOW_BALANCE_THRESHOLD = 20;
export function isLowBalance(balance: number): boolean;
export async function debitActionCredits(ownerId, meter, notes?): Promise<boolean>;
export async function refundActionCredits(ownerId, meter, notes?): Promise<void>;
export async function readActionCreditBalance(ownerId): Promise<number>;
```

**Tests (pure only, no DB):** pack table has exactly four keys; every `priceEnv` matches `/^STRIPE_PRICE_ACTION_CREDITS_(50|150|400|1000)$/`; `pricePerCredit` is monotonically non-increasing as pack size grows; **every pack's per-credit price is at or above Pro's implied rate** (`5900 / 750`) so the plan ladder cannot invert; `isActionCreditPackKey` rejects `"25"` and `""`; `isLowBalance(19)` true, `isLowBalance(20)` false.

- [ ] **Step 1:** Write the failing test file.
- [ ] **Step 2:** `deno test src/tests/action-credits_test.ts` — expect module-not-found.
- [ ] **Step 3:** Write `action-credits.ts`.
- [ ] **Step 4:** Re-run the test. Expect pass.
- [ ] **Step 5:** Commit.

---

### Task 3: Route the AI meter through the wallet

**Files:**
- Modify: `services/edge-functions/src/lib/ai-metering.ts`
- Modify: `services/edge-functions/src/lib/ai-quota.ts`
- Modify: `services/edge-functions/src/routes/flipdesk-autolister.ts`, `flipdesk-ai.ts`, `flipdesk-scout.ts`, `flipdesk-measure.ts`, `flipdesk-listings.ts` (reserve call sites only)
- Modify: `services/edge-functions/src/tests/ai-metering_test.ts`, `ai-quota_test.ts`

**Interfaces produced:**
```ts
export interface AiSpendAuthority { limit: number; allowCredits: boolean }
export type AiSpendSource = "allowance" | "credits" | "exhausted";
export async function reserveAiActionSafe(ownerId: string, authority: number | AiSpendAuthority): Promise<boolean>;
export async function withAiAction<T>(ownerId, authority: number | AiSpendAuthority, fn, deps?): Promise<T>;
```
A bare `number` means `{ limit, allowCredits: true }`, so any site not updated keeps compiling and behaves as before for users with no self-cap.

`QuotaResult`'s ok branch gains `allowCredits: boolean`, computed in `checkQuota` as `userLimit == null || userLimit >= planLimit`. That is the ONLY place that knows whether the binding cap was the plan or the seller's own guard.

`checkQuota`'s 429 body gains `can_top_up: boolean` (true only when the plan cap bound and the wallet could not cover it) plus `credit_balance`, so the client can decide between "buy credits" and "raise your own limit".

**Tests:** self-cap below plan yields `allowCredits: false`; self-cap above plan yields true; `null` self-cap yields true; `limit === -1` never calls debit; a credits-paid failure calls the wallet refund and not `refund_ai_action`; a bare-number authority still reserves.

- [ ] **Step 1:** Write the failing tests.
- [ ] **Step 2:** Run them, confirm failure.
- [ ] **Step 3:** Implement `AiSpendAuthority` in `ai-metering.ts`, wire `reserve_ai_action_v2`.
- [ ] **Step 4:** Add `allowCredits` + `can_top_up` to `ai-quota.ts`.
- [ ] **Step 5:** Update every reserve call site to pass `quota` rather than `quota.limit`.
- [ ] **Step 6:** `deno check` + full edge test suite. Expect green (no red baseline exists).
- [ ] **Step 7:** Commit.

---

### Task 4: Connector actions fall back to the wallet

**Files:**
- Modify: `services/edge-functions/src/lib/connector-allowance.ts`
- Modify: `services/edge-functions/src/tests/connector-allowance_test.ts`

`AllowanceVerdict` gains `paidWith: "allowance" | "credits"` and `canTopUp: boolean`.

The critical distinction: `limit === 0` means the plan excludes the connector. That must NEVER debit a wallet and `canTopUp` must be false. Only `used >= limit` with `limit > 0` attempts a debit.

**Tests:** `limit === 0` never calls debit; exhausted allowance with a funded wallet returns allowed with `paidWith: "credits"`; exhausted allowance with an empty wallet returns not-allowed with `canTopUp: true`; `limit === -1` returns allowed without touching the wallet.

- [ ] **Step 1:** Write the failing tests. **Step 2:** Confirm they fail. **Step 3:** Implement. **Step 4:** Tests pass. **Step 5:** Commit.

---

### Task 5: Stripe checkout, webhook grant, refund clawback

**Files:**
- Modify: `services/edge-functions/src/routes/payments.ts` (new `POST /action-credits/checkout` beside the `api-overage` handler at :1065)
- Modify: `services/edge-functions/src/routes/webhooks.ts` (grant branch at :1497; clawback branch at :2091)
- Modify: `services/edge-functions/src/tests/tenant-isolation_test.ts` (one case per US-268)
- Modify: `services/edge-functions/.env.example`, `vault/10-ops/env-reference.md`

Checkout mirrors the api-overage handler exactly: `mode: "payment"`, metadata `product: "action_credits"` plus `pack` and `credits`, the same metadata on `payment_intent_data`, `automatic_tax`, `billing_address_collection: "required"`, `allow_promotion_codes`, and a per-minute idempotency key. Missing price id returns 503 "Pricing not configured".

Webhook grant calls `grant_action_credits` with the Stripe session id, which is what makes a replayed `checkout.session.completed` grant once. Clawback on `charge.refunded` debits the same amount and clamps at zero.

**Tests:** unknown pack key 400s; missing price env 503s; a replayed session grants once; clawback clamps at zero; a member cannot create a checkout that credits another workspace's wallet.

- [ ] **Step 1:** Failing tests. **Step 2:** Confirm fail. **Step 3:** Implement route + both webhook branches + env docs. **Step 4:** Tests pass. **Step 5:** Commit.

---

### Task 6: Expose the balance to clients

**Files:**
- Modify: `services/edge-functions/src/routes/payments.ts` (`/billing-summary` at :1416, `/ledger` at :1597)

`/billing-summary` gains:
```json
"action_credits": { "balance": 0, "low": false, "packs": [...] }
```
`/ledger` gains an `action_credits` array beside the grade ledger, same shape and same cap.

- [ ] **Step 1:** Failing test on the response shape. **Step 2:** Confirm fail. **Step 3:** Implement. **Step 4:** Pass. **Step 5:** Commit.

---

### Task 7: Web surfaces

**Files:**
- Modify: `src/lib/constants.ts` (`ACTION_CREDIT_PACKS`, display prices only, never price ids)
- Create: `src/components/billing/action-credit-dialog.tsx`
- Modify: `src/hooks/use-billing-summary.ts` (`useBuyActionCredits`, `action_credits` in the summary type)
- Modify: `src/components/billing/usage-meter.tsx` (balance beside the monthly bar)
- Modify: `src/pages/billing.tsx` (balance, buy button, history)
- Modify: the AI 429 handler so an exhausted allowance offers a top-up

**The 429 is the whole point.** Today it is an error toast. It becomes a choice: "Out of AI actions. Top up from $4.99, or upgrade to Pro." When `can_top_up` is false because the seller set their own limit, the copy instead says they set a limit of N and points at Settings. Never offer a top-up that would be refused.

- [ ] **Step 1:** Failing component/unit tests. **Step 2:** Confirm fail. **Step 3:** Implement. **Step 4:** `npx tsc -b`, `npm run lint`, `npm run ui:check` (baseline zero), vitest. **Step 5:** Commit.

---

### Task 8: iOS

**Files:**
- Modify: `services/edge-functions/src/lib/appstore/products.ts` (new `{ kind: "action_credits"; actionCredits: number }`, four CATALOG entries, `CATALOG_VERSION` to 2, `serializeCatalog`)
- Modify: `services/edge-functions/src/lib/appstore/grant-decision.ts`, `precedence.ts`
- Modify: `services/edge-functions/src/routes/appstore.ts` (:453 branch routes the new kind to `grant_action_credits`)
- Modify: `ios/GradeThread/Billing/IAPProduct.swift` (new `IAPKind` case + four entries)
- Modify: `ios/GradeThread/Billing/PaywallView.swift`, `PaywallStore.swift` (third section)
- Modify: `services/edge-functions/src/tests/iap-catalog-drift_test.ts`

Reusing `kind: "consumable"` would grant GRADE credits for an action-credit purchase. That is a fail-open money bug, so the new kind is mandatory and `classifyProduct` stays fail-closed.

iOS cannot be compiled on Windows. `iOS CI` on macOS runners is the gate. Run all six `ios/Scripts/*.py` guards locally via `npm run verify` before pushing.

- [ ] **Step 1:** Extend the drift test with the four ids first; confirm it fails. **Step 2:** Server catalog + grant routing. **Step 3:** Swift catalog + paywall section. **Step 4:** Drift test passes, edge suite green, iOS guards pass. **Step 5:** Commit.

---

### Task 9: Android

**Files:**
- Modify: `services/edge-functions/src/lib/google-play/products.ts` (`action_credits_{50,150,400,1000}` in `ANDROID_CATALOG`)
- Modify: `services/edge-functions/src/routes/google-play*.ts` (grant routing + void clawback)
- Modify: `android/app/src/main/java/com/gradethread/app/billing/CreditPacks.kt` (`ActionCreditPack` enum beside `CreditPack`)
- Modify: `android/app/src/main/java/com/gradethread/app/billing/BillingRepository.kt`

Android builds fully on Windows. Run `npm run verify:android`. First run on a fresh machine needs `npm run android:doctor`.

- [ ] **Step 1:** Failing tests both sides. **Step 2:** Confirm fail. **Step 3:** Implement. **Step 4:** `npm run verify:android` green. **Step 5:** Commit.

---

### Task 10: Docs, vault, backlog

**Files:**
- Create: `vault/50-business/action-credits.md` (the pricing rationale and the ladder-inversion rule, so a future re-price re-checks it)
- Modify: `vault/00-index/INDEX.md` or the business MOC, then `npm run vault:index` + `npm run vault:lint`
- Modify: `prd.json` (stories from `nextId` = US-3138, bump `nextId`)
- Create: an operator checklist for the three consoles

The three manual steps that block revenue: four Stripe prices plus env vars, four App Store Connect consumables, four Play Console products. Until the Stripe prices exist the route correctly returns 503.

- [ ] **Step 1:** Write the vault note. **Step 2:** Run `npm run vault:index` and `npm run vault:lint`. **Step 3:** File the stories. **Step 4:** Commit.

---

## Final verification

- [ ] `npm run verify` fully green (web, edge, db, ios guards).
- [ ] `npm run verify:android` green.
- [ ] `npm run ui:check` at zero.
- [ ] Report what was verified and what still needs the owner: the three console setups, and the push of the migration commit.
