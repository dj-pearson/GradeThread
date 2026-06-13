# Edge Availability, Replicas & Graceful Degradation (US-501)

The edge service should not be a single point of failure, and dependency outages
should degrade gracefully rather than hard-fail.

## Replicas / zero-downtime deploys

Today the edge runs as a single Coolify container, so a deploy is a brief full
outage and a crash takes the API down until restart.

**Recommended:** run **≥ 2 replicas** behind Traefik so deploys are rolling
(zero-downtime) and one crashed replica doesn't drop traffic.

> **MANUAL:** in Coolify, scale the edge-functions resource to 2+ instances (or
> add a second container) behind the existing Traefik labels, and enable rolling
> deploys. The service is stateless except for in-memory caches (rate-limit
> counters are Postgres-backed; circuit breakers + feature-flag cache are
> per-replica and self-heal), so horizontal scaling is safe.
>
> **Connection pooling (prerequisite for replicas):** multiple replicas multiply
> Postgres connections. Front self-hosted Postgres with Supavisor (transaction
> mode) before scaling out. **Done (US-570)** — see `CONNECTION_POOLING.md` for
> the topology, env split (pooled `6543` vs. direct `5432`), pool sizing tied to
> this replica count, and the load-test gate (`scripts/ops/loadtest-connections.mjs`).

### Accepted single-instance risk (interim)

Until replicas are configured, the accepted risk is: a deploy or crash causes a
≤ ~30s outage; the healthcheck + restart policy recovers a crash automatically;
the stuck-submission reaper (US-495) recovers any grade interrupted mid-flight.

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
- Backups + PITR for recovery (`BACKUPS.md`).
- A documented restore-to-new-host procedure (RTO ≤ 2h).
- Connection pooler (US-570, **done** — `CONNECTION_POOLING.md`) before adding edge replicas.

> **MANUAL:** document the host's resource limits + the scale-up path (vertical
> first, then read replicas) here once capacity testing is done.
