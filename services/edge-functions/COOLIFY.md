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
the handler returns 401.

| Name                    | Schedule (UTC)         | Command                                                                                                                                            |
| ----------------------- | ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| ebay-token-refresh      | `0 * * * *` (hourly)   | `curl -fsS -X POST -H "X-Internal-Job-Secret: $FLIPDESK_INTERNAL_JOB_SECRET" http://localhost:8787/api/flipdesk/ebay/oauth/refresh`                |
| photo-archive           | `0 4 * * *` (04:00)    | `curl -fsS -X POST -H "X-Internal-Job-Secret: $FLIPDESK_INTERNAL_JOB_SECRET" http://localhost:8787/api/flipdesk/images/archive`                    |
| reconciliation-sweep    | `0 5 * * *` (05:00)    | `curl -fsS -X POST -H "X-Internal-Job-Secret: $FLIPDESK_INTERNAL_JOB_SECRET" http://localhost:8787/api/flipdesk/reconciliation/run`                |
| ebay-orders-sync        | `*/30 * * * *` (30min) | `curl -fsS -X POST -H "X-Internal-Job-Secret: $FLIPDESK_INTERNAL_JOB_SECRET" http://localhost:8787/api/flipdesk/ebay/listings/pull`                |
| ebay-performance-sync   | `0 */6 * * *` (6h)     | `curl -fsS -X POST -H "X-Internal-Job-Secret: $FLIPDESK_INTERNAL_JOB_SECRET" http://localhost:8787/api/flipdesk/ebay/sync/performance`             |
| ebay-publish-due        | `*/5 * * * *` (5min)   | `curl -fsS -X POST -H "X-Internal-Job-Secret: $FLIPDESK_INTERNAL_JOB_SECRET" http://localhost:8787/api/flipdesk/ebay/jobs/publish-due`             |
| ebay-promoted-sync      | `0 */6 * * *` (6h)     | `curl -fsS -X POST -H "X-Internal-Job-Secret: $FLIPDESK_INTERNAL_JOB_SECRET" http://localhost:8787/api/flipdesk/ebay/jobs/promoted-sync`           |
| ebay-sync-reaper        | `*/15 * * * *` (15min) | `curl -fsS -X POST -H "X-Internal-Job-Secret: $FLIPDESK_INTERNAL_JOB_SECRET" http://localhost:8787/api/jobs/sync-reaper`                           |
| gsc-sync                | `30 6 * * *` (06:30)   | `curl -fsS -X POST -H "X-Internal-Job-Secret: $FLIPDESK_INTERNAL_JOB_SECRET" http://localhost:8787/api/jobs/gsc-sync`                              |
| trial-check             | `0 14 * * *` (14:00)   | `curl -fsS -X POST -H "X-Internal-Job-Secret: $FLIPDESK_INTERNAL_JOB_SECRET" http://localhost:8787/api/notifications/trial-check`                  |
| trial-expiry            | `15 0 * * *` (00:15)   | `curl -fsS -X POST -H "X-Internal-Job-Secret: $FLIPDESK_INTERNAL_JOB_SECRET" http://localhost:8787/api/jobs/trial-expiry`                          |
| autolister-reclaim      | `*/5 * * * *` (5min)   | `curl -fsS -X POST -H "X-Internal-Job-Secret: $FLIPDESK_INTERNAL_JOB_SECRET" http://localhost:8787/api/jobs/autolister-reclaim`                    |
| publish-batch-reclaim   | `*/5 * * * *` (5min)   | `curl -fsS -X POST -H "X-Internal-Job-Secret: $FLIPDESK_INTERNAL_JOB_SECRET" http://localhost:8787/api/jobs/publish-batch-reclaim`                 |
| reprice-scan            | `0 */6 * * *` (6h)     | `curl -fsS -X POST -H "X-Internal-Job-Secret: $FLIPDESK_INTERNAL_JOB_SECRET" http://localhost:8787/api/jobs/reprice-scan`                          |
| automation-rules        | `30 * * * *` (hourly)  | `curl -fsS -X POST -H "X-Internal-Job-Secret: $FLIPDESK_INTERNAL_JOB_SECRET" http://localhost:8787/api/jobs/automation-rules`                      |
| grading-monitor         | `0 */12 * * *` (12h)   | `curl -fsS -X POST -H "X-Internal-Job-Secret: $FLIPDESK_INTERNAL_JOB_SECRET" http://localhost:8787/api/jobs/grading-monitor`                       |
| stuck-submissions       | `*/10 * * * *` (10min) | `curl -fsS -X POST -H "X-Internal-Job-Secret: $FLIPDESK_INTERNAL_JOB_SECRET" http://localhost:8787/api/jobs/stuck-submissions`                     |
| email-retry             | `*/5 * * * *` (5min)   | `curl -fsS -X POST -H "X-Internal-Job-Secret: $FLIPDESK_INTERNAL_JOB_SECRET" http://localhost:8787/api/jobs/email-retry`                           |
| integrity-scan          | `0 7 * * *` (07:00)    | `curl -fsS -X POST -H "X-Internal-Job-Secret: $FLIPDESK_INTERNAL_JOB_SECRET" http://localhost:8787/api/jobs/integrity-scan`                        |
| data-retention          | `0 4 * * *` (04:00)    | `curl -fsS -X POST -H "X-Internal-Job-Secret: $FLIPDESK_INTERNAL_JOB_SECRET" http://localhost:8787/api/jobs/data-retention`                        |
| condition-index-refresh | `0 8 * * *` (08:00)    | `curl -fsS -X POST -H "X-Internal-Job-Secret: $FLIPDESK_INTERNAL_JOB_SECRET" http://localhost:8787/api/jobs/condition-index-refresh`              |
| push-token-prune        | `0 3 * * *` (03:00)    | `curl -fsS -X POST -H "X-Internal-Job-Secret: $FLIPDESK_INTERNAL_JOB_SECRET" http://localhost:8787/api/jobs/push-token-prune`                |
| ebay-pending-webhooks   | `*/15 * * * *` (15min) | `curl -fsS -X POST -H "X-Internal-Job-Secret: $FLIPDESK_INTERNAL_JOB_SECRET" http://localhost:8787/api/jobs/ebay-pending-webhooks`                 |
| north-star-digest       | `0 14 * * 1` (Mon 14:00) | `curl -fsS -X POST -H "X-Internal-Job-Secret: $FLIPDESK_INTERNAL_JOB_SECRET" http://localhost:8787/api/jobs/north-star-digest`                   |
| content-watchdog        | `0 */3 * * *` (3h)     | `curl -fsS -X POST -H "X-Internal-Job-Secret: $FLIPDESK_INTERNAL_JOB_SECRET" http://localhost:8787/api/jobs/content-watchdog`                      |

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

Use `http://localhost:8787` from inside the container (not the public FQDN)
so scheduled jobs don't take the round-trip through Traefik + WAF and
don't count against rate limits.

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
