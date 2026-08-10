---
title: Data retention, purge and GDPR rights
aliases: [DATA_RETENTION, GDPR, right to erasure]
type: runbook
status: current
source_of_truth: vault
code_refs: []
reviewed: 2026-08-10
tags: [ops, privacy, gdpr, retention]
summary: The retention schedule and purge job, plus the export and erasure paths that satisfy portability and right-to-be-forgotten.
---
# Data Retention & PII Purge (US-521)

GradeThread enforces storage-limitation/data-minimization through documented
retention windows and an automated purge job. This file is the operational
source of truth; the customer-facing summary lives in the Privacy Policy
(`src/pages/legal/privacy.tsx`, §7) and the subprocessor list.

## Retention schedule

| Data category | Store | Retention | Mechanism |
|---|---|---|---|
| Grading photos | `submission-images` bucket + `submission_images` rows | **2 years** from submission (`DATA_RETENTION_DAYS`, default 730) | Automated purge cron (`/api/jobs/data-retention`) deletes the storage objects + index rows; the grade report is kept (anonymized) |
| Grade reports & certificates | `grade_reports` | Life of account | Kept so public certificates stay verifiable |
| Account profile & auth | `users`, Supabase Auth | Deleted/de-identified ≤ 90 days after account closure | Account-deletion flow (US-275) + manual closure |
| Billing & transactions | `flipdesk_subscription_events`, Stripe | Up to 7 years | Tax/accounting obligation; Stripe is system of record |
| Support & dispute records | `disputes` | Up to 3 years after resolution | Manual |
| Server & security logs | log aggregator | ≤ 90 days | Aggregator retention policy |

## The purge job

- **Endpoint:** `POST /api/jobs/data-retention` (gated by `X-Internal-Job-Secret`).
- **Code:** `services/edge-functions/src/lib/data-retention.ts`.
- **Behavior:** finds submissions older than the window, deletes their
  `submission-images` storage objects **first** (so a mid-run failure can't
  orphan objects), then deletes the `submission_images` rows. The
  `grade_reports` row is intentionally retained — the grade is the non-PII
  product and the certificate must stay verifiable. This is **anonymization**
  (photos removed), not destruction of the grade.
- **Overlap-safe:** wrapped in the `data-retention` job lock (US-503).
- **Observability:** emits `retention.objects_purged` metric + a structured
  `retention.sweep` log; failures go to the error tracker (US-491).
- **Batch size:** 200 submissions/run; safe to run frequently (idempotent —
  re-running re-deletes any objects whose row delete failed last time).

## Scheduling

Add to the Coolify scheduled-task list (see `services/edge-functions/COOLIFY.md`):

```
# Daily at 04:00 UTC
curl -fsS -X POST https://functions.gradethread.com/api/jobs/data-retention \
  -H "X-Internal-Job-Secret: $FLIPDESK_INTERNAL_JOB_SECRET"
```

## Tuning

- `DATA_RETENTION_DAYS` — grading-photo window in days (default 730). Lowering
  it purges more aggressively on the next run.

## Early deletion (user request)

Users can request deletion before the window via the account-deletion flow
(US-275) or by contacting privacy@gradethread.com. Account deletion cascades
`submission_images` (FK `ON DELETE CASCADE`) and removes storage objects.

## Verification

After a run, confirm:
1. `POST /api/jobs/data-retention` returns `{ ok: true, objects_deleted, rows_deleted }`.
2. A sampled old `submission_images.storage_path` no longer resolves in the
   `submission-images` bucket.
3. The corresponding `grade_reports` row still exists (anonymized grade kept).

---

## Absorbed from `docs/DATA_RETENTION.md` (US-2049)

Complementary halves again: this file covered the **operational** side (retention
schedule, the purge job, scheduling, tuning, verification) while the `docs/` copy
covered the **compliance** side (export / right to portability, deletion / right
to erasure, and how external resources are handled). A privacy request needs both.

How GradeThread handles user data lifecycle for GDPR / CCPA (US-275).

## Export (right to portability)

A signed-in user can export their own data via `GET /api/account/export`
(`services/edge-functions/src/routes/account.ts`): profile, submissions, grade
reports, inventory items, listings, sales, and sources, scoped to their
`user_id`. Returned as a downloadable JSON attachment.

## Deletion (right to erasure)

The authed **`POST /api/account/delete`** edge endpoint (`routes/account.ts`)
performs the full teardown. The Settings page exposes it via a "Delete account"
card requiring the user to type `DELETE MY ACCOUNT`. The endpoint:

1. Removes the user's Supabase Storage objects (`submission-images`,
   `item-photos`) — derived from the owned DB rows before the cascade runs.
