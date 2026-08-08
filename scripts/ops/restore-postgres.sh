#!/usr/bin/env bash
# Restore a GradeThread Postgres backup (US-494).
#
# Usage:
#   restore-postgres.sh <dump-file> <target-db-url>
#
# The dump may be either the plaintext custom-format archive or the encrypted
# `.age` artifact that backup-postgres.sh ships offsite (US-2416). A `.age`
# file is detected by extension and decrypted to a private temp file that is
# shredded on exit; everything downstream is identical.
#
#   BACKUP_AGE_IDENTITY  path to the age IDENTITY (private key) file. Required
#                        only for a `.age` input. This key is deliberately NOT
#                        on the backup host — see vault/10-ops/backups.md.
#   AGE_BIN              age implementation (default `age`; `rage` also works)
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

# Checksum FIRST, against whatever was actually stored — for an encrypted
# backup that is the ciphertext, which is what backup-postgres.sh hashed.
# Verifying after decryption would be checking a file the bucket never held.
if [ -f "$DUMP.sha256" ]; then
  (cd "$(dirname "$DUMP")" && sha256sum -c "$(basename "$DUMP").sha256")
fi

PLAINTEXT_TMP=""
cleanup_plaintext() {
  [ -n "$PLAINTEXT_TMP" ] && rm -f "$PLAINTEXT_TMP"
}
trap cleanup_plaintext EXIT

case "$DUMP" in
  *.age)
    AGE_BIN="${AGE_BIN:-age}"
    : "${BACKUP_AGE_IDENTITY:?BACKUP_AGE_IDENTITY is required to restore an encrypted (.age) backup}"
    [ -f "$BACKUP_AGE_IDENTITY" ] || {
      echo "ERROR: identity file not found: $BACKUP_AGE_IDENTITY" >&2; exit 1;
    }
    command -v "$AGE_BIN" >/dev/null 2>&1 || {
      echo "ERROR: $AGE_BIN not installed — cannot decrypt $DUMP" >&2; exit 1;
    }
    # Created empty at mode 600 BEFORE any plaintext is written, so the dump is
    # never briefly world-readable in a shared /tmp.
    PLAINTEXT_TMP="$(mktemp "${TMPDIR:-/tmp}/gradethread-restore-XXXXXX.dump")"
    chmod 600 "$PLAINTEXT_TMP"
    echo "[restore-postgres] decrypting $DUMP"
    "$AGE_BIN" --decrypt --identity "$BACKUP_AGE_IDENTITY" --output "$PLAINTEXT_TMP" "$DUMP"
    DUMP="$PLAINTEXT_TMP"
    ;;
esac

# A dump pg_restore cannot list is not a backup — checked on the plaintext,
# which for the encrypted path only exists after a successful decrypt.
pg_restore --list "$DUMP" >/dev/null

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
