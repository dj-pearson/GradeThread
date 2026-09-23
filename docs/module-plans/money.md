# Money: payments, billing, sales, books & taxes

Health: **ok**

The Stripe side is well built. It verifies signatures, rejects test-mode events in prod, fails closed on its idempotency claim, dead-letters with a critical ops alert, and runs a nightly Stripe-vs-DB reconciliation. The books side has one structural flaw: the ledger is rebuilt only when it is empty or when the P&L page's button is pressed. So the Money overview, estimated-tax card, tax-runway card, tax packet and period close can all read a stale ledger without saying so. Fixing ledger freshness, and stopping a rebuild from rewriting closed periods, is the biggest opportunity.

## Actions

### 1. Stop books screens and the tax packet from reading a stale ledger

Impact: high | Effort: M | Story: none (parent epic US-2981 is open only on an owner decision about US-3000)

**Why:** src/lib/ledger.ts:111-126 ensureLedgerBuilt() rebuilds only when the ledger_entries count is 0. After the first build, new sales and expenses never reach the ledger unless someone presses rebuild, and only src/pages/flipdesk/pnl.tsx:170-174 has that button. Screens that call ensureLedgerBuilt and then trust the result: src/pages/flipdesk/money-overview.tsx:122, src/components/finances/tax-packet-card.tsx:87 (the accountant packet), src/components/finances/estimated-tax-card.tsx:83, src/components/finances/tax-runway-card.tsx:108. Even the P&L rebuild invalidates only the pnl-entries query key (pnl.tsx:173), not money-overview-ledger (money-overview.tsx:119), so the overview stays stale for its 5-minute staleTime after a manual rebuild.

**Steps:**
- Add a cheap freshness check: compare max(updated_at) across sales, flipdesk_expenses, mileage_trips, home_office_years, shipments and ebay_payouts for the user against the ledger's last build time. Use an RPC, or add a ledger_built_at column set by rebuild_ledger_for_user.
- Change ensureLedgerBuilt() to rebuild when the ledger is empty OR stale, not only when empty.
- Always rebuild in tax-packet-card gather() before reading entries. It is a deliberate export, so paying for a rebuild there is fine.
- After rebuildMyLedger(), invalidate every ledger-derived query key (pnl-entries, money-overview-ledger, and the tax card keys), ideally through one shared key prefix.
- Add a vitest that records a sale after the first build and asserts ensureLedgerBuilt triggers the rebuild RPC.
- Show an 'as of' timestamp on the Money overview and tax cards.

### 2. Rebuild the ledger inside close_period so closing figures are current

Impact: high | Effort: S | Story: none

**Why:** supabase/migrations/00702_period_close.sql:277-335 close_period() stores closing_figures from public.ledger_reconciliation(p_period_start), which reads ledger_entries, but it never calls rebuild_ledger_for_user first. The client wrapper src/lib/period-close.ts:50 calls the RPC directly, and src/components/finances/period-close-card.tsx has no rebuild call either. With the ensureLedgerBuilt behavior above, a seller can freeze a month whose recorded figures leave out every sale since the ledger was first built.

**Steps:**
- New idempotent migration: CREATE OR REPLACE close_period to PERFORM public.rebuild_ledger_for_user(v_uid) before computing v_figures. Keep the US-3002 body-guard pattern and do not add a REVOKE.
- Bump EXPECTED_SCHEMA_VERSION in the same commit (migrations skill).
- Extend scripts/check-period-close.mjs: insert a sale after an initial rebuild, close the period, and assert closing_figures includes it. Sabotage by removing the PERFORM line and watch it go red.
- Run it with --dsn against the local Postgres 16 cluster described in CLAUDE.md.

### 3. Keep a ledger rebuild from rewriting closed periods

Impact: high | Effort: M | Story: none

**Why:** supabase/migrations/00777_ledger_rebuild_safeupdate.sql:84-85 deletes every non-adjustment ledger_entries row for the user regardless of closed_periods, then re-derives all of them. The period lock triggers cover only flipdesk_expenses, mileage_trips, sales and inventory_items.acquired_price (00702_period_close.sql:167, 172, 222, 258). The rebuild also reads home_office_years, shipments, ebay_payouts and mileage_rates (grep of FROM clauses in 00777), and none of those is locked. Change one of them and the next rebuild silently moves a closed month's numbers away from its stored closing_figures.

**Steps:**
- Choose a design: (a) rebuild skips entry_date ranges covered by an open closed_periods row (reopened_at IS NULL), or (b) add lock triggers on the remaining inputs. (a) is simpler and covers inputs added later.
- Implement it as a new CREATE OR REPLACE of rebuild_ledger_for_user, carried forward byte for byte from 00777 apart from that change (keep the TRUNCATE fix).
- Add a check to scripts/check-period-close.mjs: close a period, change home_office_years, rebuild, and assert that period's ledger totals equal its closing_figures.
- Record the rule in the books vault contract note in the same commit.

### 4. Delete the legacy /api/payments/subscribe route, which can open a second paid subscription

