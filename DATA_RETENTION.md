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
