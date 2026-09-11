---
title: Production rollback
aliases: [ROLLBACK]
type: runbook
status: current
source_of_truth: vault
code_refs: []
reviewed: 2026-09-11
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
> **The release stamp works today, and where it comes from is not established.**
> Measured 2026-09-11: `/health` answers a real 40-char SHA that is the tip of
> `origin/main`, and the same image reports the `EXPECTED_SCHEMA_VERSION` that
> commit sets, so the two agree. It reported `"unknown"` as recently as
> 2026-08-22.
>
> ⚠️ **Do not credit a compose file for it.** `docker-compose.coolify.yml`
> declares `build.args.GIT_SHA: ${SOURCE_COMMIT:-dev}` and Coolify does not read
> that file (US-2665, [[edge-container-settings]]). The two live candidates are
> the Dockerfile's own `ARG SOURCE_COMMIT` chain and a hand-set `COMMIT_SHA`
> variable in the Coolify UI — and if it is the hand-set one, it has to be
> updated on every deploy or the next rollback identifies the wrong build.
> `/health/ready` reports `features.release` as degraded whenever the release is
> a placeholder, so a miss is visible without anyone remembering to check.

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
- [[edge-container-settings]] — why the release stamp is not the compose file’s doing
- [[backups]] — migrations are forward-only, so DB rollback means restore
- [[incident-response]] — "bad deploy" is scenario 7 there
- [[moc-ops]]
