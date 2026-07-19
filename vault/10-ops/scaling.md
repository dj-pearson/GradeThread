---
title: Scaling
type: runbook
status: current
source_of_truth: vault
code_refs: []
reviewed: 2026-07-19
tags: [ops, scaling, capacity]
summary: Where the platform runs out of headroom first and what to turn up.
---
# Edge Availability, Replicas & Graceful Degradation (US-501)

The edge service should not be a single point of failure, and dependency outages
should degrade gracefully rather than hard-fail.

## Replicas / zero-downtime deploys

Today the edge runs as a single Coolify container, so a deploy is a brief full
outage and a crash takes the API down until restart.

**Recommended:** run **≥ 2 replicas** behind Traefik so deploys are rolling
(zero-downtime) and one crashed replica doesn't drop traffic.

> [!todo] **MANUAL:** in Coolify, scale the edge-functions resource to 2+ instances (or
> add a second container) behind the existing Traefik labels, and enable rolling
> deploys. The service is stateless except for in-memory caches (rate-limit
> counters are Postgres-backed; circuit breakers + feature-flag cache are
> per-replica and self-heal), so horizontal scaling is safe.
>
> **Connection pooling (prerequisite for replicas):** multiple replicas multiply
> Postgres connections. Front self-hosted Postgres with Supavisor (transaction
> mode) before scaling out. **Done (US-570)** — see `vault/10-ops/connection-pooling.md` for
> the topology, env split (pooled `6543` vs. direct `5432`), pool sizing tied to
> this replica count, and the load-test gate (`scripts/ops/loadtest-connections.mjs`).

### Accepted single-instance risk (interim)

Until replicas are configured, the accepted risk is: a deploy or crash causes a
≤ ~30s outage; the healthcheck + restart policy recovers a crash automatically;
the stuck-submission reaper (US-495) recovers any grade interrupted mid-flight.

> **⚠️ The "≤ ~30s" figure is the OUTAGE, not the user-visible stall (US-2010).**
> A cron job claimed just before the container died held its lease for
> `JOB_STALE_MS` (6 min) or `BATCH_STALE_MS` (15 min) before a `*/5` reclaim
> sweep picked it up — so a seller mid-batch saw *minutes* of apparent stall
> while the UI said "running". Nothing was lost (the accounting reuses
> `ai_reserved`, so a crash-interrupted job is never double-charged); it just
> looked broken.
>
> **Now mitigated for the ORDERLY case.** `lib/lifecycle.ts` installs
> SIGTERM/SIGINT handlers that (a) immediately stop claiming NEW work — the
> guard lives in `acquireJobLock`, the one chokepoint the whole cron fleet
> passes through — and (b) drain in-flight requests before exit, bounded by
> `SHUTDOWN_DRAIN_MS` (default 8s, deliberately inside Docker's 10s
> SIGTERM→SIGKILL grace).
>
> Not claiming matters more than draining fast: an unclaimed job runs on the
> next tick, whereas a job claimed two seconds before exit is stuck for its
> whole lease.
>
> **The reclaim sweeps remain the correctness backstop** — SIGKILL, OOM and host
> loss all bypass this. Graceful shutdown is a latency optimisation for routine
> deploys, not a replacement for the sweeps.

## Graceful degradation per dependency

| Dependency down | Behavior | Mechanism |
|---|---|---|
| **Anthropic** | Grading kill-switch off → 503 with retry guidance; queued work isn't lost | Feature flag `grading` (US-507); stuck-submission reaper refunds stranded grades (US-495) |
| **eBay** | Calls fail fast (timeout) and the breaker opens, backing off crons | Circuit breaker + timeouts (US-499) |
| **Stripe** | Webhooks fail closed (500 → Stripe retries); billing reads degrade to cached/plan-table values | US-499 + webhook idempotency (US-390) |
| **SMTP** | Critical email persists to the outbox + retries with backoff | Email retry/dead-letter (US-498) |
| **Database** | `/health/ready` → 503 so the LB stops routing; writes fail fast | Readiness probe (US-492) |

Maintenance banner: flip the relevant kill-switch (US-507) and surface a banner
in the SPA when grading/autolister is disabled.

## Supabase failover / capacity

Self-hosted Supabase is single-node today. Plan:
- Backups + PITR for recovery (`vault/10-ops/backups.md`).
- A documented restore-to-new-host procedure (RTO ≤ 2h).
- Connection pooler (US-570, **done** — `vault/10-ops/connection-pooling.md`) before adding edge replicas.

> [!todo] **MANUAL:** document the host's resource limits + the scale-up path (vertical
> first, then read replicas) here once capacity testing is done.

## Edge container capacity / memory scale-out (US-573)

The edge container's memory profile (dominated by in-process base64 image
buffering), the right-sized limits (2G), the load test
(`scripts/ops/loadtest-grading.mjs`), and the **memory/CPU scale-out rule +
30% headroom target** that feeds the replica decision above are in
[`vault/10-ops/capacity.md`](vault/10-ops/capacity.md). In short: scale out a replica when sustained RSS
crosses 70% of the limit (`/health/metrics` `pressure: "elevated"`) or CPU
crosses 70%.

## Related

- [[capacity]] — the measurements that trigger scaling
- [[connection-pooling]] — scaling out multiplies pool demand
- [[edge-runtime-invariants]] — what more replicas break
- [[moc-ops]]
