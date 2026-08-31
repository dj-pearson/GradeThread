---
title: Launch checklist
aliases: [LAUNCH_CHECKLIST, launch gate]
type: runbook
status: current
source_of_truth: vault
code_refs: []
reviewed: 2026-08-15
tags: [ops, launch, checklist]
summary: The env gate, scheduled tasks, backup drill and smoke tests before going live.
---
# Production Launch Checklist (US-779)

The single gate before flipping GradeThread to production. Work top-to-bottom;
initial + date each row as you verify it. "Where" = which dashboard holds the
setting. "Verify" = the concrete command/observable that proves it works.

> Deploy order, rollback, and the Cloudflare/Coolify trigger mechanics live in
> **`vault/10-ops/deploy.md`**. This file is the *what's configured + is it working* gate.

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
| `CONTENT_INTERNAL_JOB_SECRET` | Coolify (own secret, ≠ FlipDesk) | `content-scheduler-tick` **Run Now** returns JSON (§3); `vault/40-growth/content-scheduler.md` | ☐ |
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
| `email_deliverability` (US-915) | `SES_CONFIGURATION_SET`, `SES_MARKETING_FROM_EMAIL/NAME`, `SES_AWS_REGION/ACCESS_KEY_ID/SECRET_ACCESS_KEY`, `SES_DKIM_VERIFIED`, `SES_SPF_ALIGNED`, `SES_DMARC_POLICY`, `MARKETING_UNSUBSCRIBE_MAILTO` | boot log shows NO `[BOOT] deliverability:` warnings; a marketing send arrives from `news.gradethread.com` with a Gmail/Apple-Mail one-click unsubscribe. **Full runbook: [`vault/50-business/deliverability.md`](vault/50-business/deliverability.md).** | ☐ |
| `buyer_extension` (US-1754 / US-1883) | `EXTENSION_ALLOWED_ORIGINS` (comma-sep `chrome-extension://<id>` / `moz-extension://<id>`); **`CF_ORIGIN_SECRET` strongly recommended** | extension overlay grades a live listing (CORS OK); with `CF_ORIGIN_SECRET` set + the CF Transform Rule live, a direct-to-origin request that rotates `X-Forwarded-For` can no longer mint per-IP quota (US-1883 AC1). Empty origins ⇒ extension can't reach the public endpoints. | ☐ |
| `web_push` (US-1901) | **Generate the VAPID keypair** `npx web-push generate-vapid-keys`, then set `VAPID_PUBLIC_KEY` + `VAPID_PRIVATE_KEY` (+ optional `VAPID_SUBJECT`) on the edge AND the SAME public key as `VITE_VAPID_PUBLIC_KEY` on Pages. Verify: Settings → Notifications → "Enable push" subscribes without error and a test notification (offer/sale) shows an OS banner. Unset ⇒ push silently no-ops; email + in-app still deliver. | ☐ |

### 1c. Frontend (Cloudflare Pages → Settings → Environment variables → Production)

| Var | Where | Verify | By / Date |
|---|---|---|---|
| `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` | Pages | login works on the live site | ☐ |
| ~~`VITE_STRIPE_PUBLISHABLE_KEY`~~ | — | **NOT a prerequisite.** Nothing reads it, and there is no `@stripe/stripe-js` dependency; checkout is a server-minted Stripe Checkout URL. The "checkout button loads Stripe" check this row used to carry cannot pass or fail, because no browser code loads Stripe. See the warning in [[env-reference]]. | n/a |
| `VITE_EDGE_API_URL` | Pages (`https://functions.gradethread.com`) | dashboard data loads (not 404) | ☐ |
| `VITE_SENTRY_DSN` | Pages | a forced client error shows in Sentry | ☐ |
| `VITE_POSTHOG_KEY` / `VITE_POSTHOG_HOST` | Pages | events appear in PostHog | ☐ |
| `VITE_GOOGLE_SITE_VERIFICATION` / `VITE_BING_SITE_VERIFICATION` | Pages (GSC / Bing) | view-source shows the verification `<meta>` | ☐ |
| `VITE_RELEASE_SHA=$CF_PAGES_COMMIT_SHA` | Pages build command | footer build tag shows the SHA | ☐ |
| `VITE_CF_IMAGE_RESIZING` | Pages — `true` ONLY after enabling zone Transformations | images load (no broken srcset) | ☐ |
| `VITE_SAMPLE_CERTIFICATE_ID` (US-1945 AC4) | ✅ Now committed in `.env.production` (`cce9b573-6b29-45e3-ba45-7c0fe1578418`, renders Certificate No. GT-7Y3BCAF) so it's baked in on every Pages build — no dashboard entry needed. To point at a different cert, override in Pages env or edit `.env.production`; any id from `https://gradethread.com/sitemap-certs.xml` is safe (only published, indexable certs). | homepage sample-certificate card links to `/cert/<id>` (returns 200). | ☑ (in code) |

