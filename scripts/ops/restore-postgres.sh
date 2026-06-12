#!/usr/bin/env bash
# Restore a GradeThread Postgres backup (US-494).
#
# Usage:
#   restore-postgres.sh <dump-file> <target-db-url>
#
# The dump is the custom-format archive produced by backup-postgres.sh. The
# target should be a FRESH database on a Supabase Postgres image (it must have
# the supabase roles — anon/authenticated/service_role — and extensions; a
# vanilla postgres image will not restore cleanly). For an end-to-end drill on
# a scratch container, use scripts/ops/restore-drill.sh instead.
#
# Safety: refuses to touch anything that resolves to the production host
# unless ALLOW_PROD_RESTORE=1 is set explicitly.

set -euo pipefail

DUMP="${1:?usage: restore-postgres.sh <dump-file> <target-db-url>}"
TARGET="${2:?usage: restore-postgres.sh <dump-file> <target-db-url>}"

[ -f "$DUMP" ] || { echo "ERROR: dump file not found: $DUMP" >&2; exit 1; }

case "$TARGET" in
  *gradethread.com*)
    if [ "${ALLOW_PROD_RESTORE:-}" != "1" ]; then
      echo "ERROR: target looks like PRODUCTION. A restore drops/replaces data." >&2
      echo "Set ALLOW_PROD_RESTORE=1 only during a real, announced recovery." >&2
      exit 1
    fi
    ;;
esac

# Verify integrity (and sha256 if the sidecar shipped with the dump).
pg_restore --list "$DUMP" >/dev/null
if [ -f "$DUMP.sha256" ]; then
  (cd "$(dirname "$DUMP")" && sha256sum -c "$(basename "$DUMP").sha256")
fi

echo "[restore-postgres] restoring $DUMP -> target"
START=$(date +%s)
# --clean --if-exists: drop objects the fresh Supabase image pre-creates
# (auth/storage schemas) before recreating them from the dump. pg_restore
# reports "errors ignored" for pre-existing extension scaffolding; the sanity
# queries below — not a zero error count — are the success criterion.
pg_restore --no-owner --no-privileges --clean --if-exists \
  --dbname="$TARGET" "$DUMP" || true
echo "[restore-postgres] pg_restore finished in $(( $(date +%s) - START ))s"

echo "[restore-postgres] sanity checks:"
psql "$TARGET" -v ON_ERROR_STOP=1 -At <<'SQL'
select 'latest migration: ' || max(version) from supabase_migrations.schema_migrations;
select 'public.users rows: ' || count(*) from public.users;
select 'submissions rows: ' || count(*) from public.submissions;
select 'grade_reports rows: ' || count(*) from public.grade_reports;
select 'storage.objects rows: ' || count(*) from storage.objects;
SQL
echo "[restore-postgres] done — compare the counts above against the source."
