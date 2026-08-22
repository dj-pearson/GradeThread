---
title: Staging environment
type: runbook
status: current
source_of_truth: vault
code_refs: []
reviewed: 2026-07-19
tags: [ops, staging]
summary: What staging is, what it is not, and how to smoke it.
---
# Staging / Preview Environments (US-520)

Changes must be validated in a pre-prod environment so migrations, webhooks,
and auth aren't first exercised in production. This doc covers the staging
stack, PR preview deploys, and the smoke gate that runs before promotion.
Deploy order/rollback live in `vault/10-ops/deploy.md`; env specifics in `vault/10-ops/env-reference.md`.

## The staging stack

A staging stack mirrors prod with **test-mode** external services and shares
**no state** with prod — no DB, no buckets, no live keys, no reused secrets.

| Component | Production | Staging |
|---|---|---|
| Supabase | `api.gradethread.com` (self-hosted) | `api-staging.gradethread.com` — a separate self-hosted (or hosted) instance |
| Edge | `functions.gradethread.com`, `EDGE_ENV=production` | `functions-staging.gradethread.com`, `EDGE_ENV=staging` |
| Stripe | Live mode | **Test mode** (`sk_test_…`, test webhook secret, test prices) |
| eBay | Production keyset | Sandbox (`EBAY_ENV=sandbox`) |
| Apple IAP | `APPSTORE_ENVIRONMENT=Production` | `Sandbox` |
| Anthropic | Prod key | Separate key with a low budget cap |
| Frontend | Cloudflare Pages production (`gradethread.com`) | `staging.gradethread.com` (branch deploy) + per-PR previews |

What `EDGE_ENV=staging` changes in the edge service (vs `production`):
boot env-validation is **warn-only** (missing feature groups surface on
`/health/ready` instead of crashing), security debug flags are honored,
`/health/_throw` is available, the CORS allow-list additionally accepts
`https://staging.gradethread.com` and `https://*.gradethread.pages.dev`
(main.ts `isAllowedOrigin` — these are **never** trusted in production), and
`GET /health` reports `env:"staging"` so the smoke test can prove it isn't
accidentally pointed at prod.

## Standing it up (one-time, manual)

1. **Supabase:** provision a second self-hosted Supabase (own Postgres, own
   JWT secret, own service-role key) at `api-staging.gradethread.com`. Apply
   all of `supabase/migrations/` (see `vault/10-ops/migrations-process.md`). Create the
   `submission-images` (private) and `item-photos` (public) buckets.
2. **Edge:** in Coolify, New Resource → Docker Compose → this repo +
   `services/edge-functions/docker-compose.staging.yml`, tracking the
   `staging` branch. Env vars: start from
   `services/edge-functions/.env.staging.example` (it lists every value that
   must differ from prod) and `.env.example` for the rest. DNS:
   `functions-staging.gradethread.com` → the Coolify host.
3. **Stripe:** in TEST mode, run `node scripts/setup-stripe-pricing.mjs` to
   create test products/prices; register the webhook endpoint
   `https://functions-staging.gradethread.com/api/webhooks/stripe` and put its
   `whsec_…` in the staging env.
4. **Frontend:** in the Cloudflare Pages project, add `staging` as a branch
   with the custom domain `staging.gradethread.com`. Set **Preview**-scope
   env vars (`VITE_SUPABASE_URL`/`VITE_SUPABASE_ANON_KEY` → staging Supabase)
   so previews and the staging branch build against staging services, not prod.
   This list used to include `VITE_STRIPE_PUBLISHABLE_KEY` → `pk_test_…`;
   nothing reads it, so setting it staged nothing. See [[env-reference]].
5. **CI:** set repo **Variables** (Settings → Secrets and variables → Actions
   → Variables): `STAGING_EDGE_URL`, `STAGING_WEB_URL`,
   `STAGING_SUPABASE_URL`. This activates `staging-smoke.yml`.

> **STATUS:** the repo side is fully wired (compose file, env template,
> staging-aware CORS/health, smoke script, CI workflow). The external
> resources (staging Supabase, Coolify resource, DNS, Stripe test webhook,
> Pages branch config, repo variables) still need to be provisioned by an
> operator following the steps above — until then `staging-smoke.yml` skips
> with a notice, and that is the documented gap: edge changes are validated
> by CI (lint/type/test/coverage + frozen lockfile + Trivy) only.

## PR preview deploys

- **Frontend: covered.** Cloudflare Pages builds a preview deployment per PR
  at `https://<hash>.<project>.pages.dev`. With Preview-scope env vars set
  (step 4), previews run against staging Supabase + Stripe test mode, and the
  staging edge accepts their origin (preview-origin CORS is off-production
  only).
- **Edge: documented gap.** Coolify doesn't build per-PR previews. Options:
  (a) point the staging edge resource at the PR branch and hit **Redeploy**
  (manual edge preview), or (b) rely on the edge CI gates + the staging smoke
  run after merging to `staging`. There is deliberately no auto-per-PR edge
  deploy — one shared staging edge keeps webhook registrations (Stripe/eBay)
  stable.

## Smoke + E2E against staging

`.github/workflows/staging-smoke.yml` runs on push to `staging`, on manual
dispatch, and nightly (drift check). It:

1. runs `npm run smoke:staging` (`scripts/smoke-staging.mjs`):
   - edge `/health` is ok **and reports `env:"staging"`** — a staging URL
     fronting a prod-configured container fails;
   - edge `/health/ready` is ready (staging DB reachable, critical env set);
     unconfigured feature groups print as warnings;
   - Supabase Auth health (`/auth/v1/health`) responds;
   - the staging frontend serves the app shell;
   - **separation guard:** none of the configured staging URLs is a
     production hostname.
2. runs the Playwright smoke + auth specs against the live staging frontend
   (`E2E_BASE_URL` — `playwright.config.ts` skips its local web server).

Run locally:

```bash
npm run smoke:staging -- --edge https://functions-staging.gradethread.com \
  --web https://staging.gradethread.com --supabase https://api-staging.gradethread.com
E2E_BASE_URL=https://staging.gradethread.com npx playwright test e2e/smoke.spec.ts
```

## Promotion flow

1. PR → CI green (frontend + edge gates) + Pages preview review.
2. Merge to `staging` → Pages builds `staging.gradethread.com`; Coolify
   redeploys the staging edge. Apply any new migrations to staging Supabase
   first (`vault/10-ops/migrations-process.md` — same order rule as prod: DB → edge → frontend).
3. `staging-smoke.yml` runs automatically; for money/grade-path changes also
   exercise a real Stripe test-mode checkout + an eBay sandbox publish.
4. Green → merge `staging` into `main` → prod deploy (`vault/10-ops/deploy.md`), then the
   prod post-deploy checks (`vault/10-ops/launch-checklist.md` §6).

(During the pre-production sprint the team works directly on `main`; restore
the branch-and-promote flow before launch — see the CLAUDE.md workflow
override. The smoke workflow's `workflow_dispatch` trigger works either way.)

## Related

- [[deploy]] — staging mirrors the prod deploy order
- [[launch-checklist]] — the gate staging exists to rehearse
- [[moc-ops]]
