#!/usr/bin/env bash
# US-493: apply every migration in order to a FRESH schema, stopping on the first
# error. Catches a migration that references a column/table an earlier migration
# didn't create — before it reaches production.
#
# IMPORTANT: the migrations reference Supabase schemas (auth, storage), so the
# target MUST be a Supabase-compatible Postgres. Easiest local check:
#     supabase db reset --no-seed     # applies all migrations from zero
# CI uses exactly that (see .github/workflows/db-migrations.yml). Use THIS raw
# psql loop only against a DB that already has the Supabase roles/schemas:
#     DATABASE_URL=postgres://... ./scripts/check-migrations.sh
set -euo pipefail

DB_URL="${DATABASE_URL:?set DATABASE_URL to a throwaway Postgres}"
MIG_DIR="$(cd "$(dirname "$0")/.." && pwd)/supabase/migrations"

echo "Applying migrations from $MIG_DIR to a fresh schema…"
count=0
for f in "$MIG_DIR"/*.sql; do
  echo "  → $(basename "$f")"
  psql "$DB_URL" -v ON_ERROR_STOP=1 -q -f "$f"
  count=$((count + 1))
done
echo "OK: $count migration(s) applied cleanly."
