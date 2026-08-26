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
reviewed: 2026-08-25
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
| `jobs-cron-fleet.ts` (hourly) | Compares expected ticks against the ledger and emits a CRITICAL ops event for a stalled job, a WARNING for one that ticks but errors. **A job failing on EVERY run is called out separately** (US-2668) - see below |

**A job that was never created in Coolify is caught.** `detectMissedTicks`
computes expected slots from the *schedule*, not from prior runs, so a job with
zero runs reads as stalled from its first elapsed slot. That is the property that
makes a manifest sufficient — without it, a never-installed task would be
indistinguishable from a job with nothing to do.

> [!warning] The monitor reports what it can see, and says what it cannot
> Two registry entries are outside the ledger, and both are permanent: one-off
> backfills have no cadence to miss, so being outside the monitor is correct
> rather than a gap. It was **eight** on 2026-08-15 morning, including the hourly
> eBay token refresh; US-2616 made the report name them under `unmonitored`
> instead of reporting all-clear on a subset, and US-2617 closed every fixable
> one. Read that list before trusting a green run — it is short now, but the
> value is that a new job cannot be quietly parked in it.

> [!warning] 100% is a different incident from "often", and the report says so
> Four daily jobs failed **7 of 7 runs for nine days** and were read as flaky
> infrastructure. No alert was missing: they sat inside `cron.fleet_failing` at
> WARNING the whole time, next to jobs that fail occasionally. The evidence
> reached the operator as a COUNT - "7 failures in 7 days, about once a day" -
> which is exactly what a container restart pattern looks like.
>
> `always_failing` (US-2668) is the subset of `failing` where every run in the
> window answered >= 400, and the summary states the rate: "content-refresh
> failed 7 of 7 runs". A rate cannot be misread as a frequency.
>
> Two deliberate choices worth keeping. It is a SUBSET, not a fifth verdict, so
> anything already reading `failing` still sees the job. And it reads
> `http_status` rather than `status`, because a payout sweep with one
> permanently-failing transfer records `status: "error"` forever and is not this
> - a run with no recorded `http_status` cannot satisfy it, so the signal fails
> toward silence rather than toward a page.

## What is still manual, and therefore still a risk

- **Creating and removing tasks in Coolify.** The drift check catches a missing
  one within an hour; it cannot catch an *extra* task, or one pointed at the
  wrong URL. US-2617 left three of those: `ebay-orders-sync` should be deleted
  outright, and `photo-archive` and `reconciliation-sweep` need their URLs moved
  to `/api/jobs/…`. Until a person does that, nothing in the repo will say so.
- **A broken entry can look like a missing feature, and the check is cheap.**
  Three entries pointed at seller routes that read the caller's JWT, so none of
  the three jobs had ever once succeeded (US-2310) — and they needed three
  different fixes. `ebay-orders-sync` was a duplicate: `ebay-order-backstop` was
  already the same half-hourly sweep, so building the `/jobs/` route it seemed
  to want would have put two fleet sweeps on one eBay rate-limit bucket.
  `photo-archive` and `reconciliation-sweep` had no equivalent and got the route
  for real. **Look for the existing job first, then write the loop** — the
  search costs a grep and the wrong answer costs a duplicate.
- **The alert destination.** `ops_alert_webhook_url` and `ops_alert_email` both
  default to an empty string, and an empty destination means the whole path ends
  in an admin screen nobody is watching. Both rows exist in production; whether
  their *values* are non-empty is US-2313 AC4 and is an operator read.

Related: [[deploy]] for the redeploy behaviour, [[launch-checklist]] §3 for the
generated task table, [[incident-response]] for what a stalled-job alert means.
