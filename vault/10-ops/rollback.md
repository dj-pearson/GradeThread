---
title: Production rollback
type: runbook
status: current
source_of_truth: vault
code_refs: []
reviewed: 2026-07-19
tags: [ops, deploy, rollback]
summary: Undo a bad release on each surface, and what cannot be rolled back.
---
# Production Rollback (US-513)

Both surfaces deploy automatically on push to `main`, so a bad merge reaches prod
quickly. This is how to revert each, fast.

## Frontend — Cloudflare Pages

Pages keeps every prior deployment.

1. Cloudflare dashboard → Pages → the GradeThread project → **Deployments**.
2. Find the last-known-good deployment → **⋯ → Rollback to this deployment**
   (or **Retry deployment** on that commit).
3. Verify: load the site, check `/` renders and a known certificate loads.

CLI alternative: re-run the build on the prior commit, or `wrangler pages
deployment` tooling. Pages rollbacks are near-instant (no rebuild).

## Edge service — Coolify

The edge image is tagged with the commit SHA (`Dockerfile` `ARG GIT_SHA` →
`org.opencontainers.image.revision` + `RELEASE_SHA`), so the running version is
visible at `GET /health` (`release` field) and a specific prior build can be
redeployed deterministically.

1. Coolify → edge-functions resource → **Deployments** history.
2. Redeploy the last-known-good commit (Coolify rebuilds that ref) — or, if
   image retention is enabled, redeploy the prior tagged image directly.
3. Verify: `curl https://functions.gradethread.com/health` shows the expected
   `release` SHA and `errorTracking: "enabled"`; `/health/ready` returns 200.

> **MANUAL:** in Coolify, set the build arg `GIT_SHA=$SOURCE_COMMIT` (Coolify
> exposes the commit as an env/arg) so each image is stamped, and enable image
> retention (keep ≥ 5 prior tags) so a prior image can be redeployed without a
> rebuild.

## Database

Schema is forward-only. To revert a bad migration, ship a compensating migration
(`vault/10-ops/migrations-process.md`). For data corruption, restore from backup (`vault/10-ops/backups.md`) —
prefer PITR to a timestamp just before the bad change.

## Decision guide

| Symptom | Action |
|---|---|
| Bad UI / SPA bug | Pages rollback (instant) |
| Edge 500s after deploy | Coolify redeploy prior commit; check `/health` release |
| Bad migration / data issue | Compensating migration or PITR restore |
| External dependency outage | Flip the relevant kill-switch (US-507) — no deploy needed |

## Validation

> **MANUAL / LAUNCH-BLOCKER:** validate the edge rollback once in staging
> (deploy A, deploy B, roll back to A, confirm `/health` shows A's SHA).

## Related

- [[deploy]] — the forward path; rollback undoes it surface by surface
- [[backups]] — migrations are forward-only, so DB rollback means restore
- [[incident-response]] — "bad deploy" is scenario 7 there
- [[moc-ops]]
