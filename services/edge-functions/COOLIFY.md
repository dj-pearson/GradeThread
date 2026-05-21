# Coolify deployment

This service hosts both GradeThread and FlipDesk edge endpoints behind one
container. Deploy it as a single Coolify resource.

## One-time setup

1. In Coolify: **New Resource → Docker Compose → from Git**.
2. Point at this repository.
3. Set the compose file path to `services/edge-functions/docker-compose.coolify.yml`.
4. Set the FQDN to `api.gradethread.com` (or override `COOLIFY_FQDN`).
5. Add the env vars from `.env.example` (Supabase, Anthropic, Stripe, eBay, R2).
6. Save and deploy.

Coolify reads the `coolify.*` labels on the service to provision a Traefik
route with Let's Encrypt. The fallback `traefik.*` labels match the same
behavior if you're running plain Traefik instead of Coolify.

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

## Scheduled jobs (future)

`ebay-token-refresh`, `photo-archiver`, and `reconciliation-matcher` are
intended to run on a schedule. Two options:

1. **Coolify scheduled tasks** — add cron-style entries that hit the
   corresponding `POST /api/flipdesk/...` endpoint with a shared secret.
2. **A second container** — add a sibling service that runs a Deno cron loop
   and calls the same endpoints. Add to this compose file when implemented.