### 1d. Ads Command Center — "Ads apply enabled" gate (US-1709)

The read/analysis side (sync, dashboard, recommendations) is safe as soon as the
`GOOGLE_ADS_*` / `APPLE_SEARCH_ADS_*` secrets are set. **Do NOT let recommendations
be APPLIED to a live account until BOTH:**

| Gate | Check | ☐ |
|---|---|---|
| Google Ads developer token has **Basic Access** (not Test) | applying with a Test token can only touch test accounts | ☐ |
| **Guardrails configured** in `system_settings` (`ads_guardrails`) | `maxBudgetChangePct` / `dailySpendCeiling` / `maxAppliesPerRun` set to sane values | ☐ |
| A **dry-run apply** succeeded on a real recommendation | dry-run returns a valid before/after with no error | ☐ |
| Apple Search Ads mutate **smoke-tested** (if using ASA) | v5 mutate shapes verified against the live account | ☐ |

---

## 2. Third-party dashboards

| Item | Where | Verify | By / Date |
|---|---|---|---|
| Stripe products + prices created (subs, per-grade, credit packs) | Stripe Dashboard | `STRIPE_PRICE_*` ids match live prices | ☐ |
| Stripe webhook endpoint → `https://functions.gradethread.com/api/webhooks/stripe` | Stripe → Webhooks | `stripe trigger` delivers 200 | ☐ |
| Stripe **live mode** keys in use (not test) | Stripe | keys start `sk_live`/`pk_live` | ☐ |
| Supabase Auth: `GOTRUE_SITE_URL=https://gradethread.com` (NOT api.*) + `GOTRUE_URI_ALLOW_LIST` with all 5 callbacks (web ×3, iOS Universal Link, iOS custom scheme — see `vault/10-ops/env-reference.md`) | self-hosted auth container env | web Google lands on /auth/callback; `state` JWT `site_url` = gradethread.com | ☐ |
| Supabase Auth: Google OAuth creds (`GOTRUE_EXTERNAL_GOOGLE_*`) | self-hosted auth container env | "Continue with Google" works on web + iOS | ☐ |
| Supabase Auth: Apple provider (`GOTRUE_EXTERNAL_APPLE_ENABLED=true`, `CLIENT_ID=com.gradethread.app`) | self-hosted auth container env | `/auth/v1/settings` shows `"apple": true`; iOS Apple sign-in completes | ☐ |
| eBay app keys promoted to production + Marketplace Account Deletion endpoint registered | eBay Developer | OAuth connect + a test notification verify | ☐ |
| DNS: `functions.gradethread.com` → Coolify; `api.gradethread.com` → Supabase Kong; apex → Pages | Cloudflare DNS | `/health` on functions.*, REST on api.* | ☐ |
| IndexNow key file hosted at `/<INDEXNOW_KEY>.txt` | `public/` + Pages | the file resolves 200 | ☐ |
| **Email deliverability (US-915)** — SES domain identity verified; DKIM CNAMEs, SPF/MAIL FROM, and a DMARC `p=` record published for the **dedicated marketing subdomain** (`news.gradethread.com`), separate from transactional; SES Configuration Set with an SNS event destination (bounce/complaint → `/api/webhooks/ses`) | Amazon SES + Cloudflare DNS | follow **[`vault/50-business/deliverability.md`](vault/50-business/deliverability.md)**; SES "Verified identities" all green; `dig TXT _dmarc.news.gradethread.com` resolves | ☐ |

