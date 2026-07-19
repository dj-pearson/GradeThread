---
title: Data retention, purge and GDPR rights
aliases: [DATA_RETENTION, GDPR, right to erasure]
type: runbook
status: current
source_of_truth: vault
code_refs: []
reviewed: 2026-07-19
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