Impact: high | Effort: S | Story: none

**Why:** services/edge-functions/src/routes/payments.ts:1437-1547 opens a Stripe subscription Checkout without the live-subscription guard that /flipdesk/subscribe has at payments.ts:363 ('must modify it in place ... rather than open a second parallel subscription'). It also has no idempotencyKey (payments.ts:1531, while every other checkout sets one at 564, 840, 1083 and later), and it applies trial_end based only on a missing flipdesk_subscription_id. Grep finds no caller in src/, ios/, android/ or tests. The /checkout-session alias at payments.ts:1433 is only referenced in a design doc.

**Steps:**
- Confirm there are no external API consumers: check edge access logs for POST /api/payments/subscribe and /api/payments/checkout-session over 30 days.
- Remove the /subscribe handler, or make it return 410. Keep or remove the /checkout-session alias depending on the log result.
- Add a test in services/edge-functions/src/tests asserting that the payments router has no /subscribe route, so it cannot quietly return.
- If it must stay, route it through the same live-subscription check and idempotency key as /flipdesk/subscribe.

### 5. Make subscription webhooks safe against out-of-order and non-current subscription events

Impact: medium | Effort: M | Story: none (related: US-2457 buyer/seller audit separation, AC4 open)

**Why:** handleSubscriptionDeleted (services/edge-functions/src/routes/webhooks.ts:1005-1070) sets flipdesk_plan='free' and flipdesk_subscription_id=null for whichever subscription was deleted. It never checks that sub.id equals user.flipdesk_subscription_id, so canceling a duplicate or old subscription demotes a customer who still has a live one. handleSubscriptionChange writes flipdesk_subscription_id: sub.id unconditionally (webhooks.ts ~686) and has no event.created ordering check (a grep for event.created finds only webhooks.ts:1323). A late retry of an older customer.subscription.updated, for example after a transient release at webhooks.ts:388-393, overwrites newer state. The nightly job (routes/jobs-billing-reconciliation.ts:62-100) flags this afterwards but does not stop it.

**Steps:**
- In handleSubscriptionDeleted, if user.flipdesk_subscription_id is set and differs from sub.id, record the audit event and return without downgrading.
- In handleSubscriptionChange, either call stripe.subscriptions.retrieve(sub.id) and write the fresh object, or store a last_subscription_event_at per user and ignore events whose created time is older.
- Add stripe-webhook-handler_test.ts cases: delete of a non-current sub leaves the plan alone, and an older updated event after a newer one is a no-op. Sabotage each guard once.
- Apply the same guard to the buyer branch (buyer_subscription_id).

### 6. Show the ledger-vs-dashboard disagreement check to the seller

Impact: medium | Effort: S | Story: none

**Why:** src/lib/ledger.ts:99-110 fetchLedgerReconciliation() wraps the ledger_reconciliation RPC (00685_ledger_entries.sql:313). Its own comment says agrees:false means the ledger is wrong. Grep across src/ and services/ finds no caller outside ledger.ts, so the one drift detector the books have is never shown anywhere.

**Steps:**
- Call fetchLedgerReconciliation for the selected period on the P&L page and the Money overview.
- When agrees is false, show a plain banner: 'Your books are out of date' with a Rebuild button. This pairs with action 1.
- Add a vitest with a mocked RPC returning agrees:false that asserts the banner renders.

### 7. Close or narrow money stories whose code already shipped

Impact: low | Effort: S | Story: US-2011, US-2981, US-3000, US-2457

**Why:** US-2011 is still open, but its AC1 is done: services/edge-functions/src/lib/webhook-dead-letter.ts:98-112 calls emitOpsEvent('webhook.dead_letter','critical') and webhooks.ts:565 pages on an unmappable price. Its notes say only the forced dead-letter drill after a GIT_SHA rebuild is left. US-2981 and US-3000 are open only on the owner narrowing US-3000 to the Android half that shipped. US-2457 has only AC4 left (the index swap), which the local Postgres 16 cluster can now prove without Docker.

**Steps:**
- Recast US-2011's remaining AC as an OPERATOR drill (force a dead letter after the Coolify rebuild) so the queue shows the true remaining work.
- Ask the owner for the US-3000 decision; closing it closes US-2981.
- Run US-2457 AC4 against the local initdb cluster with its migration and close it.

## Risks

- Estimated-tax and tax-packet numbers can be understated with no warning on screen, because they read a ledger that was built once and never refreshed. A seller could underpay quarterly tax or hand an accountant incomplete books.
- Closed periods are not frozen at the ledger level. A rebuild re-derives them from inputs the period locks do not cover (home_office_years, shipments, ebay_payouts, mileage_rates).
- A legacy authenticated endpoint (POST /api/payments/subscribe) can still create a parallel Stripe subscription, which means double billing.
- Canceling a non-current Stripe subscription demotes the user to Free even when they have another live subscription. The nightly reconciliation catches this only after the fact.
- Not verified here: the edge test suite and the db-lane check scripts were not run in this read-only pass, so every finding comes from reading the code.
