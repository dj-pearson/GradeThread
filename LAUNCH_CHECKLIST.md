# Production Launch Checklist (US-779)

The single gate before flipping GradeThread to production. Work top-to-bottom;
initial + date each row as you verify it. "Where" = which dashboard holds the
setting. "Verify" = the concrete command/observable that proves it works.

> Deploy order, rollback, and the Cloudflare/Coolify trigger mechanics live in
> **`DEPLOY.md`**. This file is the *what's configured + is it working* gate.

Legend: ☐ todo · ☑ done. Fill the **By / Date** column.

---

## 1. Environment variables

The edge service validates these at boot (US-777): a missing **required** var
**crashes** the container in production; a missing **feature group** only warns +
shows on `/health/ready` → `features`. Authoritative lists with per-var comments:
`services/edge-functions/.env.example` (edge) and `.env.example` (frontend).

### 1a. Edge service — REQUIRED (Coolify → service → Environment Variables)

| Var | Where | Verify | By / Date |
|---|---|---|---|
| `SUPABASE_URL` | Coolify | `/health/ready` → `checks.database: ok` | ☐ |
| `SUPABASE_SERVICE_ROLE_KEY` | Coolify (Supabase → API) | same as above | ☐ |
| `ANTHROPIC_API_KEY` (or `CLAUDE_API_KEY`) | Coolify | submit a test grade → it completes | ☐ |
| `STRIPE_SECRET_KEY` | Coolify (Stripe → Developers) | `stripe trigger checkout.session.completed` lands in logs | ☐ |
| `STRIPE_WEBHOOK_SECRET` | Coolify (Stripe → Webhooks → signing secret) | webhook returns 200, not 400 sig-fail | ☐ |
| `FLIPDESK_INTERNAL_JOB_SECRET` | Coolify | a cron **Run Now** returns `{ok:true}` (§3) | ☐ |
| `CONTENT_INTERNAL_JOB_SECRET` | Coolify (own secret, ≠ FlipDesk) | `content-scheduler-tick` **Run Now** returns JSON (§3); `docs/CONTENT_SCHEDULER.md` | ☐ |
| `EDGE_ENCRYPTION_KEY` | Coolify (`openssl rand -base64 32`) | connect an eBay account → token stored | ☐ |
| `CERT_SIGNING_KEY` | Coolify (`openssl rand -hex 32`) | `/api/content/public/certificates/<id>/verify` → `signed:true` | ☐ |
| `API_KEY_PEPPER` | Coolify (set BEFORE issuing prod API keys) | issue + use an API key | ☐ |
| `EDGE_ENV=production` | Coolify | `/health` shows prod posture; debug flags inert | ☐ |

> Boot proof: after deploy, `curl -fsS https://functions.gradethread.com/health/ready | jq`
> must be `status:"ready"`. If the container crash-loops, read the logs — a
> missing required var prints `[BOOT] Missing required env: …`.

### 1b. Edge service — FEATURE GROUPS (degrade, don't crash)

Each row: confirm `/health/ready` → `features.<group>` is `"ok"`.

| Group | Vars | Verify | By / Date |
|---|---|---|---|
| `stripe_prices` | `STRIPE_PRICE_FLIPDESK_*` (6) + `STRIPE_PRICE_GRADE_*` (3) | plan picker shows prices; checkout opens | ☐ |
| `ebay` | `EBAY_APP_ID/CERT_ID/DEV_ID/VERIFICATION_TOKEN` | eBay OAuth connect succeeds | ☐ |
| `smtp` | `SMTP_HOST/USER/PASS/ADMIN_EMAIL` | trigger a welcome email; it arrives | ☐ |
| `google_photos` | `GOOGLE_PHOTOS_CLIENT_ID/SECRET` (or shared `GOOGLE_CLIENT_*`) | AutoLister Google Photos import opens picker | ☐ |
| `observability` | `SENTRY_DSN` | `/health` → `errorTracking:"enabled"`; hit `/health/_throw` in staging → event in Sentry | ☐ |
| (also) | `COMPANY_POSTAL_ADDRESS` | a sent email footer shows the real address (CAN-SPAM) | ☐ |
| (also) | `MONITOR_ALERT_EMAIL`, `DISPUTE_ALERT_EMAIL` | grading-monitor / dispute alerts route correctly | ☐ |

