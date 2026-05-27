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

## Healthcheck

Docker healthcheck and Coolify both hit `GET /health`. The container is marked
unhealthy after 3 consecutive failures (90 s window, 15 s startup grace).

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

| Name                    | Schedule (UTC)         | Command                                                                                                                                              |
| ----------------------- | ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| ebay-token-refresh      | `0 * * * *` (hourly)   | `curl -fsS -X POST -H "Authorization: Bearer $FLIPDESK_INTERNAL_JOB_SECRET" http://localhost:8787/api/flipdesk/ebay/oauth/refresh`                    |
| photo-archive           | `0 4 * * *` (04:00)    | `curl -fsS -X POST -H "Authorization: Bearer $FLIPDESK_INTERNAL_JOB_SECRET" http://localhost:8787/api/flipdesk/images/archive`                       |
| reconciliation-sweep    | `0 5 * * *` (05:00)    | `curl -fsS -X POST -H "Authorization: Bearer $FLIPDESK_INTERNAL_JOB_SECRET" http://localhost:8787/api/flipdesk/reconciliation/run`                   |
| ebay-orders-sync        | `*/30 * * * *` (30min) | `curl -fsS -X POST -H "Authorization: Bearer $FLIPDESK_INTERNAL_JOB_SECRET" http://localhost:8787/api/flipdesk/ebay/listings/pull`                   |

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
