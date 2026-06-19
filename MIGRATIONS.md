# Database Migration Process (US-493)

Schema migrations must be applied to production **reliably and in order**, so the
deployed code never runs against a schema that's missing a column/table (the root
cause of the `/verified/*` + `/flipdesk/pricing/*` 500s).

## Where migrations live

`supabase/migrations/NNNNN_description.sql`, applied in lexical order. Each file
is idempotent where practical (`IF NOT EXISTS`, `ON CONFLICT DO NOTHING`,
`DO $$ ... IF NOT EXISTS ... $$`).

## Applying to production (gated runbook)

Self-hosted Supabase exposes Postgres directly. Always take a backup first
(see `BACKUPS.md`). **Prefer the apply script** — it applies pending files in
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
without a manual catchup either way.

Record each production apply (date, migrations applied, operator) in the deploy
log / incident channel.

## Self-recording footer (US-1108 — the fix for stale-guard catchups)

Every migration `00255+` MUST end with this footer, so applying it by ANY method
(Studio paste, `psql -f`, the apply script, or the Supabase CLI) records its
version into `public.applied_migrations` — the table `latest_schema_migration()`
reads alongside the CLI's `supabase_migrations.schema_migrations`. This is what
stops the edge refusing to boot against a "stale" DB when the apply path didn't
write a tracker row (the recurring `prod-catchup-*.sql` chore — now retired).

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

> **MANUAL / FOLLOW-UP:** wire `scripts/check-migrations.sh` (clean-apply on a
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

> **THE RULE:** every commit that adds a `supabase/migrations/NNNNN_*.sql` file
> MUST bump `EXPECTED_SCHEMA_VERSION` to that same `NNNNN` in the same commit.
> A CI sync-check (`src/tests/schema-version_test.ts`, in `verify:edge`) fails the
> build if the constant doesn't equal the lexically-last migration prefix, so it
> can't silently go stale.

> **PROD APPLY NOTE:** for the assertion to be *active* in prod, the apply path
> must record versions into `supabase_migrations.schema_migrations` (the Supabase
> CLI does this automatically; a raw `psql -f` loop does NOT — add the version
> rows, or prefer the CLI). If it isn't recorded the check simply fail-opens.

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
(see `BACKUPS.md` + `ROLLBACK.md`).