### 1c. Frontend (Cloudflare Pages → Settings → Environment variables → Production)

| Var | Where | Verify | By / Date |
|---|---|---|---|
| `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` | Pages | login works on the live site | ☐ |
| `VITE_STRIPE_PUBLISHABLE_KEY` | Pages (Stripe) | checkout button loads Stripe | ☐ |
| `VITE_EDGE_API_URL` | Pages (`https://functions.gradethread.com`) | dashboard data loads (not 404) | ☐ |
| `VITE_SENTRY_DSN` | Pages | a forced client error shows in Sentry | ☐ |
| `VITE_POSTHOG_KEY` / `VITE_POSTHOG_HOST` | Pages | events appear in PostHog | ☐ |
| `VITE_GOOGLE_SITE_VERIFICATION` / `VITE_BING_SITE_VERIFICATION` | Pages (GSC / Bing) | view-source shows the verification `<meta>` | ☐ |
| `VITE_RELEASE_SHA=$CF_PAGES_COMMIT_SHA` | Pages build command | footer build tag shows the SHA | ☐ |
| `VITE_CF_IMAGE_RESIZING` | Pages — `true` ONLY after enabling zone Transformations | images load (no broken srcset) | ☐ |

---

## 2. Third-party dashboards

| Item | Where | Verify | By / Date |
|---|---|---|---|
| Stripe products + prices created (subs, per-grade, credit packs) | Stripe Dashboard | `STRIPE_PRICE_*` ids match live prices | ☐ |
| Stripe webhook endpoint → `https://functions.gradethread.com/api/webhooks/stripe` | Stripe → Webhooks | `stripe trigger` delivers 200 | ☐ |
| Stripe **live mode** keys in use (not test) | Stripe | keys start `sk_live`/`pk_live` | ☐ |
| Supabase Auth: `GOTRUE_SITE_URL=https://gradethread.com` (NOT api.*) + `GOTRUE_URI_ALLOW_LIST` with all 5 callbacks (web ×3, iOS Universal Link, iOS custom scheme — see ENVIRONMENT.md) | self-hosted auth container env | web Google lands on /auth/callback; `state` JWT `site_url` = gradethread.com | ☐ |
| Supabase Auth: Google OAuth creds (`GOTRUE_EXTERNAL_GOOGLE_*`) | self-hosted auth container env | "Continue with Google" works on web + iOS | ☐ |
| Supabase Auth: Apple provider (`GOTRUE_EXTERNAL_APPLE_ENABLED=true`, `CLIENT_ID=com.gradethread.app`) | self-hosted auth container env | `/auth/v1/settings` shows `"apple": true`; iOS Apple sign-in completes | ☐ |
| eBay app keys promoted to production + Marketplace Account Deletion endpoint registered | eBay Developer | OAuth connect + a test notification verify | ☐ |
| DNS: `functions.gradethread.com` → Coolify; `api.gradethread.com` → Supabase Kong; apex → Pages | Cloudflare DNS | `/health` on functions.*, REST on api.* | ☐ |
| IndexNow key file hosted at `/<INDEXNOW_KEY>.txt` | `public/` + Pages | the file resolves 200 | ☐ |

---

## 3. Coolify scheduled tasks

Add **each** task (Coolify → service → Scheduled Tasks), then click **Run Now**
and confirm the expected output. All hit `http://localhost:8787` (in-container,
skips Traefik/WAF) with header `X-Internal-Job-Secret: $FLIPDESK_INTERNAL_JOB_SECRET`.
A healthy run returns `{"ok":true,...}`. Reference: `services/edge-functions/COOLIFY.md`.

