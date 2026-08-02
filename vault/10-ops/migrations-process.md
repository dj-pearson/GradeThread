---
title: Migration process
aliases: [MIGRATIONS, migration process]
type: runbook
status: current
source_of_truth: vault
code_refs: []
reviewed: 2026-07-19
tags: [ops, database, migrations]
summary: How migrations are authored, verified and applied to self-hosted prod.
---
# Database Migration Process (US-493)

Schema migrations must be applied to production **reliably and in order**, so the
deployed code never runs against a schema that's missing a column/table (the root
cause of the `/verified/*` + `/flipdesk/pricing/*` 500s).

## 🚨 Fast recovery: edge crash-looping on a stale DB (`npm run catchup`)

**Symptom** — the edge container won't boot and the site is down; logs repeat:

```
[schema-version] DB is STALE: applied=00256, this build expects 00282. Refusing to start.
```

This means prod's DB is behind the deployed edge build (a push redeployed edge
before the migrations were pasted into Studio). To recover, apply every migration
above `applied=NNNNN`. **One command builds that paste for you:**

```bash
npm run catchup -- 00256     # use the applied=NNNNN number straight from the log
```

It bundles every migration after `00256` into `scripts/prod-catchup-<today>.sql`,
**copies the SQL to your clipboard** (Windows), and prints the target version. Then:

1. Back up prod first (`vault/10-ops/backups.md`).
2. Supabase Studio → SQL editor → **paste** (clipboard) → Run.
3. Confirm the final `SELECT public.latest_schema_migration()` prints the target
   version. The edge boots clean on the next restart.

The bundle is idempotent and self-recording, so it's safe to re-run. You can pass
the number any way the log shows it — `00256`, `256`, or `applied=00256`.

> **Stop the bleeding for good:** run `npm run catchup`, paste into Studio, **then**
> `git push`. Applying migrations *before* the push means the edge never redeploys
> ahead of the DB, so it never crash-loops. (`generate the bundle` = `make-catchup.mjs`.)

## Where migrations live

`supabase/migrations/NNNNN_description.sql`, applied in lexical order. Each file
is idempotent where practical (`IF NOT EXISTS`, `ON CONFLICT DO NOTHING`,
`DO $$ ... IF NOT EXISTS ... $$`).

## Applying to production (gated runbook)

Self-hosted Supabase exposes Postgres directly. Always take a backup first
(see `vault/10-ops/backups.md`). **Prefer the apply script** — it applies pending files in
order AND records the version rows the edge boot guard reads, in one shot:

```bash
# 1. Confirm what's applied vs. what's in the repo.
psql "$SUPABASE_DB_URL" -c "select public.latest_schema_migration();"

# 2. Dry-run on a fresh scratch DB (CI does this automatically — see below).
# 3. Back up prod (BACKUPS.md), then apply + record pending files IN ORDER:
SUPABASE_DB_URL="$SUPABASE_DB_URL" ./scripts/apply-prod-migrations.sh

# 4. Re-test the endpoints that depend on the new schema, e.g.:
curl -fsS https://functions.gradethread.com/api/grading/public | jq .
```

Pasting into the Studio SQL editor also works for a one-off: every migration
**self-records its own version** (footer below), so the guard stays in sync
without a manual catchup either way — **as long as the paste happens before the
edge redeploys.** When a push redeploys edge first (the common case), use the
`npm run catchup` recovery at the top of this doc.

Record each production apply (date, migrations applied, operator) in the deploy
log / incident channel.

## Self-recording footer (US-1108 — the fix for stale-guard catchups)

Every migration `00255+` MUST end with this footer, so applying it by ANY method
(Studio paste, `psql -f`, the apply script, or the Supabase CLI) records its
version into `public.applied_migrations` — the table `latest_schema_migration()`
reads alongside the CLI's `supabase_migrations.schema_migrations`. This is what
stops the edge refusing to boot against a "stale" DB when the apply path didn't
write a tracker row. The footer makes the catchup *correct* without a separate
backfill; `npm run catchup` (top of this doc) is still how you *recover* when a
deploy outpaces the Studio paste.

```sql
-- self-record (US-1108): keeps the edge schema-version guard (US-778) in sync no
-- matter how this migration is applied. Version = this file's NNNNN prefix.
INSERT INTO public.applied_migrations (version) VALUES ('00255')
ON CONFLICT (version) DO NOTHING;
```

