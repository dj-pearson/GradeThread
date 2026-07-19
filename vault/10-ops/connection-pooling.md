---
title: Connection pooling (Supavisor)
aliases: [CONNECTION_POOLING, Supavisor, pgbouncer]
type: runbook
status: current
source_of_truth: vault
code_refs: []
reviewed: 2026-07-19
tags: [ops, database, supavisor]
summary: Pool modes, limits, and which clients must use which port.
---
# Connection Pooling — Supavisor in front of self-hosted Postgres (US-570)

> [!info] **Why:** the edge service and the self-hosted Supabase internal services each
> hold Postgres connections. As we add edge replicas (US-501) and direct-PG
> consumers (backups, migrations, scheduled jobs), uncontrolled connection growth
> can exhaust Postgres `max_connections` and take the whole platform down. A
> **transaction-mode pooler** caps backend connections to a small fixed pool that
> many short-lived clients share, so concurrency scales without 1:1 connection
> growth.

## TL;DR

- Put **Supavisor in transaction mode** in front of Postgres. Self-hosted
  Supabase already ships the `supavisor` / `pooler` container — it just needs to
  be enabled and pointed at.
- **Pooled traffic** (the edge service's PostgREST/GoTrue/Storage paths and any
  direct-PG app workload) → the **pooler** (transaction port, `6543`).
- **Admin / DDL traffic that needs a real session** (pg_dump, pg_restore, the
  migration runner, `CREATE INDEX CONCURRENTLY`, advisory locks) → the **direct**
  Postgres port (`5432`). Transaction pooling breaks these (no session state,
  no prepared statements, no `SET`/advisory-lock continuity).

---

## 1. Topology

```
                    ┌──────────────────────────────────────────────┐
   edge replicas    │  self-hosted Supabase host (api.gradethread)  │
   (Coolify, N≥2)   │                                              │
        │  HTTPS    │   Kong ─► PostgREST ─┐                        │
        ├──────────►│         GoTrue ──────┤                        │
        │           │         Storage ─────┤                        │
        │           │                      ▼                        │
        │           │              ┌──────────────┐   transaction   │
   direct-PG jobs   │              │  Supavisor   │   pool (6543)    │
   (backups: DIRECT │              │ (PgBouncer-  │──┐               │
    only — see §4)  │              │  compatible) │  │ small fixed   │
        │  5432     │              └──────────────┘  │ backend pool  │
        └──────────►│                      ▲          ▼              │
                    │            direct 5432│   ┌────────────┐       │
                    │   pg_dump / migrate ──┘   │  Postgres  │       │
                    │                           │ max_conn=N │       │
                    │                           └────────────┘       │
                    └──────────────────────────────────────────────┘
```

The edge app (`services/edge-functions`) talks to Supabase over **HTTP**
(`SUPABASE_URL` → Kong → PostgREST), so its replicas do **not** each open raw
Postgres sockets — PostgREST owns that pool. The pooler matters for:

1. **The internal Supabase services' DB pools** (PostgREST/GoTrue/Storage),
   which Supavisor lets us cap centrally instead of per-service.
2. **Direct-PG consumers** in this repo: the nightly backup (`scripts/ops/backup-postgres.sh`),
   the migration deploy, and any future job that opens a `postgres://` connection.
   Those point at the pooler **except** where a real session is required (§4).

---

## 2. Enable Supavisor (production, self-hosted)

Self-hosted Supabase's `docker-compose.yml` already defines the `supavisor`
(`pooler`) service. To run it in transaction mode:

1. In the Supabase stack `.env` (the infra `.env`, **not** the edge service's):

   ```bash
   # Transaction-mode pooler port exposed to clients
   POOLER_PROXY_PORT_TRANSACTION=6543
   # Backend connections Supavisor holds open to Postgres, per tenant/user.
   # Size this from the table in §3 — NOT the client count.
   POOLER_DEFAULT_POOL_SIZE=20
   # Upper bound on simultaneous CLIENT connections accepted by the pooler.
   POOLER_MAX_CLIENT_CONN=200
   POOLER_TENANT_ID=gradethread
   POOLER_POOL_MODE=transaction
   ```

2. Ensure the `supavisor` service is **not** commented out / is `restart: unless-stopped`,
   and that `6543` is reachable from the host (it stays on the private Docker
   network; nothing external should hit it directly).

3. Raise Postgres `max_connections` to leave headroom above the **total** backend
   pool (see §3). In the Supabase Postgres config (`postgresql.conf` or the
   `supabase/postgres` env): `max_connections = 200` is a safe self-hosted
   default for the sizing below.

> The **local throwaway stack** (`supabase db start`, used by `npm run verify:db`)
> mirrors this via `[db.pooler]` in `supabase/config.toml` — `enabled = true`,
> `pool_mode = "transaction"`, `default_pool_size = 20`, `max_client_conn = 100`.
> So CI exercises the pooled topology, not a bare Postgres.

---

## 3. Pool sizing (ties to US-501 replica count)

The number that must stay under `max_connections` is the **sum of backend
connections**, not the number of clients (that's the pooler's whole point).

| Consumer | Backend conns | Notes |
|---|---|---|
| Supavisor transaction pool | `default_pool_size` = **20** | Shared by ALL pooled clients (every edge replica's PostgREST/GoTrue/Storage traffic + direct-PG jobs). Transaction mode means 20 backends serve hundreds of clients. |
| Migration deploy (direct 5432) | ~**2** | Short-lived, only during a deploy. |
| Backup pg_dump (direct 5432) | ~**2** | Nightly, brief. |
| Internal Supabase services not behind the pooler (Realtime, Analytics, pg_meta) | ~**10** | Fixed regardless of edge replica count. |
| Operator headroom (psql, ad-hoc) | ~**5** | |
| **Total worst-case** | **~39** | |

**Key property:** adding edge replicas (US-501: N≥2) does **not** grow the
Postgres backend count, because all replica DB traffic funnels through the same
`default_pool_size = 20` transaction pool. Doubling replicas raises *client*
connections to the pooler (bounded by `max_client_conn`), not *backend*
connections to Postgres.

**Sizing rule:** keep `default_pool_size + (direct-session headroom ≈ 19)` well
under `max_connections`. With `max_connections = 200` and the table above
(~39 worst-case), there is >5× headroom, so the planned 2–4 edge replicas cannot
exhaust Postgres. If `default_pool_size` is ever raised, re-check:
`default_pool_size + 19 < max_connections`.

To scale further, raise `default_pool_size` (more backend parallelism) BEFORE
adding more poolers, and bump `max_connections` to preserve the headroom.

---

## 4. What must NOT use the transaction pooler

Transaction-mode pooling returns the backend connection to the pool at each
`COMMIT`, so anything that relies on session-scoped state breaks. Send these to
the **direct** `5432` connection:

- **`pg_dump` / `pg_restore`** — they hold a session-long snapshot. The backup
  (`scripts/ops/backup-postgres.sh`) and restore scripts MUST use the direct URL.
- **Migrations / DDL** — `CREATE INDEX CONCURRENTLY`, advisory locks, and the
  migration runner's transaction boundaries need a stable session.
- **`LISTEN`/`NOTIFY`, session `SET`, prepared statements, temp tables.**

Everything else (the app's pooled query workload) should prefer the pooler.

---

## 5. Connection strings / env

Two env vars make the direct-vs-pooled split explicit for the direct-PG scripts
(documented in `vault/10-ops/env-reference.md` and `services/edge-functions/.env.example`):

| Var | Port | Use |
|---|---|---|
| `SUPABASE_DB_POOL_URL` | `6543` (Supavisor, transaction) | Pooled app/job workload. |
| `SUPABASE_DB_DIRECT_URL` | `5432` (direct Postgres) | pg_dump / restore / migrations / DDL. |

`scripts/ops/backup-postgres.sh` reads `SUPABASE_DB_URL` and is documented to
require the **direct** string — set `SUPABASE_DB_URL=$SUPABASE_DB_DIRECT_URL` for
that cron. The edge service keeps using `SUPABASE_URL` (HTTP via Kong) and gains
pooling transparently because PostgREST sits behind Supavisor.

---

## 6. Load test — prove no `max_connections` exhaustion (AC #4)

`scripts/ops/loadtest-connections.mjs` drives a target endpoint at a configured
concurrency for a fixed duration while sampling `pg_stat_activity` (via `psql`
against `SUPABASE_DB_DIRECT_URL`) and asserting the backend connection count
never approaches `max_connections`.

```bash
# Hammer the edge health/DB path at 200 concurrent clients for 60s and watch
# Postgres backend connections the whole time.
EDGE_URL=https://functions.gradethread.com/health/ready \
SUPABASE_DB_DIRECT_URL='postgres://postgres:...@db-host:5432/postgres' \
node scripts/ops/loadtest-connections.mjs --concurrency 200 --duration 60

# Exit 0 + "PASS" when peak backend conns stayed under the safety threshold
# (default 80% of max_connections); exit 1 + "FAIL" if it breached it.
```

Run it against staging at ≥ the planned production concurrency before scaling
replicas. The HTTP load alone confirms the pooler absorbs the fan-out; the
`pg_stat_activity` sampler is the actual exhaustion gate. If `psql` /
`SUPABASE_DB_DIRECT_URL` is unavailable, the script still runs the HTTP load and
prints latency/error stats, and tells you to watch `pg_stat_activity` manually.

---

## 7. Verifying it's live

```sql
-- Backend connections grouped by the app that opened them. After enabling the
-- pooler, the bulk of app traffic shows up as the Supavisor pool, capped at
-- default_pool_size — not one row per edge replica.
select application_name, count(*)
from pg_stat_activity
group by application_name
order by count(*) desc;

-- Headroom check: used vs. the ceiling.
select count(*) as used,
       current_setting('max_connections')::int as max,
       round(100.0 * count(*) / current_setting('max_connections')::int, 1) as pct
from pg_stat_activity;
```

`pct` should sit in the single digits at idle and stay well under 80% under the
US-573 load test. If it climbs with replica count, the pooler is being bypassed —
check that the pooled consumers point at `6543`, not `5432`.

---

See also: `vault/10-ops/scaling.md` (replicas, US-501), `vault/10-ops/backups.md` (direct-PG backups),
`vault/10-ops/deploy.md` (migration deploy path).

## Related

- [[capacity]] — connections are a capacity ceiling
- [[edge-runtime-invariants]] — N replicas multiply pool demand
- [[env-reference]] — the Supavisor variables
- [[moc-ops]]