---

## 3. Coolify scheduled tasks

Add **each** task (Coolify → service → Scheduled Tasks), then click **Run Now**
and confirm the expected output. All hit `http://localhost:8787` (in-container,
skips Traefik/WAF) with header `X-Internal-Job-Secret: $FLIPDESK_INTERNAL_JOB_SECRET`.
A healthy run returns `{"ok":true,...}`. Reference: `services/edge-functions/COOLIFY.md`.

> Secrets vary per task — the **Secret env** column below is authoritative
> (drip/content/newsletter ticks use their own env vars). Content-tick idle
> runs return `{"skipped":true}`; see `vault/40-growth/content-scheduler.md` for the
> safe low-cadence rollout.

> **`curl` must be in the edge image.** Every task below is a `curl` POST, and the
> `denoland/deno:debian` base ships without curl — the Dockerfile installs it on
> purpose. If it's missing, EVERY task silently no-ops (`curl: not found` before
> the request, so the app logs show nothing and `cron_runs` stays empty for every
> job). Confirm once per deploy: `which curl` in the edge container terminal.

<!-- cron-registry:start (generated - see src/lib/cron-runs.ts + scripts/render-cron-docs.ts; drift-guarded by cron-registry-drift_test.ts) -->
| Task | Schedule (UTC) | Endpoint (POST) | Secret env | Notes |
|---|---|---|---|---|
| abuse-scan | `0 */6 * * *` | `/api/jobs/abuse-scan` | `$FLIPDESK_INTERNAL_JOB_SECRET` |  |
| ads-conversions-upload | `30 8 * * *` | `/api/jobs/ads-conversions-upload` | `$FLIPDESK_INTERNAL_JOB_SECRET` |  |
| ads-sync | `0 8 * * *` | `/api/jobs/ads-sync` | `$FLIPDESK_INTERNAL_JOB_SECRET` |  |
| affiliate-payouts | `15 */6 * * *` | `/api/jobs/affiliate-payouts` | `$FLIPDESK_INTERNAL_JOB_SECRET` |  |
| agent-eval | `0 15 * * 0` | `/api/jobs/agent-eval` | `$FLIPDESK_INTERNAL_JOB_SECRET` |  |
| agent-tick | `*/10 * * * *` | `/api/jobs/agent-tick` | `$FLIPDESK_INTERNAL_JOB_SECRET` |  |
| ai-budget-guardrails | `*/15 * * * *` | `/api/jobs/ai-budget-guardrails` | `$FLIPDESK_INTERNAL_JOB_SECRET` |  |
| appstore-expiry-sweep | `45 1 * * *` | `/api/jobs/appstore-expiry-sweep` | `$FLIPDESK_INTERNAL_JOB_SECRET` |  |
| audit-anomaly-scan | `5 * * * *` | `/api/jobs/audit-anomaly-scan` | `$FLIPDESK_INTERNAL_JOB_SECRET` |  |
| autolister-reclaim | `*/5 * * * *` | `/api/jobs/autolister-reclaim` | `$FLIPDESK_INTERNAL_JOB_SECRET` |  |
| automation-rules | `0 * * * *` | `/api/jobs/automation-rules` | `$FLIPDESK_INTERNAL_JOB_SECRET` |  |
| billing-reconciliation | `0 5 * * *` | `/api/jobs/billing-reconciliation` | `$FLIPDESK_INTERNAL_JOB_SECRET` |  |
| buyer-digest | `0 13 * * *` | `/api/jobs/buyer-digest` | `$FLIPDESK_INTERNAL_JOB_SECRET` |  |
| cert-integrity-backfill | `0 6 * * *` | `/api/jobs/cert-integrity-backfill` | `$FLIPDESK_INTERNAL_JOB_SECRET` | ONE-OFF at launch (idempotent; disable once drained) |
| comp-read | `25 * * * *` | `/api/jobs/comp-read` | `$FLIPDESK_INTERNAL_JOB_SECRET` | 200 with {ok:true, skipped:true, reason:"comp_read feature flag is off"} until the flag is enabled — it ships OFF pending the US-2842 spike. Also skips on a breached comp_read budget. |
| comp-read-reclaim | `*/10 * * * *` | `/api/jobs/comp-read-reclaim` | `$FLIPDESK_INTERNAL_JOB_SECRET` | 200 with {ok:true, requeued:0, failed:0} on a healthy queue. Runs whether or not the flag is on: a queue left by a disabled worker still needs draining. |
| condition-alerts | `*/15 * * * *` | `/api/jobs/condition-alerts` | `$FLIPDESK_INTERNAL_JOB_SECRET` |  |
| condition-index-refresh | `0 8 * * *` | `/api/jobs/condition-index-refresh` | `$FLIPDESK_INTERNAL_JOB_SECRET` |  |
| condition-index-seedgen | `0 9 * * 1` | `/api/jobs/condition-index-seedgen` | `$FLIPDESK_INTERNAL_JOB_SECRET` |  |
| confidence-calibration | `0 13 * * 0` | `/api/jobs/confidence-calibration` | `$FLIPDESK_INTERNAL_JOB_SECRET` |  |
| consignor-payouts | `*/30 * * * *` | `/api/jobs/consignor-payouts` | `$FLIPDESK_INTERNAL_JOB_SECRET` |  |
| content-digest | `0 14 * * 1` | `/api/content/scheduler/digest` | `$CONTENT_INTERNAL_JOB_SECRET` |  |
| content-refresh | `30 4 * * *` | `/api/jobs/content-refresh` | `$FLIPDESK_INTERNAL_JOB_SECRET` |  |
| content-tick | `0 * * * *` | `/api/content/scheduler/tick` | `$CONTENT_INTERNAL_JOB_SECRET` | 200 with skipped:true when idle (cadence gate) — NOT ok:true |
| content-watchdog | `0 */3 * * *` | `/api/jobs/content-watchdog` | `$FLIPDESK_INTERNAL_JOB_SECRET` |  |
| credentials-refresh | `40 5 * * *` | `/api/jobs/credentials-refresh` | `$FLIPDESK_INTERNAL_JOB_SECRET` | 200 with {ok:true, revised, up_to_date, capped:false}; revised is 0 on a steady-state run, and unparseable + blocks_disagree must be 0 (US-3028: above zero means live stale badges this job cannot reach) |
| cron-fleet-health | `17 * * * *` | `/api/jobs/cron-fleet-health` | `$FLIPDESK_INTERNAL_JOB_SECRET` |  |
| data-retention | `0 4 * * *` | `/api/jobs/data-retention` | `$FLIPDESK_INTERNAL_JOB_SECRET` |  |
| demand-matches | `30 */6 * * *` | `/api/jobs/demand-matches` | `$FLIPDESK_INTERNAL_JOB_SECRET` |  |
| drip-tick | `0 * * * *` | `/api/drip/tick` | `$DRIP_INTERNAL_JOB_SECRET` |  |
| durability-aggregate | `0 2 * * *` | `/api/jobs/durability-aggregate` | `$FLIPDESK_INTERNAL_JOB_SECRET` |  |
| ebay-leave-feedback | `0 10 * * *` | `/api/flipdesk/ebay/jobs/leave-feedback` | `$FLIPDESK_INTERNAL_JOB_SECRET` | 200; no-op unless system setting feedback.auto_leave=true |
| ebay-notification-reconcile | `17 */6 * * *` | `/api/jobs/ebay-notification-reconcile` | `$FLIPDESK_INTERNAL_JOB_SECRET` | 200 with {ok:true, healthy:true, missingBuckets:[]}; created/enabled empty on a steady-state run |
| ebay-order-backstop | `*/30 * * * *` | `/api/jobs/ebay-order-backstop` | `$FLIPDESK_INTERNAL_JOB_SECRET` | 200 with {ok:true, candidates, started, alreadyRunning, ...}; started/candidates can be 0 when every connection synced recently |
| ebay-pending-webhooks | `*/15 * * * *` | `/api/jobs/ebay-pending-webhooks` | `$FLIPDESK_INTERNAL_JOB_SECRET` |  |
| ebay-performance-sync | `0 */6 * * *` | `/api/flipdesk/ebay/sync/performance` | `$FLIPDESK_INTERNAL_JOB_SECRET` |  |
| ebay-promoted-sync | `0 */6 * * *` | `/api/flipdesk/ebay/jobs/promoted-sync` | `$FLIPDESK_INTERNAL_JOB_SECRET` |  |
| ebay-publish-due | `*/5 * * * *` | `/api/flipdesk/ebay/jobs/publish-due` | `$FLIPDESK_INTERNAL_JOB_SECRET` |  |
| ebay-search-terms | `25 6 * * *` | `/api/jobs/ebay-search-terms` | `$FLIPDESK_INTERNAL_JOB_SECRET` | 200 with {ok:true, owners, stored, no_campaign, ...}; owners is 0 on an account with no Priority campaigns |
| ebay-token-refresh | `0 * * * *` | `/api/flipdesk/ebay/oauth/refresh` | `$FLIPDESK_INTERNAL_JOB_SECRET` |  |
| email-retry | `*/5 * * * *` | `/api/jobs/email-retry` | `$FLIPDESK_INTERNAL_JOB_SECRET` |  |
| equity-snapshot | `15 5 * * *` | `/api/jobs/equity-snapshot` | `$FLIPDESK_INTERNAL_JOB_SECRET` |  |
| exemplar-assembly | `0 12 * * 0` | `/api/jobs/exemplar-assembly` | `$FLIPDESK_INTERNAL_JOB_SECRET` |  |
| expense-recurrence | `20 5 * * *` | `/api/jobs/expense-recurrence` | `$FLIPDESK_INTERNAL_JOB_SECRET` |  |
| flipdesk-import-reclaim | `*/5 * * * *` | `/api/jobs/flipdesk-import-reclaim` | `$FLIPDESK_INTERNAL_JOB_SECRET` |  |
| google-sheet-sync | `*/5 * * * *` | `/api/flipdesk/google/sync/push` | `$FLIPDESK_INTERNAL_JOB_SECRET` |  |
| googleplay-expiry-sweep | `50 1 * * *` | `/api/jobs/googleplay-expiry-sweep` | `$FLIPDESK_INTERNAL_JOB_SECRET` |  |
| grading-batch-reclaim | `*/5 * * * *` | `/api/jobs/grading-batch-reclaim` | `$FLIPDESK_INTERNAL_JOB_SECRET` |  |
| grading-monitor | `0 */12 * * *` | `/api/jobs/grading-monitor` | `$FLIPDESK_INTERNAL_JOB_SECRET` |  |
| grading-self-consistency | `20 4 * * 1` | `/api/jobs/grading-self-consistency` | `$FLIPDESK_INTERNAL_JOB_SECRET` |  |
| growth-dispatch | `*/15 * * * *` | `/api/jobs/growth-dispatch` | `$FLIPDESK_INTERNAL_JOB_SECRET` |  |
| gsc-sync | `30 6 * * *` | `/api/jobs/gsc-sync` | `$FLIPDESK_INTERNAL_JOB_SECRET` |  |
| guarantee-pool | `0 4 * * *` | `/api/jobs/guarantee-pool` | `$FLIPDESK_INTERNAL_JOB_SECRET` |  |
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
| photo-archive | `0 4 * * *` | `/api/jobs/photo-archive` | `$FLIPDESK_INTERNAL_JOB_SECRET` | 200 {owners,eligible_owners,archived,freed_bytes,...}; skipped:true with reason r2_not_configured is healthy, and archived 0 is normal once the backlog drains |
| portfolio-alerts | `0 7 * * *` | `/api/jobs/portfolio-alerts` | `$FLIPDESK_INTERNAL_JOB_SECRET` |  |
| publish-batch-reclaim | `*/5 * * * *` | `/api/jobs/publish-batch-reclaim` | `$FLIPDESK_INTERNAL_JOB_SECRET` |  |
| push-token-prune | `0 3 * * *` | `/api/jobs/push-token-prune` | `$FLIPDESK_INTERNAL_JOB_SECRET` |  |
| qbo-token-refresh | `0 * * * *` | `/api/flipdesk/qbo/oauth/refresh` | `$FLIPDESK_INTERNAL_JOB_SECRET` |  |
| radar-aggregate | `20 * * * *` | `/api/jobs/radar-aggregate` | `$FLIPDESK_INTERNAL_JOB_SECRET` | 200 with {ok:true, events, venues, aggregates, suppressed, removed, kFloor, pruned}; suppressed > 0 is NORMAL and means the k-anonymity floor withheld those venues |
| reconciliation-sweep | `0 5 * * *` | `/api/jobs/reconciliation-sweep` | `$FLIPDESK_INTERNAL_JOB_SECRET` | 200 {owners,eligible_owners,auto_matched,ambiguous,...}; ambiguous is not an error — those rows are queued for the seller on purpose |
| reprice-rules | `0 */6 * * *` | `/api/jobs/reprice-rules` | `$FLIPDESK_INTERNAL_JOB_SECRET` |  |
| reprice-scan | `0 */6 * * *` | `/api/jobs/reprice-scan` | `$FLIPDESK_INTERNAL_JOB_SECRET` |  |
| reward-nudges | `0 15 * * *` | `/api/jobs/reward-nudges` | `$FLIPDESK_INTERNAL_JOB_SECRET` | 200 with {ok:true, evaluated, sent, holdout, skipped, scanned, converted}; sent can be 0 — most evaluated users are frequency-capped or have no true candidate |
| rewards-sweep | `30 6 * * *` | `/api/jobs/rewards-sweep` | `$FLIPDESK_INTERNAL_JOB_SECRET` | 200 with {ok:true, queued, swept, marksGranted, xpAdded, leveledUp, failed}; marksGranted settles near 0 once the backfill has drained |
| stuck-submissions | `*/10 * * * *` | `/api/jobs/stuck-submissions` | `$FLIPDESK_INTERNAL_JOB_SECRET` |  |
| style-code-discovery | `10 3 * * *` | `/api/jobs/style-code-discovery` | `$FLIPDESK_INTERNAL_JOB_SECRET` | 200 with {ok:true, considered, crawled, deferred, scanned, inspected, declared, codes, newCodes, names}; newCodes falls toward 0 as a brand's pages are exhausted, and deferred is non-zero whenever more brands are eligible than the budget covers |
| style-code-sweep | `35 * * * *` | `/api/jobs/style-code-sweep` | `$FLIPDESK_INTERNAL_JOB_SECRET` | 200 with {ok:true, considered, swept, deferred, learned, noHits}; swept is 0 once every known code is confirmed or cooling off |
| sync-reaper | `*/15 * * * *` | `/api/jobs/sync-reaper` | `$FLIPDESK_INTERNAL_JOB_SECRET` |  |
| thumbnail-backfill | `*/5 * * * *` | `/api/jobs/thumbnail-backfill` | `$FLIPDESK_INTERNAL_JOB_SECRET` |  |
| trial-expiry | `15 0 * * *` | `/api/jobs/trial-expiry` | `$FLIPDESK_INTERNAL_JOB_SECRET` |  |

