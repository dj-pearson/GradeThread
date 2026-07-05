# Coolify deployment

This service hosts both GradeThread and FlipDesk edge endpoints behind one
container. Deploy it as a single Coolify resource.

## One-time setup

1. In Coolify: **New Resource → Docker Compose → from Git**.
2. Point at this repository.
3. Set the **Base Directory** to `/services/edge-functions`. Coolify will
   auto-pick `docker-compose.yml` from there (now production-ready).
4. Set the FQDN to `functions.gradethread.com` (or set `COOLIFY_FQDN` env
   var). **Do not** reuse `api.gradethread.com` — that hostname is the
   self-hosted Supabase Kong running on a separate container; pointing
   Traefik at it from this service will collide with Supabase and 404
   anything under `/api/*`.
5. Add the env vars from `.env.example` (Supabase, Anthropic, Stripe, eBay, R2).
6. Save and deploy.

Coolify reads the `coolify.*` labels on the service to provision a Traefik
route with Let's Encrypt automatically.

If you prefer to keep extra Traefik-specific labels (e.g. for self-managed
Traefik without Coolify), use `docker-compose.coolify.yml` instead — it has
both the `coolify.*` labels and explicit `traefik.*` fallbacks.

## Local development

For hot-reload during local development:

```bash
docker compose -f docker-compose.yml -f docker-compose.dev.yml up
```

The dev override mounts `./src` and runs Deno with `--watch`.

## Routes hosted

| Prefix                       | Purpose                                       |
| ---------------------------- | --------------------------------------------- |
| `/health`                    | Liveness probe (used by Docker healthcheck)   |
| `/api/grade/*`               | GradeThread submission + status               |
| `/api/payments/*`            | Stripe checkout, billing portal               |
| `/api/webhooks/*`            | Inbound Stripe webhooks                       |
| `/api/keys/*`                | API key management (authed)                   |
| `/api/v1/*`                  | Public API v1 (API key auth)                  |
| `/api/notifications/*`       | Internal notification triggers                |
| `/api/flipdesk/ebay/*`       | FlipDesk eBay OAuth + listing push + comps    |
| `/api/flipdesk/webhooks/*`   | FlipDesk inbound webhooks (eBay, GradeThread) |
| `/api/flipdesk/grading/*`    | FlipDesk → GradeThread bridge                 |
| `/api/flipdesk/images/*`     | Image pipeline (resize, EXIF, R2 archive)     |
| `/api/flipdesk/reconciliation/*` | Payout matching                           |

## Request body size limit (US-362)

Request bodies are capped at two layers, defense-in-depth:

1. **Edge of network (Traefik):** the `edge-bodylimit` buffering middleware
   (see `docker-compose.coolify.yml`) returns **HTTP 413** once a request body
   exceeds **16 MiB** (`maxRequestBodyBytes=16777216`), before the request ever
   reaches the container. `memRequestBodyBytes=2 MiB` bounds the in-memory
   buffer (larger bodies spill to disk). This holds even when `Content-Length`
   is omitted or spoofed (chunked transfer-encoding).
2. **Application (Hono):** `middleware/body-limit.ts` rejects an honest
   over-cap `Content-Length` up front (413) and, for the spoofed/omitted case,
   byte-counts the body **as the handler reads it** and aborts the stream past
   the cap (15 MiB upload paths, 256 KiB JSON paths).

The 16 MiB Traefik cap = the app's 15 MiB upload cap plus multipart/base64
overhead. **Keep it in sync with `UPLOAD_MAX_BYTES` in `body-limit.ts`** if that
value changes.

## Cloudflare-only origin + trustworthy rate limiting (US-354)

The rate limiter (`middleware/rate-limit.ts`) attributes unauthenticated
requests to **`CF-Connecting-IP`** — the only client identifier a caller can't
forge, because Cloudflare overwrites it. `X-Forwarded-For` is **not** trusted in
production (it's client-controlled on a direct-to-origin request, so trusting it
would let an attacker rotate the header to evade IP limits). For that to hold,
the origin must be reachable **only via Cloudflare** — otherwise a client can hit
the container directly and there is no CF-set IP to key on.

**Required deploy hardening (verify on the live deploy):**

