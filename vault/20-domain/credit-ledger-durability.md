---
title: Credit ledger durability — the ledger outlives the account and cannot be edited
type: contract
status: current
source_of_truth: code
code_refs:
  - supabase/migrations/00595_ledger_survives_deletion.sql
  - supabase/migrations/00597_ledger_append_only.sql
  - supabase/migrations/00037_pricing_split.sql
  - services/edge-functions/src/lib/credit-ledger.ts
  - services/edge-functions/src/routes/account.ts
reviewed: 2026-08-14
tags: [billing, ledger, retention, privacy, contract]
summary: grade_credit_transactions is a financial record — no foreign key deletes it, no trigger permits editing it, and account erasure redacts the PII around it instead of removing it.
---

# Credit ledger durability

`public.grade_credit_transactions` is the record of every grade GradeThread has
been paid for. Retail is $2–3 per grade, so this table is the product's revenue
evidence, not an audit convenience. Two properties make it evidence rather than
a log, and both are enforced by the database.

## 1. It outlives the account

Until 00595 the table's `user_id` was `ON DELETE CASCADE` to `public.users`,
which cascades from `auth.users`. `POST /api/account/delete` therefore erased
the entire ledger for the account it deleted. `submission_id` was
`ON DELETE SET NULL` against a table that cascades the same way, so a surviving
row would have lost the record of what it paid for.

00595 drops all three foreign keys — the two above plus
`flipdesk_subscription_events.user_id`. The columns stay; only the constraints
go.

**A `user_id` with no matching `public.users` row is a correct state**, and
anything reading this table has to be written that way. An INNER JOIN to `users`
silently drops erased accounts, which is precisely the population a dispute
concerns. `routes/admin-billing.ts` reads the table without a join.

### Why not an archive table

The rejected alternative was copying rows into a `billing_ledger_archive` at
deletion time. Two copies of a financial record drift, and the drift is invisible
until the moment someone needs the record. A ledger you simply do not delete has
one source of truth and needs no reconciliation job. Not moving the rows also
keeps the invariant in [[#the-invariant]] holding without a second implementation.

### Retention basis

These rows carry no PII. `user_id` is a UUID that resolves to nobody once
`auth.users` is gone; `notes` is generated text of the form
`standard grade — 1 credit`. They are financial records retained under the
legal-obligation carve-out to erasure, which is the same ground
`account_deletion_log` has stood on since 00064.

`flipdesk_subscription_events` is the exception and needs care: its `raw_payload`
is the verbatim Stripe object, which carries customer email and billing address.
Erasure **redacts** that column via `redact_subscription_event_pii(uuid)` while
keeping `event_type`, `from_plan`, `to_plan`, `stripe_event_id` and `created_at`
— the audit fields that answer "what plan were they on when they were charged".
The redaction writes a marker object rather than NULL, so a reader can tell
"redacted on erasure" from "never captured".

### The deletion record proves it

`account_deletion_log` gained `stripe_customer_id`, `ledger_rows_retained` and
`subscription_events_redacted` in 00595. The retention is therefore checkable
from the log rather than asserted in a code comment. `stripe_customer_id` is an
opaque handle, not PII, and it is the join key a representment starts from.

## 2. It cannot be edited

00597 puts a `BEFORE UPDATE OR DELETE` trigger on the table that raises
`restrict_violation` for **every** role, `service_role` included.

**RLS is not the control here and cannot be.** The table's only policy grants
users `SELECT` on their own rows, which reads like protection. But every route in
the edge service runs on the service-role client, and `service_role` bypasses RLS
entirely — so the whole application is already past that policy before it touches
a row. A trigger is not bypassed; it fires for `service_role`, for `psql`, and for
anything else holding the connection.

Corrections are still possible. They are just visible: reverse a wrong debit by
INSERTing a compensating row with `reason` `refund` or `admin_grant`.

`ledger_append_only_enforced()` returns whether the trigger is present **and**
enabled, so "the ledger is immutable" is a measurement the ops health check makes
rather than a belief.

### Apply order

**00597 requires 00595.** Until the cascading FK is gone, account deletion still
deletes ledger rows, and a DELETE-blocking trigger aborts every account deletion
in the product. Files apply in `NNNNN` order, so running the directory is safe;
running 00597 alone is not.

## The invariant

Over the complete ledger ordered oldest-first, the running cumulative sum of
`delta` must equal `balance_after` on every row that records one. Zero-delta
audit rows (`included_grant`, and the included-grade branch of `refund_grade`)
carry `balance_after = NULL`, because snapshotting a balance they did not change
was a non-atomic read that drifted under concurrency (00093).

`lib/credit-ledger.ts` `findLedgerInvariantViolation()` proves it, and is shared
by the admin ledger endpoint and the invariant test. The append-only trigger
protects the *history*; this walk proves the *arithmetic*. Neither replaces the
other.

## Who may move a balance

Only these, all `SECURITY DEFINER` and all row-locking on `public.users`:

| Function | Migration | Direction |
|---|---|---|
| `debit_grade_credits` | 00516 (00037) | down, optionally idempotent |
| `grant_grade_credits` | 00092 (00037) | up |
| `revoke_grade_credits` | 00083 | down, on refund/chargeback |
| `refund_grade` | 00093 (00048) | up, reverses one grade |

No TypeScript reads-then-writes `users.grade_credit_balance`. Adding a fifth
writer means adding a row to this table too.

Related: [[reward-ledger]] for the XP economy, which is a separate ledger with
separate rules, and [[service-role-tables]] for why deny-all tables exist.