_84 scheduled jobs. Default healthy response: 200 `{"ok":true,...}` (idle runs report skipped/zero counts). Generated from `src/lib/cron-runs.ts` CRON_REGISTRY — do not hand-edit._
<!-- cron-registry:end -->

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
| All migrations applied | `curl -fsS https://functions.gradethread.com/health/ready \| jq .schema` → `status:"match"` **and no `missing` key** (US-1566 reports `expected` vs `applied` from the DB itself; US-2603 adds `missing`). **Do not hardcode a version here** — this row previously read `latest = 00132` while prod was at 00476, so an operator verifying against it would have CONFIRMED a catastrophically stale DB. Ask the system, don't assert. **This row used to say `status:"match"` and then caveat in prose that `applied` is the recorded MAX** — which is not where anyone looks mid-incident, and on 2026-08-15 prod really did report `applied:"00606", status:"match", missing:["00594"]`. A hole under the maximum now reports `status:"incomplete"` (US-2620), so the field this row sends you to can no longer say the schema is fine while naming a migration missing from it. | ☐ |
| Edge boots clean against prod schema (US-778) | edge logs show `[schema-version] OK` (not `STALE`) | ☐ |
| RLS enabled on every multi-tenant table | spot-check `select relrowsecurity from pg_class where relname='submissions';` → t | ☐ |

