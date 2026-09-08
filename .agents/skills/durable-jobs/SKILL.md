---
name: durable-jobs
description: "Use when building or DEBUGGING any queued/background work on the edge: generation batches (flipdesk-autolister processBatch), bulk publish, feed sync, reclaim crons, jobs-*.ts routes, batch/job tables (listing_generation_jobs, publish batches), heartbeats, stale sweeps, or any report that a batch 'did nothing' / stalled. Encodes the batch/claim/heartbeat/reclaim contract and the DB-rows-first debugging procedure."
metadata:
  author: gradethread
  version: "1.0.0"
---

# GradeThread durable jobs — the batch/claim/heartbeat/reclaim contract

The edge container IS the worker (no external queue). Every long-running batch
follows one contract so a container death, a wholesale timeout, or a redeploy
never strands work silently. Reference implementation:
`services/edge-functions/src/routes/flipdesk-autolister.ts` → `processBatch`.

## 🔎 DEBUG PROCEDURE FIRST (learned the hard way, US-1552)

A "batch did nothing" report starts at the JOB ROWS, not the code — failure
paths are DB-row-only BY DESIGN, so edge logs can look perfectly healthy while
every job died:

```sql
select id, status, attempts, error, updated_at
from listing_generation_jobs where batch_id = '<batch>' order by updated_at;
select status, updated_at from listing_generation_batches where id = '<batch>';
```

Read `error` + `attempts` per job. Only after that, read code. (US-1552: a
43-item batch died to per-item timeouts that wrote only job rows.)

## Facts this procedure rests on

- `vault/10-ops/edge-runtime-invariants.md` — the edge runs N replicas, which is
  why a claim must be atomic and why no worker may cache state in module scope.
- `vault/50-business/flipdesk-plan-gating.md` — AI-action budgets a batch worker
  consumes are gated by `requireFlipdesk`, not by the worker itself.

Everything below is PROCEDURE and belongs here, not in a note.

## The contract

- **Tables**: one `*_batches` row (status + progress counters) + one job row
  per item (`status pending|running|completed|failed`, `attempts`, `error`,
  `updated_at`). The batch is DERIVED from its jobs — finalize by re-counting
  job rows (idempotent), never by trusting in-memory tallies.
- **Atomic claim**: a conditional UPDATE (`set status='running',
  attempts=attempts+1 where id=? and status='pending'`) so two workers can't
  take the same job. The claim's error is NEVER swallowed — log it and skip
  the job. (PostgREST caveat: `.or()` filters on MUTATIONS are rejected —
  chain `.eq()`s or split the query; see US-1552's fix.)
- **Attempts cap** (`MAX_JOB_ATTEMPTS = 5`): a job started N times (including
  reclaim resumes) fails TERMINALLY — this is what stops an unattended
  reclaim loop from burning AI quota forever. An explicit user "retry failed"
  resets the budget; automation never does.
- **Per-item timeout < JOB_STALE**: the worker bounds each item
  (`GENERATION_TIMEOUT_MS = 240s`) and must stay comfortably under
  `JOB_STALE_MS = 6min` — a live job must never look stale. On timeout: write
  status+error to the JOB ROW (that's the only trace — see debug procedure).
- **Heartbeat**: every job progress roll-up bumps the BATCH `updated_at`.
  Stale thresholds: job `updated_at` > JOB_STALE → left by a dead worker,
  reclaimable; batch `updated_at` > `BATCH_STALE_MS = 15min` → abandoned,
  swept. (Publish variants: 5min/15min.)
- **Reclaim cron**: `/api/jobs/autolister-reclaim` (and siblings) — job-secret
  gated (`X-Internal-Job-Secret`, `requireJobSecret`), job-locked
  (`acquireJobLock`), resumes stale jobs and finalizes stale batches from the
  job rows. Idempotent by construction.
- **Ops dependency**: every reclaim/sweep cron must be REGISTERED as a Coolify
  scheduled task (`services/edge-functions/COOLIFY.md` table; cadence notes
  there) and records to `cron_runs` (lib/cron-runs.ts). Code without the
  scheduled task = a queue that silently never self-heals.

## Building a NEW queue — checklist

1. Copy the processBatch shape: claim → bounded work → job-row write →
   roll-up/heartbeat → finalize-from-rows.
2. Constants: per-item timeout < JOB_STALE < BATCH_STALE; attempts cap; a
   bounded worker pool (CONCURRENCY=3 in the reference) with a watchdog.
3. Quota: reserve atomically PER ITEM (`reserveAiAction`), refund on failure.
4. Reclaim cron route + COOLIFY.md row + `cron_runs` recording, same commit.
5. Tenant isolation: batches/jobs are multi-tenant — load the tenant-isolation
   skill; scope every claim/read/write by owner.
6. Tests: the watchdog + fallback paths are unit-testable (see
   `autolister-reliability_test.ts` for the pattern).
