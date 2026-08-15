---
title: Cron schedule governance — a verified manifest, not schedules-as-code
type: decision
status: current
source_of_truth: code
code_refs:
  - services/edge-functions/src/lib/cron-runs.ts
  - services/edge-functions/src/lib/cron-fleet-governance.ts
  - services/edge-functions/src/routes/jobs-cron-fleet.ts
  - services/edge-functions/src/tests/cron-registry-drift_test.ts
reviewed: 2026-08-15
tags: [ops, cron, jobs, decision]
summary: The 77 production schedules live in Coolify and are governed by a manifest in the repo plus a drift check, rather than being created from code.
---

# Cron schedule governance (US-2313 AC1)

## The decision

**A verified manifest, not schedules-as-code.** `CRON_REGISTRY` in
`services/edge-functions/src/lib/cron-runs.ts` is the source of truth for what
*should* run; Coolify Scheduled Tasks are what *does* run; and an hourly job
compares the two by their traces.

The alternative — creating schedules from the repo (a compose sidecar, `pg_cron`,
or a scheduler service) — was not chosen, and the reasons are specific rather
than a preference for the status quo:

1. **The jobs are HTTP endpoints, not database work.** `pg_cron` would have to
   reach back out to the edge service, which means the database holding a
   credential for the API in front of it. That is a worse coupling than the one
   it removes.
2. **A sidecar would be a second thing that can be down**, with no way to alert
   about its own absence — the exact failure this story exists to close, moved
   one layer along.
3. **Coolify already survives a redeploy.** Scheduled Tasks are configured on
   the service rather than baked into the image, so the schedules are not
   coupled to a deploy at all. Recreating the service is the only case that
   loses them, and that is what the generated table is for.

The cost of this choice, stated plainly: **creating a schedule is still a manual
step**, so a new cron can be merged and never installed. That is why the drift
check is not optional — it is the half that makes the decision safe.

## What enforces it

| Piece | What it does |
|---|---|
| `CRON_REGISTRY` | Every expected job: name, schedule, endpoint, which secret it wants, whether it is recorded |
| `CRON_SETUP.md` + the tables in `COOLIFY.md` / [[launch-checklist]] | Generated from the registry by `scripts/render-cron-docs.ts`. A drift test fails if the embedded table stops matching |
| `cron_runs` ledger | One row per invocation, written by middleware rather than by each handler |
| `jobs-cron-fleet.ts` (hourly) | Compares expected ticks against the ledger and emits a CRITICAL ops event for a stalled job, a WARNING for one that ticks but errors |

**A job that was never created in Coolify is caught.** `detectMissedTicks`
computes expected slots from the *schedule*, not from prior runs, so a job with
zero runs reads as stalled from its first elapsed slot. That is the property that
makes a manifest sufficient — without it, a never-installed task would be
indistinguishable from a job with nothing to do.

> [!warning] The monitor reports what it can see, and says what it cannot
> Four registry entries are outside the ledger (US-2616/US-2617): two cannot be
> invoked with the job secret at all, and two are one-off backfills with no
> cadence to miss. The fleet report names them under `unmonitored` rather than
> quietly reporting all-clear on a subset. Read that list before trusting a green
> run.

## What is still manual, and therefore still a risk

- **Creating and removing tasks in Coolify.** The drift check catches a missing
  one within an hour; it cannot catch an *extra* task hitting an endpoint the
  registry does not know about. That is not hypothetical: US-2617 deleted the
  `ebay-orders-sync` entry because `ebay-order-backstop` was already the same
  half-hourly sweep, working — so the Coolify task by that name is now an extra
  one, hitting a seller route that answers 401, and only a person can remove it.
- **A broken entry can look like a missing feature.** `ebay-orders-sync` pointed
  at `/api/flipdesk/ebay/listings/pull`, which reads the caller's JWT, so the
  job had never once succeeded. The obvious repair is to build it a `/jobs/`
  route with a tenant loop — which would have shipped a second fleet sweep
  firing the same detached pulls into the same eBay rate-limit bucket on the
  same cadence. Before writing the loop, look for the job that already does it.
- **The alert destination.** `ops_alert_webhook_url` and `ops_alert_email` both
  default to an empty string, and an empty destination means the whole path ends
  in an admin screen nobody is watching. Both rows exist in production; whether
  their *values* are non-empty is US-2313 AC4 and is an operator read.

Related: [[deploy]] for the redeploy behaviour, [[launch-checklist]] §3 for the
generated task table, [[incident-response]] for what a stalled-job alert means.
