# Staging / Preview Environments (US-520)

Changes must be validated in a pre-prod environment so migrations, webhooks, and
auth aren't first exercised in production.

## Staging environment

A staging stack mirrors prod with **test-mode** external services:

| Component | Staging |
|---|---|
| Supabase | A separate self-hosted (or hosted) Supabase project — never prod's DB |
| Edge | A second Coolify resource (`functions-staging.gradethread.com`) from the same image, `EDGE_ENV=staging` |
| Stripe | **Test mode** keys (`sk_test_…`, test webhook secret) |
| eBay | Sandbox (`EBAY_ENV=sandbox`) |
| Anthropic | Same provider, separate key + low budget cap |
| Frontend | Cloudflare Pages preview / a `staging.gradethread.com` project |

Staging uses its own `FLIPDESK_INTERNAL_JOB_SECRET`, its own SMTP (or a catch-all
mailbox), and its own bucket — no shared state with prod.

## PR preview deploys

- **Frontend:** Cloudflare Pages already builds a preview deployment per PR
  (unique URL). Use it to review UI changes before merge.
- **Edge:** Coolify doesn't auto-build per-PR. Either (a) deploy the PR branch to
  the staging edge resource manually, or (b) accept the gap and rely on the edge
  unit/integration suite + a post-merge staging smoke test.

> **MANUAL / FOLLOW-UP:** stand up the staging Supabase + edge resources and
> record their URLs + env here. Until then, the documented gap is: edge changes
> are validated by CI (lint/type/test/coverage + frozen lockfile + Trivy) and a
> manual staging deploy before promotion.

## Promotion flow (target)

1. PR → CI green (frontend + edge gates) + Pages preview review.
2. Merge to a `staging` branch (or deploy the branch) → staging stack.
3. Run E2E/smoke against staging (signup, grade, checkout entry, cert view).
4. Apply migrations to staging (`MIGRATIONS.md`), verify.
5. Promote to `main` → prod deploy; re-run the smoke test against prod.

(During the pre-production sprint the team works directly on `main`; restore the
branch-and-promote flow before launch — see the CLAUDE.md workflow override.)
