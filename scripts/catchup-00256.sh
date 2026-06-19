#!/usr/bin/env bash
# ── Schema catch-up: 00254 → 00256 ──────────────────────────────────────────
# Fixes the edge restart loop:
#   [schema-version] DB is STALE: applied=00254, this build expects 00256.
#   Refusing to start.
#
# The edge boot guard (services/edge-functions/src/lib/schema-version.ts,
# EXPECTED_SCHEMA_VERSION="00256") refuses to start until prod's recorded
# schema version reaches 00256. Prod is at 00254, so two migrations are
# pending:
#   00255_drip_campaign_definitions.sql   (US-945)
#   00256_garment_passport_core.sql       (US-1089)
#
# Both are idempotent and self-record their version (US-1108 footer), so this
# is safe to re-run and the boot guard advances no matter the apply path.
#
# Usage (⚠️ back up prod first — BACKUPS.md):
#   SUPABASE_DB_URL="postgres://…@db-host:5432/postgres" ./scripts/catchup-00256.sh
#
# This is just a thin, explicit wrapper over scripts/apply-prod-migrations.sh
# scoped to the two pending files. For the general "apply everything pending"
# path, use apply-prod-migrations.sh directly.
set -euo pipefail

: "${SUPABASE_DB_URL:?set SUPABASE_DB_URL to the prod Postgres connection string}"

DIR="$(cd "$(dirname "$0")/../supabase/migrations" && pwd)"

before="$(psql "$SUPABASE_DB_URL" -tAX \
  -c "SELECT coalesce(public.latest_schema_migration(), '00000');" | tr -d '[:space:]')"
echo "[catchup] recorded schema version before: ${before:-unknown}"

for prefix in 00255 00256; do
  f="$DIR/${prefix}"_*.sql
  # shellcheck disable=SC2086
  f="$(ls $f)"
  echo "[catchup] applying $(basename "$f")"
  psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -f "$f"
done

after="$(psql "$SUPABASE_DB_URL" -tAX \
  -c "SELECT public.latest_schema_migration();" | tr -d '[:space:]')"
echo "[catchup] recorded schema version after: $after"

if [ "$after" = "00256" ]; then
  echo "[catchup] ✓ DB now at 00256 — redeploy/restart the edge service; the boot guard will pass."
else
  echo "[catchup] ✗ expected 00256 but DB reports '$after' — do NOT restart the edge yet; investigate." >&2
  exit 1
fi