> The `content-scheduler-tick` task is the **one exception** to the shared
> header: it authenticates with `X-Internal-Job-Secret: $CONTENT_INTERNAL_JOB_SECRET`
> (its own secret) and a healthy idle run returns `{"skipped":true,...}`, not
> `{"ok":true}`. See `docs/CONTENT_SCHEDULER.md` for the safe low-cadence rollout.

> **COOLIFY.md drift (fix at launch):** its table predates four jobs —
> `growth-dispatch`, `reprice-rules`, `sync-reaper`, `google-sheet-sync` are
> registered in `main.ts` but missing from that table. This checklist is the
> authoritative set (19 tasks).

| Task | Schedule | Endpoint (POST) | Run Now ✓ | By / Date |
|---|---|---|---|---|
| ebay-token-refresh | `0 * * * *` | `/api/flipdesk/ebay/oauth/refresh` | ☐ | |
| ebay-orders-sync | `*/30 * * * *` | `/api/flipdesk/ebay/listings/pull` | ☐ | |
| ebay-performance-sync | `0 */6 * * *` | `/api/flipdesk/ebay/sync/performance` | ☐ | |
| ebay-publish-due | `*/5 * * * *` | `/api/flipdesk/ebay/jobs/publish-due` | ☐ | |
| ebay-leave-feedback | `0 10 * * *` | `/api/flipdesk/ebay/jobs/leave-feedback` | ☐ | no-op unless system setting `feedback.auto_leave`=true (US-1047) |
| gsc-sync | `30 6 * * *` | `/api/jobs/gsc-sync` | ☐ | |
| trial-expiry | `15 0 * * *` | `/api/jobs/trial-expiry` | ☐ | |
| appstore-expiry-sweep | `30 */6 * * *` | `/api/jobs/appstore-expiry-sweep` | ☐ | backstop: lapses appstore-billed users to free when Apple's expiry notification was lost (stale period_end past a 72h grace; tune `APPSTORE_SWEEP_GRACE_HOURS`) (US-811) |
| autolister-reclaim | `*/5 * * * *` | `/api/jobs/autolister-reclaim` | ☐ | |
| publish-batch-reclaim | `*/5 * * * *` | `/api/jobs/publish-batch-reclaim` | ☐ | |
| reprice-scan | `0 */6 * * *` | `/api/jobs/reprice-scan` | ☐ | |
| reprice-rules | `0 */6 * * *` | `/api/jobs/reprice-rules` | ☐ | |
| grading-monitor | `0 */12 * * *` | `/api/jobs/grading-monitor` | ☐ | |
| stuck-submissions | `*/10 * * * *` | `/api/jobs/stuck-submissions` | ☐ | |
| email-retry | `*/5 * * * *` | `/api/jobs/email-retry` | ☐ | |
| integrity-scan | `0 7 * * *` | `/api/jobs/integrity-scan` | ☐ | |
| data-retention | `0 4 * * *` | `/api/jobs/data-retention` | ☐ | |
| condition-index-refresh | `0 8 * * *` | `/api/jobs/condition-index-refresh` | ☐ | |
| sync-reaper | `*/15 * * * *` | `/api/jobs/sync-reaper` | ☐ | |
| growth-dispatch | `*/15 * * * *` | `/api/jobs/growth-dispatch` | ☐ | |
| push-token-prune | `0 3 * * *` | `/api/jobs/push-token-prune` | ☐ | |
| google-sheet-sync | `*/5 * * * *` | `/api/flipdesk/google/sync/push` | ☐ | full 2-way merge (push **and** pull); `/sync/pull` is an alias |
| ebay-pending-webhooks | `*/15 * * * *` | `/api/jobs/ebay-pending-webhooks` | ☐ | re-links parked payout/order/return events once the seller's handle/id hydrates (US-472) |
| north-star-digest | `0 14 * * 1` | `/api/jobs/north-star-digest` | ☐ | weekly (Mon) items-listed encouragement + milestone emails, streak tracking (US-597) |
| content-scheduler-tick | `0 * * * *` | `/api/content/scheduler/tick` | ☐ | **uses `CONTENT_INTERNAL_JOB_SECRET`**; idle returns `{skipped:true}`. Hourly tick enforces per-day cadence + promotes scheduled drafts. Start with autopilot OFF — `docs/CONTENT_SCHEDULER.md` (US-852) |
| content-watchdog | `0 */3 * * *` | `/api/jobs/content-watchdog` | ☐ | shared `FLIPDESK_INTERNAL_JOB_SECRET`. Heartbeat check on the auto-publisher: alerts the owner if no healthy scheduler tick in 3h or >25% webhook failures over 24h. Routes to `CONTENT_ALERT_EMAIL`/`MONITOR_ALERT_EMAIL`/`SMTP_ADMIN_EMAIL` (+ optional `CONTENT_ALERT_WEBHOOK`) (US-869) |
| content-refresh | `30 4 * * *` | `/api/jobs/content-refresh` | ☐ | shared `FLIPDESK_INTERNAL_JOB_SECRET`. Daily freshness loop: refreshes the single top stale-but-important published post (GSC-weighted, else reading-time), only when the change is material — bumps dateModified, purges CF cache, re-pings IndexNow. Honours `content_settings.auto_refresh_enabled` + the cooldown/min-stale windows (US-875) |
| content-digest | `0 14 * * 1` | `/api/content/scheduler/digest` | ☐ | **uses `CONTENT_INTERNAL_JOB_SECRET`** (same as scheduler-tick). Weekly (Mon) owner readout: posts published, topic/webhook health, GSC opportunities + refresh activity, plus tuning recommendations that deep-link into the admin content UI. Routes to `CONTENT_DIGEST_EMAIL`/`CONTENT_ALERT_EMAIL`/`SMTP_ADMIN_EMAIL`; an undelivered digest is logged (Sentry), never silent. Admins can also fire it on demand from `/admin/content/analytics` (US-880) |
| ai-budget-guardrails | `*/15 * * * *` | `/api/jobs/ai-budget-guardrails` | ☐ | shared `FLIPDESK_INTERNAL_JOB_SECRET`. Evaluates per-feature AI spend budgets (`/admin/ai-spend`) and, on a fresh breach, alerts + (for action=kill) flips the matching feature kill-switch off. Routes to `AI_BUDGET_ALERT_EMAIL`/`MONITOR_ALERT_EMAIL`/`SMTP_ADMIN_EMAIL` (+ optional `AI_BUDGET_ALERT_WEBHOOK`/`MONITOR_ALERT_WEBHOOK`). Idle when no budgets configured (US-895) |