---

## 5. Backup + restore drill

Do a REAL restore drill before launch (not just "backups are configured"). Full
procedure: **`vault/10-ops/backups.md`**; mechanism: `scripts/ops/backup-postgres.sh`,
`backup-storage.sh`, `restore-postgres.sh`. The procedure itself is verified —
`scripts/ops/restore-drill.sh` ran PASS on 2026-06-12 against the local stack
(BACKUPS.md drill log). This section is the **prod** drill: restore a real
offsite dump on a scratch host. Record the result here so the drill has a home.

| Drill date | Backup restored (timestamp) | Restore target | Result (ok/fail) | By |
|---|---|---|---|---|
|  |  |  |  |  |
|  |  |  |  |  |

> [!danger] The FIRST box is not one of five — it is the one the others assume
> Until the cron is installed and a dump has landed offsite, the RPO stated in
> [[backups]] does not hold, and the real exposure is **total loss** rather than
> the documented 24 hours. Every other box on this list, and the drill table
> above, describes a mechanism that is verified to WORK; none of them establishes
> that anything RUNS it. Tick that box first, and treat the rest as unstarted
> until it is (US-2002).

- ☐ Backup cron installed on the DB host (`vault/10-ops/backups.md` §Schedule) and the first
  nightly dump confirmed in the offsite bucket (with `.sha256` sidecar)
