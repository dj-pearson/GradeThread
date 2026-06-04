# Database Migration Process (US-493)

Schema migrations must be applied to production **reliably and in order**, so the
deployed code never runs against a schema that's missing a column/table (the root
cause of the `/verified/*` + `/flipdesk/pricing/*` 500s).

## Where migrations live

`supabase/migrations/NNNNN_description.sql`, applied in lexical order. Each file
is idempotent where practical (`IF NOT EXISTS`, `ON CONFLICT DO NOTHING`,
`DO $$ ... IF NOT EXISTS ... $$`).

## Applying to production (gated runbook)

Self-hosted Supabase exposes Postgres directly. Apply with the Supabase CLI
**or** psql. Always take a backup first (see `BACKUPS.md`).

```bash
# 1. Confirm what's applied vs. what's in the repo.
psql "$SUPABASE_DB_URL" -c \
  "select version from supabase_migrations.schema_migrations order by version;"

# 2. Dry-run on a fresh scratch DB (CI does this automatically — see below).
# 3. Back up prod (BACKUPS.md), then apply pending files IN ORDER:
for f in $(ls supabase/migrations/*.sql | sort); do
  echo "applying $f"; psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -f "$f";
done

# 4. Re-test the endpoints that depend on the new schema, e.g.:
curl -fsS https://functions.gradethread.com/api/grading/public | jq .
```

Record each production apply (date, migrations applied, operator) in the deploy
log / incident channel.

## CI validation (drift + clean-apply)

`.github/workflows/*` should fail a deploy when migrations don't apply cleanly on
a fresh schema. The check: spin up `postgres`, apply every migration in order
with `ON_ERROR_STOP=1`. A migration that references a column a prior migration
didn't create fails here, not in prod.

> **MANUAL / FOLLOW-UP:** wire `scripts/check-migrations.sh` (clean-apply on a
> throwaway Postgres service container) into CI as a required check, and add a
> boot-time assertion in the edge service that the latest expected migration
> version is present (compare a hardcoded `EXPECTED_SCHEMA_VERSION` to
> `schema_migrations`), logging loudly / refusing risky writes if behind.

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