**One-off at launch (not scheduled):** POST `/api/jobs/cert-integrity-backfill`
(same secret header) once after the final pre-launch deploy — it seals every
pre-US-333 certified report with a content hash + HMAC signature so legacy
certificates verify instead of reporting "unverifiable" (US-490). Idempotent;
re-run until the response shows `scanned: 0`. The daily `integrity-scan` tick
then keeps reporting the signed / hash-only / unverifiable certificate share as
the `certificates.integrity_share` metric — after the backfill, `unverifiable`
should be 0 and `hash_only` should not grow (growth means CERT_SIGNING_KEY
dropped out of the environment).

---

## 4. Database

| Item | Verify | By / Date |
|---|---|---|
| All migrations applied (latest = `00132`) | `select version from supabase_migrations.schema_migrations order by version desc limit 1;` → `00132` | ☐ |
| Edge boots clean against prod schema (US-778) | edge logs show `[schema-version] OK` (not `STALE`) | ☐ |
| RLS enabled on every multi-tenant table | spot-check `select relrowsecurity from pg_class where relname='submissions';` → t | ☐ |

---

## 5. Backup + restore drill

Do a REAL restore drill before launch (not just "backups are configured"). Full
procedure: **`BACKUPS.md`**; mechanism: `scripts/ops/backup-postgres.sh`,
`backup-storage.sh`, `restore-postgres.sh`. The procedure itself is verified —
`scripts/ops/restore-drill.sh` ran PASS on 2026-06-12 against the local stack
(BACKUPS.md drill log). This section is the **prod** drill: restore a real
offsite dump on a scratch host. Record the result here so the drill has a home.

