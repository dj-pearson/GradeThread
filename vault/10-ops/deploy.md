---
title: Production deploy order
aliases: [DEPLOY, deploy order, release]
type: runbook
status: current
source_of_truth: vault
code_refs: []
reviewed: 2026-07-19
tags: [ops, deploy, release]
summary: "Ship to prod in the load-bearing order: migrations, then edge, then frontend."
---
# Deploy Runbook (US-780)

How a change reaches production, in what order, and how to roll back each layer.
For the *is-everything-configured* gate see **`vault/10-ops/launch-checklist.md`**; for
incidents see **`vault/10-ops/incident-response.md`**; for schema specifics see
**`vault/10-ops/migrations-process.md`**; for the staging stack + pre-promotion smoke gate see
**`vault/10-ops/staging.md`**.

GradeThread has three independently-deployed layers:

| Layer | Where | Trigger |
|---|---|---|
| Database | Self-hosted Supabase Postgres (`api.gradethread.com`) | Manual apply (CLI/psql) |
| Edge service | Deno/Hono on Coolify (`functions.gradethread.com`) | Git push → Coolify webhook |
| Frontend SPA | Cloudflare Pages (apex `gradethread.com`) | Git push → Pages auto-deploy |

---

## Canonical deploy order

**Always: 1) migrations → 2) edge → 3) frontend.** The order is load-bearing,
not stylistic:

1. **Apply DB migrations first.** The edge service asserts the schema version at
   boot (US-778) and **refuses to start in production against a DB behind its
   `EXPECTED_SCHEMA_VERSION`.** If you deploy the edge before its migrations, the
   new container crash-loops (by design) — so migrate first. Migrations are also
   forward-only and written to be backward-compatible with the *currently
   running* edge build, so applying them early never breaks the old code.
   **Automate this gate** so it's not a manual step you can forget: wire
   `apply-prod-migrations.sh` (`npm run migrate:prod`) as the edge resource's
   **Coolify Pre-deployment Command** — a failed migration then aborts the
   rollout and the old container keeps serving (see
   `services/edge-functions/COOLIFY.md` → "Apply migrations BEFORE the edge
   rolls"). A boot-time **grace window** (≈40 s, `SCHEMA_GUARD_GRACE_ATTEMPTS`/
   `_DELAY_MS`) absorbs the residual deploy/migrate race so a near-simultaneous
   apply is a brief delayed start, not a 503 crash-loop.
2. **Deploy the edge service second.** New API endpoints/fields must exist
   server-side before the frontend calls them. The edge is the contract.
3. **Deploy the frontend last.** The SPA may rely on new edge endpoints; shipping
   it before the edge would 404 those calls for live users.

> Rolling forward this way means every intermediate state is serviceable: old
> frontend + new edge + new schema all interoperate. Rolling **back** runs the
> reverse where possible (frontend → edge); schema is forward-only (compensate
> with a new migration, never drop).

---

## 1. Database migrations

```bash
# 0. Back up prod FIRST (BACKUPS.md).
# 1. See what's applied vs. repo:
psql "$SUPABASE_DB_URL" -c \
  "select version from supabase_migrations.schema_migrations order by version desc limit 5;"
# 2. Apply pending files IN ORDER (each is idempotent):
for f in $(ls supabase/migrations/*.sql | sort); do
  echo "applying $f"; psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -f "$f";
done
```

- The CI `db-migrations` lane (and local `npm run verify:db`) proves migrations
  apply cleanly on a fresh schema before they reach prod.
- **Record applied versions** into `supabase_migrations.schema_migrations` (the
  Supabase CLI does this; a raw `psql -f` loop does NOT — add the rows or use the
  CLI) so the edge boot assertion (US-778) is *active*, not fail-open.
- **Rollback:** forward-only. Restore from backup for a catastrophic migration
  (`vault/10-ops/backups.md` + `vault/10-ops/rollback.md`); otherwise write a compensating migration.

## 2. Edge service (Coolify)

- **Trigger:** Coolify is wired to the GitHub repo and **auto-deploys on push to
  `main`** via its deploy webhook. (Confirm under Coolify → service → Source.) A
  manual **Redeploy** in the Coolify UI does the same build from the latest commit.
- **Build:** Docker image from `services/edge-functions/Dockerfile`; compose is
  `docker-compose.coolify.yml` (Traefik labels, healthcheck `/health`, restart
  policy). Coolify injects the service Environment Variables at run.
- **Scheduled tasks survive a redeploy:** Coolify Scheduled Tasks are configured
  on the *service*, not baked into the image, so they persist across redeploys.
  After a deploy, spot-check one with **Run Now** (see `vault/10-ops/launch-checklist.md` §3).
  If you ever recreate the service, re-add **every** task from that checklist —
  there are **74** (`CRON_REGISTRY` in `services/edge-functions/src/lib/cron-runs.ts`
  is the source of truth, and `CRON_SETUP.md` is generated from it). This line
  said "16" for a long time; rebuilding from that number would have silently
  dropped 55 crons, including the consignor/affiliate payout jobs and the GDPR
  data-retention sweep. Count from the registry rather than trusting this
  sentence.
- **Verify:** `curl -fsS https://functions.gradethread.com/health/ready | jq` →
  `status:"ready"`. Edge logs show `[schema-version] OK` and `edge.boot`.