2. Deletes the Stripe customer (which also cancels any active subscription).
3. Deletes the `auth.users` row via the admin API; the `ON DELETE CASCADE`
   chain rooted at `public.users` then wipes all DB-resident user data
   (submissions, grade_reports, inventory_items, listings, sales, sources,
   item_photos, marketplace_connections, api_keys, …).

The legacy `delete_account()` RPC (migration `00043`) still exists for the
client-side self-service path, but it only does step 3 — prefer the endpoint,
which also handles the external resources below.

### Notes on external resources

- **Storage objects** — handled in step 1 (not FK-cascaded).
- **Stripe customer** — handled in step 2.
- **Marketplace OAuth tokens** — the stored `marketplace_connections` rows
  (incl. eBay tokens) are removed by the cascade. Live revocation at eBay is
  not performed in-line; those tokens are short-lived and our stored copy is
  destroyed. See `docs/INCIDENT_RESPONSE.md` if proactive revocation is needed.

### Email-keyed PII — the half the cascade cannot reach (US-2005)

The cascade reaches only tables with an FK to `auth.users`. Seven tables are
keyed by **email address** instead, including `email_deliveries`, which stores
the full rendered `html` of every critical message we sent. Step 3 above ran
while those stayed queryable.

Since US-2005 the endpoint runs `purgeEmailKeyedPii()` **before** the cascade —
ordering is load-bearing, because after it `users.email` is gone and there is
nothing left to key on. The table list and the delete/anonymize decision for each
live in `services/edge-functions/src/lib/account-email-purge.ts`; do not restate
them anywhere else, and do not write a second script that hardcodes them.

`email_suppressions` is **deliberately exempt**. Forgetting a bounced or
complained address means it starts receiving mail again, harming the very person
the erasure protects.

Erasure for someone who never had an account — a guarantee claimant, a
consignor — is a different procedure with a different plan; see
`third-party-pii-purge.ts` (US-2433).

### What we can and cannot say about erasures made before US-2005

**Accounts deleted before US-2005 shipped did not get the email-keyed purge, and
that backlog cannot be enumerated.** This is the answer to give if asked; it is
a consequence of a deliberate design choice, not an oversight to be fixed later.

- `account_deletion_log` stores **no address**, by design — migration `00064`
  states the retained id "cannot be joined back to any PII". It proves *that*
  an account id was erased on a date. It cannot say *whose address* that was.
- `email_deliveries` has **no user column at all** (`00095`). Nothing to join.
- Every other planned table either severs its user link `ON DELETE SET NULL`
  (`marketing_send_log`, `email_subscribers`, `waitlist_entries`) or never had
  one (`email_journey_step_sends`).

So an address with no live account is **indistinguishable** from a lead who
never signed up — and `waitlist_entries` and `email_subscribers` exist for
exactly those people. Running the purge plan over that set would delete the
waitlist and the newsletter list on the theory that some of them might be
someone else. **Do not do it.**

What *does* reduce the residue:

- **Time.** US-2021 put `email_deliveries` on the retention sweep above: `sent`
  rows deleted after 90 days, `dead_letter` bodies stripped after 180. Confirm
  the `data-retention` cron is actually scheduled — if it is not, nothing is
  expiring.
- **A request.** When a subject writes in, the address is known and no inference
  is needed.

Two operator tools, both in `services/edge-functions/scripts/`:

| Script | What it does |
|---|---|
| `email-residue-census.ts` | Counts the residue per table, split into live-account and unattributable. **Read-only, and has no `--apply`** — there is no population one could safely act on. Never prints an address. |
| `purge-email-subject.ts` | Erases **one** address on request, running the same `EMAIL_PURGE_PLAN`. Dry run by default; refuses an address that still belongs to a live account. |

Neither is an endpoint. An unverified email claim that erases rows is a deletion
oracle — anyone could POST a stranger's address. Verification would be the work,
and it has not been designed.

## Retention

- **Active account data** is retained while the account exists.
- **On deletion**, DB data is removed immediately via the cascade; external
  cleanup (above) should run in the same flow.
- **Backups**: database and storage backups age out per the retention policy
  in `vault/10-ops/backups.md` (7 days local, 30 days offsite); deleted data is therefore
  purged from all backups within 30 days.
- **A minimal, non-PII record of the deletion request** (timestamp + opaque
  id) may be retained for compliance evidence.

Link this from the public privacy policy when the deletion UI ships.

## Related

- [[incident-response]] — a breach triggers the notification chain, not just a purge
- [[key-rotation]] — erasure of encrypted rows depends on which key encrypted them
- [[INDEX]]
