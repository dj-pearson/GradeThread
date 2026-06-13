# Edge Observability — Retention, Sampling & Cost Budget (US-578)

This is the cost-control policy for the edge service's logs and traces. The goal
is **bounded observability spend**: enough signal to debug, alert, and audit,
without the firehose of healthy-request detail becoming a runaway line item.

Three things are pinned down here, one per US-578 acceptance criterion:

1. [Access-log retention & rotation](#1-access-log-retention--rotation)
2. [Trace/log sampling rate](#2-tracelog-sampling-rate)
3. [Cost ceiling / budget](#3-cost-ceiling--budget)

Related: `src/lib/observability.ts` (logging/metrics/Sentry transport),
`src/middleware/access-log.ts` (the per-request line), `src/lib/log-redact.ts`
(PII/secret scrubbing), `UPTIME_MONITORING.md`, `CAPACITY.md`.

---

## What the edge emits

All edge telemetry is **structured JSON on stdout/stderr** — no separate
metrics/tracing agent runs in the container. Everything is `redact()`-scrubbed
before it leaves the process (JWTs, API keys, OAuth/eBay tokens, webhook
signatures, emails). The streams are:

| Stream | Emitter | Volume | Sampled? |
|---|---|---|---|
| `http.request` access line | `access-log.ts` | **highest** — one per request | ✅ success only (see §2) |
| `metric` latency span (`timed()`) | `observability.ts` | high on hot paths | ✅ ok-outcome only |
| `metric` business counter (`recordMetric()`) | many libs | low — discrete events | ❌ always 100% |
| `exception` / `error` / `warn` lines | `captureException()`, handlers | low | ❌ always 100% |
| Sentry events (errors only) | `shipToSentry()` | low, gated on `SENTRY_DSN` | ❌ always 100% |

The edge does **not** ship Sentry performance transactions (only exceptions), so
"traces" at the edge means the structured `http.request` + `timed()` latency
lines the log aggregator scrapes (US-508) — that is what §2 samples.

---

## 1. Access-log retention & rotation

Logs go to stdout/stderr and are captured by Docker's logging driver.

**Enforced on-host bound (the policy):** `docker-compose.coolify.yml` pins the
`json-file` driver with rotation:

```yaml
logging:
  driver: json-file
  options:
    max-size: "10m"   # roll a file at 10 MiB
    max-file: "5"     # keep at most 5 → 50 MiB/container, oldest dropped
```

So a single container can never hold more than **~50 MiB** of logs on disk; on
roll-over the oldest segment is discarded. This is the **local retention
window** and the **on-box disk ceiling**. At the sampled volume in §3 that is
roughly **1–3 days** of access logs per replica before roll-off.

**Longer-lived retention:** for anything past the 50 MiB local window (incident
forensics, audit, dashboards) ship stdout to an external aggregator. Target
retention tiers:

| Tier | Retention | Purpose |
|---|---|---|
| Hot (aggregator, queryable) | **30 days** | debugging, alerting, dashboards |
| Warm (cold storage / object) | **90 days** | incident forensics, trend analysis |
| Errors/exceptions (Sentry) | **90 days** (Sentry plan default) | error triage |
| Local Docker `json-file` | **~1–3 days** (50 MiB cap) | last-resort `docker logs` on-box |

> When an external aggregator is wired in, set its own retention to the 30/90-day
> tiers above and treat the Docker `json-file` cap purely as a local buffer.
> Do **not** raise `max-size`/`max-file` to extend retention — that is the
> aggregator's job; growing the local files just risks filling the host disk.

**Rotation safety:** rotation is size-based and handled by Docker, so it never
blocks the app or loses the current request's line. The app writes a line and
returns; it never reads logs back.

---

## 2. Trace/log sampling rate

`EDGE_TRACE_SAMPLE_RATE` (`[0,1]`, default **1.0**) is the edge analogue of the
frontend's Sentry `tracesSampleRate: 0.1` (`src/main.tsx`). Production is
configured to **`0.1`** in `docker-compose.coolify.yml`, matching the frontend.

**What it samples (cost firehose):**

- `http.request` access lines for **successful** responses (status < 400)
- **ok-outcome** `timed()` latency spans

**What it never touches (kept at 100%):**

- Every **4xx and 5xx** access line
- **error-outcome** `timed()` spans
- All `recordMetric()` business counters (circuit breaker, webhooks, retries,
  rate-limit hits, retention purges, …)
- All `exception` / `error` / `warn` lines and Sentry events

So lowering the rate shrinks only the healthy-request detail. Error rate, audit
trail, security signal, and business KPIs are unaffected.

**Coherence:** the decision is a deterministic FNV-1a hash of the per-request
correlation id (`shouldSampleTrace()`), so a request's access line and all of
its `timed()` spans are kept together or dropped together — never a half-sampled
trace. The env is read per request (cheap, not cached), so the rate can be
changed without a code change. Misconfig (non-numeric) **fails open** to 1.0 so
a typo never silently blinds observability.

**Tuning guide:**

| Rate | Effect | Use when |
|---|---|---|
| `1.0` | log every request | local dev, incident deep-dive, low traffic |
| `0.1` (prod default) | 1-in-10 healthy requests | steady state |
| `0.01` | 1-in-100 healthy requests | a traffic spike threatens the budget below |
| `0` | drop all success traces (errors still logged) | emergency cost cap |

Prefer lowering the rate over raising the Docker log caps in §1.

---

## 3. Cost ceiling / budget

The budget is a **soft ceiling with a hard backstop**: §1's 50 MiB/container cap
is the hard local backstop; the numbers below are the spend target the
aggregator's retention + the sample rate are sized against.

**Assumptions** (revisit if traffic shifts by >2×):

- ~1.0 KB per redacted JSON line (access line or metric span)
- Pre-launch / early steady-state traffic: ~50 req/s peak, ~5 req/s average
- ~2 `timed()` spans per request on hot paths
- Sampling at the prod default `0.1` (success traces), 100% of errors/counters

**Derived volume (per replica, at 0.1 sampling):**

| | Unsampled (rate 1.0) | At 0.1 (prod) |
|---|---|---|
| Access lines/day (~5 req/s avg) | ~430k | ~43k + 100% of errors |
| Metric spans/day | ~860k | ~86k + 100% error spans |
| Log bytes/day | ~1.3 GB | **~130 MB** |
| Log bytes/month | ~40 GB | **~4 GB** |

**Budget ceilings:**

| Item | Ceiling | Backstop / action on breach |
|---|---|---|
| Log volume / replica / month | **≤ 5 GB** | on-box: 50 MiB `json-file` cap (§1). Aggregator: drop `EDGE_TRACE_SAMPLE_RATE` to `0.01`. |
| Log volume, all replicas / month | **≤ 25 GB** | sized for ≤5 replicas (`SCALING.md`); revisit aggregator plan tier past that |
| Aggregator spend / month | **≤ \$50** | pick a plan whose included volume ≥ 25 GB + 30-day retention; alert at 80% |
| Sentry events / month | **within free/team tier** | errors only (not sampled); if quota-pressured, server-side rate-limit noisy issues in Sentry, not here |

**Review cadence:** check actual log volume vs. the 5 GB/replica ceiling monthly
(or after any traffic step-change). If sustained breach, lower
`EDGE_TRACE_SAMPLE_RATE` first; only then revisit the aggregator plan. If volume
is far under budget and we're missing detail when debugging, raise the rate
toward `1.0`.