- **Rollback:** Coolify → Deployments → redeploy the previous successful commit
  (or revert the commit on `main` and let the webhook redeploy). Because the edge
  is backward-compatible with the prior frontend, this is safe to do alone.

## 3. Frontend (Cloudflare Pages)

- **Trigger:** Cloudflare Pages is on the **Git integration and auto-deploys on
  push to `main`** (confirmed in `.github/workflows/indexnow.yml`). No GitHub
  Actions deploy workflow is used or needed for the SPA — **do not** add one
  (it would double-deploy and risk leaking secrets into a workflow file).
- **Build command:** `npm run build` (TypeScript check → Vite build → prerender
  of public routes). Output dir: `dist`. Map the release stamp in the Pages build
  command: `VITE_RELEASE_SHA=$CF_PAGES_COMMIT_SHA npm run build`. Note the Pages
  build does **not** run the bundle-budget gate — that lives only in `ci.yml` /
  `npm run verify`, so a push that skipped CI can ship an over-budget bundle.
  The prerender also prepends ~40 trailing-slash 301s to `dist/_redirects`, which
  is why the built file differs from `public/_redirects`.
- **`wrangler.toml` `[vars]` are RUNTIME-only** — not build variables and not the
  Node version. Anything the build needs goes in the Pages env.
- **Env vars:** Pages → Settings → Environment variables → **Production** (the
  `VITE_*` set in `vault/10-ops/launch-checklist.md` §1c). Pages env changes only take effect
  on the **next** build — trigger a redeploy after editing them.
- **Routing:** app routes are served by **Pages Functions**, not `_redirects`.
  `functions/dashboard/[[path]].ts`, `functions/admin/…`, `functions/login.ts`
  and friends call `serveSpaShell` (`functions/_shared/spa-shell.ts`), which
  fetches `/` through the `ASSETS` binding and returns it with an explicit 200.
  Every such namespace is listed in `public/_routes.json` `include` so the
  Function runs **before** `_redirects`, which now holds only
  `/* → /404.html 404` for genuine 404s. Dynamic public surfaces (blog, cert SSR,
  robots/sitemap/rss/llms) are Functions too.
  > [!warning] Do **not** add a `→ /index.html 200` rewrite for a new app route.
  > Cloudflare Pages canonicalises that into a **308 → /**, and deep paths fall
  > through to the 404 catch-all — so hard-loads and refreshes of every app route
  > break on a perfectly current deploy. This was reproduced identically on the
  > raw `*.pages.dev` URL, which is what proved it was Pages behaviour rather
  > than a stale deploy or a zone redirect rule. **To add a client-only
  > namespace: add a Function *and* an `_routes.json` include entry.**
- **Diagnosing routing from anywhere** (no Cloudflare access needed):
  `curl -s -o /dev/null -w "%{http_code}" https://gradethread.com/dashboard/flipdesk/inventory`
  → expect **200**; a junk path → **404**. A 308 or 404 on a real app route means
  a missing Function or `_routes.json` entry.
- **Rollback:** Cloudflare Pages → Deployments → **Rollback** to a previous
  deployment (instant, no rebuild). See `vault/10-ops/rollback.md`.

---

## 4. Post-deploy verification

Run the smoke checks in **`vault/10-ops/launch-checklist.md` §6** after every production
deploy: edge liveness + readiness (incl. feature flags), a `stripe trigger`
webhook, a certificate page render, and the SEO endpoints. For a release that
touches the money/grade path, also run the Playwright critical-path e2e
(`npm run e2e`).

A deploy is "done" only when §6 is green. If readiness is `not_ready` or a
feature shows missing, fix the env/migration and redeploy that layer — don't
leave a half-green deploy in rotation.

### Before you call a deployed frontend fix "not deployed"

**Rule out the service worker first.** The PWA registers with `autoUpdate` +
`skipWaiting` + `clientsClaim` and workbox precaches the whole chunk graph into
**Cache Storage**, where the SW intercepts every request and can keep serving old
chunks after a successful deploy.

> Chrome's "Empty Cache and Hard Reload" clears the HTTP cache but **not** Cache
> Storage. Hard-reloading looks like a clean test and is not one.

- **Fastest confirmation:** open the site in an **Incognito window** — no SW, no
  cache, real deployed code. Works there ⇒ it is the SW.
- **Clear it:** DevTools → Application → Service Workers → **Unregister**, then
  Storage → **Clear site data**, then close and reopen the tab. Closing *all*
  tabs also lets `skipWaiting` swap it in.
- **Definitive check:** compare the route's lazy chunk hash in the Network tab
  against the Cloudflare build log's asset list. Judge from the **per-route**
  chunk — `vendor-react-*` and `vendor-supabase-*` hashes do not change when only
  app code does, so they prove nothing either way.

This cost multiple debugging turns once on a fix that had shipped correctly.

## Related

- [[rollback]] — the reverse of this, per surface; read it *before* you need it
- [[launch-checklist]] — the pre-launch gate this assumes has passed
- [[backups]] — take one before any forward-only migration
- [[migrations-process]] — the DB step of the order above
- [[incident-response]] — when a deploy is the incident
- [[moc-ops]]