A CI guard (`services/edge-functions/src/tests/schema-version_test.ts`, in
`verify:edge`) fails the build if a migration after `00254` omits it. The footer
writes ONLY to `public.applied_migrations` (never the CLI's table), so it can't
collide with `supabase db reset` in the local `verify:db` lane.

## CI validation (drift + clean-apply)

`.github/workflows/*` should fail a deploy when migrations don't apply cleanly on
a fresh schema. The check: spin up `postgres`, apply every migration in order
with `ON_ERROR_STOP=1`. A migration that references a column a prior migration
didn't create fails here, not in prod.

> [!todo] **MANUAL / FOLLOW-UP:** wire `scripts/check-migrations.sh` (clean-apply on a
> throwaway Postgres service container) into CI as a required check.

## Schema-version assertion at edge boot (US-778 — DONE)

The edge service refuses to start against a **stale** DB. At boot
`assertSchemaVersion()` (`services/edge-functions/src/lib/schema-version.ts`)
compares a hardcoded `EXPECTED_SCHEMA_VERSION` to the latest applied migration,
read via the `public.latest_schema_migration()` RPC (a `SECURITY DEFINER`
bridge to `supabase_migrations.schema_migrations`, migration 00126):

- **Behind in production** → logs expected-vs-actual and exits non-zero (Coolify's
  restart loop makes the bad deploy loud).
- **Behind in dev** → warns only.
- **Migrations table unreadable / not recorded** → warns and proceeds
  (fail-OPEN; only a *confirmed* behind-version is fatal).

> [!important] **THE RULE:** every commit that adds a `supabase/migrations/NNNNN_*.sql` file
> MUST bump `EXPECTED_SCHEMA_VERSION` to that same `NNNNN` in the same commit.
> A CI sync-check (`src/tests/schema-version_test.ts`, in `verify:edge`) fails the
> build if the constant doesn't equal the lexically-last migration prefix, so it
> can't silently go stale.

> [!warning] **PROD APPLY NOTE:** for the assertion to be *active* in prod, the apply path
> must record versions into `supabase_migrations.schema_migrations` (the Supabase
> CLI does this automatically; a raw `psql -f` loop does NOT — add the version
> rows, or prefer the CLI). If it isn't recorded the check simply fail-opens.

### The trap: creating the tracker arms the guard

Fail-open and fatal are not two settings — they are the **same guard with and
without a tracker table**. Prod ran for a long time with no
`supabase_migrations.schema_migrations` at all (`42P01`), so a hand `psql -f`
apply silently skipped files and the guard warned rather than blocked. Real drift
hid behind that: functions from `00126` and `00148` absent while tables from
`00212`/`00220`/`00228` existed, surfacing as a 404 on an RPC, a 400 on a
`listings` select, and 500s on two FlipDesk routes.

Creating the tracker to fix that **arms the guard**, and the next deploy
crash-looped on `applied=00231, this build expects 00249`. Nothing regressed —
the DDL was current and the *tracker* lagged, because hand-applying runs the DDL
without inserting version rows.

So when the guard says STALE, establish which of two states you are in before
acting:

| | DDL missing | DDL present, tracker lagging |
|---|---|---|
| Fix | apply the migrations (`npm run catchup`) | backfill the version range only |
| Do **not** | backfill — it masks the real gap | re-apply DDL or reload the schema |

**Verify the top migration's objects actually exist before backfilling.** That
check is the entire difference between the two columns, and skipping it converts
a visible outage into a silent one.

Backfill form:

```sql
INSERT INTO supabase_migrations.schema_migrations(version)
SELECT lpad(g::text, 5, '0') FROM generate_series(<first>, <last>) g
ON CONFLICT DO NOTHING;
```

After any hand-apply, also run `NOTIFY pgrst, 'reload schema';` — PostgREST
caches the schema and will keep 404ing a new RPC until it does.

### The grace window, and the gate that would make it unnecessary

A migration and an edge roll are separate steps ([[deploy]]), so the container
can boot moments before the SQL lands. The guard therefore re-polls across a
grace window before declaring fatal — `SCHEMA_GUARD_GRACE_ATTEMPTS` (8) ×
`SCHEMA_GUARD_GRACE_DELAY_MS` (5000), about 40s, tunable without a redeploy. A
race becomes a delayed boot; a genuinely forgotten migration still ends in the
same loud fatal.

That is the safety net. The root fix — wiring `npm run migrate:prod` as the
edge's Coolify **Pre-deployment Command**, so a failed migration aborts the
rollout and the old container keeps serving — is a one-time ops setup that is
**still pending**; see [[deploy]] step 3 and [[blocked-work-gates]].

## One-time backfill: confirm 00057–00074 (and 00094–00097) are applied

The audit found 00057–00074 may be unapplied in prod. Verify and apply:

```bash
psql "$SUPABASE_DB_URL" -c \
  "select count(*) from supabase_migrations.schema_migrations where version between '00057' and '00097';"
```

If rows are missing, apply the gap with the loop above (each file is idempotent,
so re-applying an already-present one is safe). The new production-ops migrations
**00094 (job_locks), 00095 (email_deliveries), 00096 (feature_flags), 00097
(integrity constraints)** must be applied before the new crons/kill-switches work.

## Rollback

Migrations are forward-only. To revert a bad schema change, write a new
compensating migration. For a catastrophic bad migration, restore from backup
(see `vault/10-ops/backups.md` + `vault/10-ops/rollback.md`).

## Why `PENDING_MIGRATIONS.md` is NOT in the vault

Decided during US-2051. `PENDING_MIGRATIONS.md` is **3,830 lines** — the largest
markdown file in the repo by roughly 6× — and it was deliberately left at the
repo root.

It is a **mutable work queue**, not durable knowledge. Rows are appended as
migrations are written and removed as they are applied to production; the file's
value is entirely in its current contents, and nothing in it is true a month
later. That is the opposite of what a vault note is for.

Two concrete reasons it would make the vault worse:

- **It would blow the retrieval budget.** The index is capped at 400 lines
  precisely so an agent reads one page and stops. A 3,830-line queue in the
  knowledge surface is 10× the entire index, for content that changes weekly.
- **The drift guard has nothing to say about it.** `reviewed` is meaningless for
  a file whose whole purpose is to change; it would generate a permanent warning
  nobody can action, which is how a review queue loses credibility.

The *process* for handling pending migrations belongs here. The *queue* stays
where the work is. Do not revisit this without a reason that addresses both
points above.

## Related

- [[deploy]] — migrations are the first step of the deploy order
- [[backups]] — take one first; migrations are forward-only
- [[moc-ops]]
