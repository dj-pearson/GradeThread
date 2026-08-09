---
title: Production rollback
aliases: [ROLLBACK]
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

> [!warning] ⚠ In production this has not been true, and a rollback depends on it
> `GET /health` on `functions.gradethread.com` returned `release: "dev"` when
> last measured (2026-08-09), so **you cannot currently read the running commit
> off the health endpoint**, and step 3 below cannot confirm what it claims to.
> This is US-2001. Check it before you need it, not during an incident:
> `curl -s https://functions.gradethread.com/health | jq .release`.
>
> If it still says `dev`, the fastest fix is to set `SOURCE_COMMIT` as an
> ordinary Coolify environment variable — since the release-identity fix, a
> runtime value overrides the image's placeholder without a rebuild. See
> `services/edge-functions/COOLIFY.md`.
>
> Until then, identify the build from **Coolify's own deployment history**
> rather than from the service. The rollback procedure itself still works; it is
> the verification step that is blind.

1. Coolify → edge-functions resource → **Deployments** history.
2. Redeploy the last-known-good commit (Coolify rebuilds that ref) — or, if
   image retention is enabled, redeploy the prior tagged image directly.
3. Verify: `curl https://functions.gradethread.com/health` shows the expected
   `release` SHA and `errorTracking: "enabled"`; `/health/ready` returns 200.

> [!todo] **MANUAL:** in Coolify, enable image retention (keep ≥ 5 prior tags) so a
> prior image can be redeployed without a rebuild.
>
> The `GIT_SHA` build arg is **no longer a manual step** (US-2001):
> `services/edge-functions/docker-compose.coolify.yml` declares
> `build.args.GIT_SHA: ${SOURCE_COMMIT:-dev}`, so the platform stamps each image
> rather than an operator remembering to. That change exists precisely because
> the Dockerfile had carried a comment asking for it since it was written and
> prod still served `release:"dev"`.
>
> ⚠️ If you deploy from `docker-compose.yml` rather than the `.coolify.yml`
> variant, the arg is NOT declared there — set it in Coolify's Build Args field.
> `/health/ready` reports `features.observability` as degraded whenever the
> release is a placeholder, so a miss is visible without anyone remembering to
> check.

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

> [!todo] **MANUAL / LAUNCH-BLOCKER:** validate the edge rollback once in staging
> (deploy A, deploy B, roll back to A, confirm `/health` shows A's SHA).

## Related

- [[deploy]] — the forward path; rollback undoes it surface by surface
- [[backups]] — migrations are forward-only, so DB rollback means restore
- [[incident-response]] — "bad deploy" is scenario 7 there
- [[moc-ops]]