- ☐ R2 lifecycle rules created (30d on `pg/` and `storage-deleted/`)
- ☐ A prod offsite dump restored to a scratch Supabase Postgres via
  `restore-postgres.sh` and sanity-queried (row counts plausible)
- ☐ Restore runtime recorded above (informs RTO; targets in `vault/10-ops/backups.md`)
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
  `vault/10-ops/incident-response.md` (see `vault/10-ops/uptime-monitoring.md`). Drill date: ______
- ☐ Incident runbook reachable by on-call (`vault/10-ops/incident-response.md`)
- ☐ Private on-call contact sheet (phone numbers for the escalation ladder)
  exists outside the repo and every responder knows where it is
  (`vault/10-ops/incident-response.md` → "On-call & escalation")
- ☐ Pre-launch banner / `VITE_LAUNCH_DATE` set to self-expire (US-785)
- ☐ Reseller feature scope confirmed — Best Offer responses and returns/
  cancellations are **out of scope** for launch (handled in eBay Seller Hub);
  see `vault/30-platform/flipdesk-reseller-gaps.md` (US-469)
- ☑ **Platform scope: web and iOS. Android is NOT a launch gate** (owner,
  2026-08-15, US-2015 AC4). It keeps building — its verify lane runs locally and
  in CI and passes — but it gets no store listing in this cycle, and **no open
  Android story blocks launch**. Read them as post-launch work.

  Worth stating because the backlog reads the other way: the audit that filed
  US-2015 described Android as a skeleton with one edge endpoint, and that was
  true when written and is not now. It calls 39, and grading, inventory,
  marketplaces, money and billing all hold real code, with widgets, push and a
  Spanish catalogue. Anyone triaging "what is left before launch" will find a
  large Android surface that looks unfinished; it is unfinished, and it is
  deliberately not on this list.

  **Update 2026-08-21: the Play listing now exists in the repo, and the
  launch-gate decision above still stands.** The store copy, the Console form
  answers, the product catalogue and the release mechanics are written up in
  `android/PLAY_STORE_SUBMISSION.md`, and preparing them turned up one hard
  policy blocker that was fixed rather than deferred (no in-app account
  deletion, US-2776). Read that file as work done ahead of a post-launch
  submission, not as a row that has to be ticked before web and iOS go live.
- ☐ All blockers in `prd.json` (US-772…US-785) marked `passes:true`

**Launch approved by:** ________________  **Date:** ____________

## Related

- [[deploy]] — the order this gate assumes
- [[backups]] — the restore drill this requires
- [[uptime-monitoring]] — the checks that must be live at launch
- [[moc-ops]]