| Drill date | Backup restored (timestamp) | Restore target | Result (ok/fail) | By |
|---|---|---|---|---|
|  |  |  |  |  |
|  |  |  |  |  |

- ☐ Backup cron installed on the DB host (`BACKUPS.md` §Schedule) and the first
  nightly dump confirmed in the offsite bucket (with `.sha256` sidecar)
- ☐ R2 lifecycle rules created (30d on `pg/` and `storage-deleted/`)
- ☐ A prod offsite dump restored to a scratch Supabase Postgres via
  `restore-postgres.sh` and sanity-queried (row counts plausible)
- ☐ Restore runtime recorded above (informs RTO; targets in `BACKUPS.md`)
- ☐ `ALERT_WEBHOOK_URL` on both backup crons verified (break one on purpose,
  see the alert)

---

## 6. Post-deploy smoke (run after every prod deploy)

| Step | Command / observable | Pass | By / Date |
|---|---|---|---|
| Edge liveness | `curl -fsS https://functions.gradethread.com/health` → `status:ok` + release SHA | ☐ | |
| Edge readiness incl. features (US-777) | `…/health/ready \| jq` → `status:"ready"`, `features.*:"ok"` | ☐ | |
| Stripe webhook | `stripe trigger checkout.session.completed` → 200 in edge logs, no dead-letter | ☐ | |
| Certificate page | open a known `/cert/<id>` → grade + AI disclosure render; verify badge `verified` | ☐ | |
| SEO endpoints | `curl -fsS https://gradethread.com/{robots.txt,sitemap.xml,llms.txt}` → 200 | ☐ | |
| Pages Function routing (US-424) | `npm run smoke:functions -- https://gradethread.com --cert <id>` → all required routes Function-rendered, none shadowed by SPA shell | ☐ | |
| Critical path | run the Playwright e2e (or manual signup→submit→grade→cert) | ☐ | |
| Admin review queue | `/admin/reviews` loads; low-confidence grades appear | ☐ | |

---

## 7. Final go/no-go

- ☐ Sentry receiving events (edge + frontend); alert routing confirmed
- ☐ Uptime monitor live (US-500): `UPTIME_ALERT_WEBHOOK` + `SUPABASE_ANON_KEY`
  Actions secrets set, "Uptime" workflow green on manual dispatch, on-call
  watching the repo, `/status` page reachable — then run the failure drill in
  `docs/INCIDENT_RESPONSE.md` (see `UPTIME_MONITORING.md`). Drill date: ______
- ☐ Incident runbook reachable by on-call (`INCIDENT_RESPONSE.md`)
- ☐ Private on-call contact sheet (phone numbers for the escalation ladder)
  exists outside the repo and every responder knows where it is
  (`INCIDENT_RESPONSE.md` → "On-call & escalation")
- ☐ Pre-launch banner / `VITE_LAUNCH_DATE` set to self-expire (US-785)
- ☐ Reseller feature scope confirmed — Best Offer responses and returns/
  cancellations are **out of scope** for launch (handled in eBay Seller Hub);
  see `FLIPDESK_RESELLER_GAPS.md` (US-469)
- ☐ All blockers in `prd.json` (US-772…US-785) marked `passes:true`

**Launch approved by:** ________________  **Date:** ____________
