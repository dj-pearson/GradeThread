#!/usr/bin/env bash
# US-1108: apply pending migrations to a target Postgres AND record each version,
# so the edge schema-version guard (US-778) never goes stale from the apply
# method. Use this for the shell path; the Studio-paste path is covered by each
# migration's self-record footer (00254+). Safe to re-run — every migration is
# idempotent and recording uses ON CONFLICT DO NOTHING.
#
#   SUPABASE_DB_URL="postgres://…@host:5432/postgres" ./scripts/apply-prod-migrations.sh
#
# ⚠️ Back up prod first (BACKUPS.md). Migrations are forward-only.
set -euo pipefail

: "${SUPABASE_DB_URL:?set SUPABASE_DB_URL to the target Postgres connection string}"

DIR="$(cd "$(dirname "$0")/../supabase/migrations" && pwd)"

# Highest version the DB already knows (across both trackers). NULL-safe → 00000
# so a bare DB applies everything.
current="$(psql "$SUPABASE_DB_URL" -tAX \
  -c "SELECT coalesce(public.latest_schema_migration(), '00000');" 2>/dev/null || echo "00000")"
current="$(echo "$current" | tr -d '[:space:]')"
[ -n "$current" ] || current="00000"
echo "[migrate] current recorded version: $current"

applied=0
for f in $(ls "$DIR"/*.sql | sort); do
  base="$(basename "$f")"
  prefix="${base%%_*}"
  # Lexical compare matches the boot guard + the supabase_migrations ordering.
  [[ "$prefix" > "$current" ]] || continue

  echo "[migrate] applying $base"
  psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -f "$f"

  # Record it (idempotent). Guarded so files BEFORE 00254 — which run before the
  # tracker table exists — don't abort; 00254's seed records those instead.
  psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -c \
    "DO \$\$ BEGIN
       INSERT INTO public.applied_migrations (version) VALUES ('$prefix')
       ON CONFLICT (version) DO NOTHING;
     EXCEPTION WHEN undefined_table THEN NULL; END \$\$;"
  applied=$((applied + 1))
done

final="$(psql "$SUPABASE_DB_URL" -tAX -c "SELECT public.latest_schema_migration();" | tr -d '[:space:]')"
echo "[migrate] done — applied $applied file(s); now at: $final"