1. **Lock the origin to Cloudflare at the network layer.** Either run the
   service behind a `cloudflared` tunnel, or firewall the Coolify/Traefik
   ingress to accept connections only from
   [Cloudflare's published IP ranges](https://www.cloudflare.com/ips/). Confirm
   a direct hit to the origin IP/hostname (bypassing CF) is **refused** — this is
   the AC3 "direct reachability is verified closed" check.
2. **(Optional, recommended) Set `CF_ORIGIN_SECRET`** on this resource and add a
   Cloudflare Transform Rule that injects a request header
   `cf-origin-secret: <same value>` on all proxied traffic. The limiter then
   trusts `CF-Connecting-IP` only when that header matches (constant-time
   compare), so even if the network firewall were misconfigured, a direct hit
   can't pass off a forged CF IP. Leave unset to rely on the network layer alone.

The unauthenticated webhook receivers (`/api/webhooks/*`,
`/api/flipdesk/webhooks/*`) run **fail-closed**: if the rate-limit counter store
is down they fall back to a per-replica in-memory ceiling (degraded, never
unlimited) rather than allowing unlimited traffic.

## Healthcheck

Two probes (US-492):

- **`GET /health` — liveness (restart probe).** Cheap, dependency-free. The
  Dockerfile `HEALTHCHECK` and Coolify (`coolify.healthcheckPath=/health`) hit
  this; the container is marked unhealthy after 3 consecutive failures (90 s
  window, 15 s startup grace) and restarted. It deliberately does NOT touch the
  DB — restarting can't fix a DB outage, and a dependency blip must not
  crash-loop a healthy process.
- **`GET /health/ready` — readiness.** Probes hard dependencies (Postgres
  reachable via a tiny HEAD query + critical env present) and returns **503**
  when one is down, so a load balancer / orchestrator can stop routing traffic
  to a container that's up but can't serve. Use this (not `/health`) for any
  traffic-gating or deploy-gating readiness check; keep the restart probe on
  `/health`.

## Updating

Pushing to the tracked branch triggers a Coolify rebuild + rolling restart.
The compose file does not pin a tag — the build uses the current Dockerfile.

## Apply migrations BEFORE the edge rolls (deploy-ordering gate)

**Why:** the edge image bakes in `EXPECTED_SCHEMA_VERSION` (bumped in the same
commit as each migration), but prod migrations apply as a *separate* step. If the
new container boots against a DB that hasn't applied that migration yet, the
US-778 schema-version guard refuses to start — and because that happens before
`Deno.serve`, the **whole service** 503s (`no available server`) until the
migration lands. The deploy order in `DEPLOY.md` is DB → edge → frontend; this
gate makes "DB first" automatic instead of a thing you have to remember.

**The gate — a Coolify Pre-deployment Command.** In the edge-functions resource:
*Settings → General → Pre-deployment Command* (runs on the Coolify host, which
already reaches prod Postgres and has the repo checked out for the build):

```bash
SUPABASE_DB_URL="$SUPABASE_DB_URL" bash scripts/apply-prod-migrations.sh
```

- Set **`SUPABASE_DB_URL`** (the direct `postgres://…:5432/postgres` connection
  string, **not** the PostgREST URL) as an env var on the resource. The host
  needs `psql` (`apt-get install -y postgresql-client`).
- The script is **idempotent** (every migration is `IF NOT EXISTS` / `CREATE OR
  REPLACE` + an `ON CONFLICT DO NOTHING` self-record footer) and only applies
  files newer than the DB's recorded version, so re-running it on every deploy is
  a few quick `SELECT`s when nothing is pending.
- If the migration step fails, the pre-deploy command exits non-zero and Coolify
  **aborts the rollout** — the old (working) container keeps serving. That's the
  point: a bad/failed migration never reaches the boot guard.
- Locally / by hand the same thing is `npm run migrate:prod` (with
  `SUPABASE_DB_URL` exported). Always back up first — migrations are forward-only
  (`BACKUPS.md`).

**Safety net (still in place):** even with the gate, the boot guard now waits out
a short **grace window** (`SCHEMA_GUARD_GRACE_ATTEMPTS` × `SCHEMA_GUARD_GRACE_DELAY_MS`,
default ≈ 40 s) on a behind-version before exiting, so a near-simultaneous
migration/deploy race resolves into a brief delayed start rather than a
crash-loop. The gate prevents the race; the grace window absorbs the residual.

## Scheduled jobs

Chosen approach: **Coolify scheduled tasks** hitting the existing internal
endpoints with `FLIPDESK_INTERNAL_JOB_SECRET` as a bearer token. No second
container — keeps deployment surface minimal and routes through the same
healthcheck + restart policy.

### Required env var

```
FLIPDESK_INTERNAL_JOB_SECRET=<long random>
```

Generate with `openssl rand -hex 32`. Set on the edge-functions resource;
each scheduled task injects the same value into its `Authorization` header.

### Cron entries

Configure these as **Scheduled Tasks** on the edge-functions resource in
Coolify (Settings → Scheduled Tasks → New). The container field is the
edge-functions service; the command runs *inside* the container so
`functions.gradethread.com` resolves over the internal network.

All scheduled-job handlers authenticate with the `X-Internal-Job-Secret`
header (not Authorization: Bearer) — the header name must match exactly or
the handler returns 401. Every task's command follows the same template —
substitute the endpoint + secret from the table:

```
curl -fsS -X POST -H "X-Internal-Job-Secret: $<SECRET_ENV>" http://localhost:8787<ENDPOINT>
```

<!-- cron-registry:start (generated - see src/lib/cron-runs.ts + scripts/render-cron-docs.ts; drift-guarded by cron-registry-drift_test.ts) -->
| Task | Schedule (UTC) | Endpoint (POST) | Secret env | Notes |
|---|---|---|---|---|
| abuse-scan | `0 */6 * * *` | `/api/jobs/abuse-scan` | `$FLIPDESK_INTERNAL_JOB_SECRET` |  |
| affiliate-payouts | `15 */6 * * *` | `/api/jobs/affiliate-payouts` | `$FLIPDESK_INTERNAL_JOB_SECRET` |  |
| agent-tick | `*/10 * * * *` | `/api/jobs/agent-tick` | `$FLIPDESK_INTERNAL_JOB_SECRET` |  |
| ai-budget-guardrails | `*/15 * * * *` | `/api/jobs/ai-budget-guardrails` | `$FLIPDESK_INTERNAL_JOB_SECRET` |  |
| appstore-expiry-sweep | `45 1 * * *` | `/api/jobs/appstore-expiry-sweep` | `$FLIPDESK_INTERNAL_JOB_SECRET` |  |
| audit-anomaly-scan | `5 * * * *` | `/api/jobs/audit-anomaly-scan` | `$FLIPDESK_INTERNAL_JOB_SECRET` |  |
| autolister-reclaim | `*/5 * * * *` | `/api/jobs/autolister-reclaim` | `$FLIPDESK_INTERNAL_JOB_SECRET` |  |
| automation-rules | `0 * * * *` | `/api/jobs/automation-rules` | `$FLIPDESK_INTERNAL_JOB_SECRET` |  |
| billing-reconciliation | `0 5 * * *` | `/api/jobs/billing-reconciliation` | `$FLIPDESK_INTERNAL_JOB_SECRET` |  |
| cert-integrity-backfill | `0 6 * * *` | `/api/jobs/cert-integrity-backfill` | `$FLIPDESK_INTERNAL_JOB_SECRET` | ONE-OFF at launch (idempotent; disable once drained) |
| condition-index-refresh | `0 8 * * *` | `/api/jobs/condition-index-refresh` | `$FLIPDESK_INTERNAL_JOB_SECRET` |  |
| confidence-calibration | `0 13 * * 0` | `/api/jobs/confidence-calibration` | `$FLIPDESK_INTERNAL_JOB_SECRET` |  |
| consignor-payouts | `*/30 * * * *` | `/api/jobs/consignor-payouts` | `$FLIPDESK_INTERNAL_JOB_SECRET` |  |
| content-digest | `0 14 * * 1` | `/api/content/scheduler/digest` | `$CONTENT_INTERNAL_JOB_SECRET` | not in the cron_runs ledger |
| content-refresh | `30 4 * * *` | `/api/jobs/content-refresh` | `$FLIPDESK_INTERNAL_JOB_SECRET` |  |
| content-tick | `0 * * * *` | `/api/content/scheduler/tick` | `$CONTENT_INTERNAL_JOB_SECRET` | 200 with skipped:true when idle (cadence gate) — NOT ok:true; not in the cron_runs ledger |
| content-watchdog | `0 */3 * * *` | `/api/jobs/content-watchdog` | `$FLIPDESK_INTERNAL_JOB_SECRET` |  |
| data-retention | `0 4 * * *` | `/api/jobs/data-retention` | `$FLIPDESK_INTERNAL_JOB_SECRET` |  |
| drip-tick | `0 * * * *` | `/api/drip/tick` | `$DRIP_INTERNAL_JOB_SECRET` |  |
| ebay-leave-feedback | `0 10 * * *` | `/api/flipdesk/ebay/jobs/leave-feedback` | `$FLIPDESK_INTERNAL_JOB_SECRET` | 200; no-op unless system setting feedback.auto_leave=true |
| ebay-orders-sync | `*/30 * * * *` | `/api/flipdesk/ebay/listings/pull` | `$FLIPDESK_INTERNAL_JOB_SECRET` | not in the cron_runs ledger |
| ebay-pending-webhooks | `*/15 * * * *` | `/api/jobs/ebay-pending-webhooks` | `$FLIPDESK_INTERNAL_JOB_SECRET` |  |
| ebay-performance-sync | `0 */6 * * *` | `/api/flipdesk/ebay/sync/performance` | `$FLIPDESK_INTERNAL_JOB_SECRET` |  |
| ebay-promoted-sync | `0 */6 * * *` | `/api/flipdesk/ebay/jobs/promoted-sync` | `$FLIPDESK_INTERNAL_JOB_SECRET` |  |
| ebay-publish-due | `*/5 * * * *` | `/api/flipdesk/ebay/jobs/publish-due` | `$FLIPDESK_INTERNAL_JOB_SECRET` |  |
| ebay-token-refresh | `0 * * * *` | `/api/flipdesk/ebay/oauth/refresh` | `$FLIPDESK_INTERNAL_JOB_SECRET` | not in the cron_runs ledger |
| email-retry | `*/5 * * * *` | `/api/jobs/email-retry` | `$FLIPDESK_INTERNAL_JOB_SECRET` |  |
| exemplar-assembly | `0 12 * * 0` | `/api/jobs/exemplar-assembly` | `$FLIPDESK_INTERNAL_JOB_SECRET` |  |
| google-sheet-sync | `*/5 * * * *` | `/api/flipdesk/google/sync/push` | `$FLIPDESK_INTERNAL_JOB_SECRET` | not in the cron_runs ledger |
| googleplay-expiry-sweep | `50 1 * * *` | `/api/jobs/googleplay-expiry-sweep` | `$FLIPDESK_INTERNAL_JOB_SECRET` |  |
| grading-monitor | `0 */12 * * *` | `/api/jobs/grading-monitor` | `$FLIPDESK_INTERNAL_JOB_SECRET` |  |
| growth-dispatch | `*/15 * * * *` | `/api/jobs/growth-dispatch` | `$FLIPDESK_INTERNAL_JOB_SECRET` |  |
| gsc-sync | `30 6 * * *` | `/api/jobs/gsc-sync` | `$FLIPDESK_INTERNAL_JOB_SECRET` |  |
| integrity-scan | `0 7 * * *` | `/api/jobs/integrity-scan` | `$FLIPDESK_INTERNAL_JOB_SECRET` |  |
| journey-tick | `30 13 * * *` | `/api/jobs/journey-tick` | `$FLIPDESK_INTERNAL_JOB_SECRET` |  |
| keyword-research | `0 6 * * 1` | `/api/jobs/keyword-research` | `$FLIPDESK_INTERNAL_JOB_SECRET` |  |
| listing-prompt-promote | `0 9 * * *` | `/api/jobs/listing-prompt-promote` | `$FLIPDESK_INTERNAL_JOB_SECRET` |  |
| marketplace-events | `*/15 * * * *` | `/api/jobs/marketplace-events` | `$FLIPDESK_INTERNAL_JOB_SECRET` |  |
| newsletter-ab-finalize | `*/15 * * * *` | `/api/jobs/newsletter-ab-finalize` | `$FLIPDESK_INTERNAL_JOB_SECRET` |  |
| newsletter-dispatch | `0 * * * *` | `/api/jobs/newsletter-dispatch` | `$FLIPDESK_INTERNAL_JOB_SECRET` |  |
| newsletter-kickoff | `0 * * * *` | `/api/newsletter/scheduler/tick` | `$NEWSLETTER_INTERNAL_JOB_SECRET` |  |
| newsletter-topic-bank-refill | `0 5 * * 1` | `/api/jobs/newsletter-topic-bank-refill` | `$FLIPDESK_INTERNAL_JOB_SECRET` |  |
| newsletter-tuning | `45 12 * * *` | `/api/jobs/newsletter-tuning` | `$FLIPDESK_INTERNAL_JOB_SECRET` |  |
| north-star-digest | `0 14 * * 1` | `/api/jobs/north-star-digest` | `$FLIPDESK_INTERNAL_JOB_SECRET` |  |
| operator-brief | `0 13 * * *` | `/api/jobs/operator-brief` | `$FLIPDESK_INTERNAL_JOB_SECRET` |  |
| passport-backfill | `*/15 * * * *` | `/api/jobs/passport-backfill` | `$FLIPDESK_INTERNAL_JOB_SECRET` | ONE-OFF at launch (idempotent; disable once drained) |
| passport-integrity-scan | `0 */6 * * *` | `/api/jobs/passport-integrity-scan` | `$FLIPDESK_INTERNAL_JOB_SECRET` |  |
| photo-archive | `0 4 * * *` | `/api/flipdesk/images/archive` | `$FLIPDESK_INTERNAL_JOB_SECRET` | not in the cron_runs ledger |
| publish-batch-reclaim | `*/5 * * * *` | `/api/jobs/publish-batch-reclaim` | `$FLIPDESK_INTERNAL_JOB_SECRET` |  |
| push-token-prune | `0 3 * * *` | `/api/jobs/push-token-prune` | `$FLIPDESK_INTERNAL_JOB_SECRET` |  |
| reconciliation-sweep | `0 5 * * *` | `/api/flipdesk/reconciliation/run` | `$FLIPDESK_INTERNAL_JOB_SECRET` | not in the cron_runs ledger |
| reprice-rules | `0 */6 * * *` | `/api/jobs/reprice-rules` | `$FLIPDESK_INTERNAL_JOB_SECRET` |  |
| reprice-scan | `0 */6 * * *` | `/api/jobs/reprice-scan` | `$FLIPDESK_INTERNAL_JOB_SECRET` |  |
| stuck-submissions | `*/10 * * * *` | `/api/jobs/stuck-submissions` | `$FLIPDESK_INTERNAL_JOB_SECRET` |  |
| sync-reaper | `*/15 * * * *` | `/api/jobs/sync-reaper` | `$FLIPDESK_INTERNAL_JOB_SECRET` |  |
| thumbnail-backfill | `*/5 * * * *` | `/api/jobs/thumbnail-backfill` | `$FLIPDESK_INTERNAL_JOB_SECRET` |  |
| trial-expiry | `15 0 * * *` | `/api/jobs/trial-expiry` | `$FLIPDESK_INTERNAL_JOB_SECRET` |  |

_57 scheduled jobs. Default healthy response: 200 `{"ok":true,...}` (idle runs report skipped/zero counts). Generated from `src/lib/cron-runs.ts` CRON_REGISTRY — do not hand-edit._
<!-- cron-registry:end -->

> **Cadence notes (US-496):**
> - `reprice-scan` fans out one eBay Browse call per active listing — every 6h
>   balances freshness vs. rate budget; the eBay circuit breaker backs it off
>   during an outage (US-499) and the job lock prevents overlap (US-503).
> - `grading-monitor` re-runs the golden-set eval + production-accuracy check.
>   Set **`MONITOR_ALERT_EMAIL`** (and/or **`MONITOR_ALERT_WEBHOOK`** for
>   Slack/PagerDuty) so a regression actually pages someone; with neither set the
>   run records the alert but reports it as undelivered (US-502).
> - `content-watchdog` (US-869) is the heartbeat check for the auto-publisher: it
>   alerts the owner if the scheduler has had no healthy tick in 3h or its publish
>   webhooks fail >25% over 24h. Routes to **`CONTENT_ALERT_EMAIL`** (falling back
>   to `MONITOR_ALERT_EMAIL`/`SMTP_ADMIN_EMAIL`), plus optional
>   **`CONTENT_ALERT_WEBHOOK`** (falling back to `MONITOR_ALERT_WEBHOOK`). Only
>   meaningful once `content-scheduler-tick` is enabled (US-852).
> - `content-refresh` (US-875) is the freshness loop: once per day it refreshes
>   the single top stale-but-important published post (ranked by GSC
>   impressions/clicks when available, else a reading-time fallback), writing only
>   when the change is material — then it bumps `dateModified`, purges the
>   Cloudflare cache, and re-pings IndexNow. A per-post cooldown
>   (`content_settings.content_refresh_cooldown_days`, default 30) prevents
>   thrashing; toggle the whole job with `content_settings.auto_refresh_enabled`.
>   Each run logs to `content_scheduler_runs` (surface='refresh') and is counted
>   in the weekly digest.
> - `content-digest` (US-880) is the weekly owner readout. It reuses the
>   **`CONTENT_INTERNAL_JOB_SECRET`** (same secret as `content-scheduler-tick`,
>   NOT the FlipDesk one) and emails the engine summary — posts published, topic
>   bank + webhook health, GSC opportunities, refresh activity — plus tuning
>   recommendations that deep-link into the admin content UI. Routes to
>   **`CONTENT_DIGEST_EMAIL`** (falling back to `CONTENT_ALERT_EMAIL` /
>   `SMTP_ADMIN_EMAIL`); an undelivered digest is captured in Sentry, never
>   silent. Admins can also fire it on demand from `/admin/content/analytics`.
> - `audit-anomaly-scan` (US-905) hourly scans the last hour of `admin_audit_log`
>   for suspicious patterns — a single admin making more than
>   `audit_anomaly_role_changes_per_hour` role changes, more than
>   `audit_anomaly_refunds_per_hour` refunds/credits platform-wide, or any
>   destructive action outside `audit_anomaly_business_hours_start..end` (UTC) —
>   all tunable from the settings registry (`/admin/ops/settings`, category
>   `security`; master switch `audit_anomaly_enabled`). A fresh finding writes an
>   `admin_audit_anomalies` row (surfaced on `/admin/audit-log`) and pages via
>   **`AUDIT_ALERT_EMAIL`**/**`AUDIT_ALERT_WEBHOOK`** (falling back to
>   `MONITOR_ALERT_*`/`SMTP_ADMIN_EMAIL`). Idempotent per hour bucket, so it never
>   re-alerts the same window.
> - `automation-rules` (US-150) applies user-defined price-drop / promo / end
>   rules hourly (offset to :30 so it never races reprice-scan for the eBay
>   rate budget). Per-rule cooldowns stop hourly re-fires; overlap-locked.
> - `ebay-publish-due` (US-407) claims a **small bounded batch** (default 15,
>   override `PUBLISH_DUE_BATCH_LIMIT`) per tick so the run always finishes
>   inside its 240s job-lock lease; the 5-min cadence drains any larger backlog
>   over successive ticks (response `more: true` while a backlog remains). Each
>   draft is per-row claim-locked, so a crashed/redeployed container never
>   strands a publish — a stale claim is reclaimed on a later tick.
> - `ebay-sync-reaper` (US-407/US-456) flips any `flipdesk_sync_runs` row left
>   `running` past the stuck threshold (`SYNC_STUCK_THRESHOLD_MIN`, default 15m)
>   to `failed`, so a container that dies mid-pull doesn't strand the tenant's
>   sync lock until their next manual pull. The next 30-min `ebay-orders-sync`
>   tick re-pulls incrementally from `last_synced_at`, so the work resumes.
> - `stuck-submissions` fails+refunds grades stranded in `processing` (US-495);
>   `email-retry` re-sends failed critical email (US-498); `integrity-scan`
>   reports DB anomalies (US-504); `data-retention` purges grading photos past
>   the window (US-521). All are overlap-locked and idempotent.
> - `ebay-pending-webhooks` (US-472) drains `ebay_pending_webhook_events` — the
>   parking lot for verified payout/order/return notifications that arrived
>   before a freshly-connected seller's `account_handle`/`external_account_id`
>   hydrated. Each tick re-attempts linkage (the id usually hydrates on the next
>   hourly token refresh) and replays linked events (payout → dedup ingest,
>   order/return → targeted sync); after 8 attempts a row is dead-lettered + a
>   warning is captured so the operator can fall back to a CSV payout import.
>   Metrics: `webhook.dropped_no_handle` (parked), `webhook.pending_linked`,
>   `webhook.pending_dead_lettered`. Overlap-locked.
> - `drip-tick` (US-943) is the autonomous **trial-conversion drip** orchestrator:
>   hourly it enrolls active trialists, sends the next due step of the
>   `trial_conversion` campaign (welcome → in-trial nurture → urgency → post-trial
>   win-back), and exits an enrollment the moment the user converts. It self-gates
>   on `next_evaluation_at` + a job lock, so an hourly cadence is safe. Two
>   gotchas: (1) it uses its **own** secret **`DRIP_INTERNAL_JOB_SECRET`** (NOT the
>   FlipDesk one — an empty/mismatched value fails closed with 401); (2) the
>   campaign is seeded `status='active'` and the `trial_conversion_drip` flag
>   fails-open, so the FIRST tick after this task goes live will enroll every
>   current trialist and may send catch-up steps — enable during a quiet window
>   and watch the first run's counts. Records to `cron_runs` as `drip-tick`.

Use `http://localhost:8787` from inside the container (not the public FQDN)
so scheduled jobs don't take the round-trip through Traefik + WAF and
don't count against rate limits.

**`curl` prerequisite:** every command above is a `curl` call, and `curl` is
installed in the edge image on purpose (see the Dockerfile `apt-get install …
curl` line). If a rebuild ever drops it, EVERY scheduled task silently no-ops —
the command dies with `curl: not found` before the request is made, so the app
logs show nothing (no `http.request` line for the endpoint). Symptom check: the
task appears to "fail" for any container name you try, and `cron_runs` has no
rows for it. Confirm with `which curl` in the container terminal.

### Verification

After saving, click **Run Now** on each scheduled task. Successful runs
return HTTP 200 with a JSON body; failures show up in the Coolify task log
and the container's stdout.

## Stripe pricing setup (US-203)

The full price catalog (FlipDesk subscriptions + GradeThread per-grade +
credit packs — 14 prices total) is provisioned by an idempotent script.

### First run

```bash
# Test mode (default)
STRIPE_SECRET_KEY=sk_test_... npm run setup:stripe

# Live mode (requires the --live flag as a safety check)
STRIPE_SECRET_KEY=sk_live_... npm run setup:stripe --live
```

The script:

- Creates Products with `metadata.gradethread_sku = '<sku>'` so it can find
  them again on re-run instead of duplicating.
- Creates monthly + yearly Prices for each FlipDesk plan, one-time Prices
  for each grade tier and credit pack.
- Sets `tax_behavior=exclusive` on every Price so Stripe Tax (US-223)
  applies automatically.
- Prints a `VITE_STRIPE_PRICE_*` env block at the end — paste it into both
  Cloudflare Pages (frontend) and this Coolify resource (edge needs the
  non-`VITE_`-prefixed aliases also printed).

### Updating prices

Stripe Prices are immutable on amount + interval. To change a price:

1. Edit the amount in `src/lib/constants.ts` (and `scripts/setup-stripe-pricing.mjs`).
2. Re-run `npm run setup:stripe` — it creates a new Price for the changed
   amount and prints its new ID.
3. Replace the env var with the new Price ID and redeploy.
4. Manually archive the old Price in the Stripe dashboard (the script
   intentionally does not auto-archive, to avoid breaking active subscriptions).
