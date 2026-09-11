#!/usr/bin/env bash
# Restore a GradeThread Postgres backup (US-494, hardened by US-3394).
#
# Usage:
#   RESTORE_CONFIRM_TARGET="<host>:<port>/<dbname>" \
#     restore-postgres.sh <dump-file> <target-db-url>
#
# Run it with no RESTORE_CONFIRM_TARGET first: it refuses, and the refusal
# prints the exact credential-free string to copy back. That is the whole
# interface, and it is deliberate. See "Safety" below.
#
# The dump may be either the plaintext custom-format archive or the encrypted
# .age artifact that backup-postgres.sh ships offsite (US-2416). A .age file is
# detected by extension and decrypted to a private temp file that is shredded
# on exit; everything downstream is identical.
#
#   BACKUP_AGE_IDENTITY  path to the age IDENTITY (private key) file. Required
#                        only for a .age input. This key is deliberately NOT on
#                        the backup host. See vault/10-ops/backups.md.
#   AGE_BIN              age implementation (default age; rage also works)
#
# Optional:
#   SOURCE_DB_URL        if set, the same sanity queries are run against this
#                        database and compared value-for-value with the
#                        restored copy. This is the strongest check available
#                        and is what restore-drill.sh does with its own source.
#   RESTORE_ALLOW_EMPTY  set to 1 to accept a table that came back with zero
#                        rows. Without it, zero is a FAILURE: an empty table is
#                        what a half-applied restore looks like, and a drill
#                        whose counts are all zero passes vacuously.
#
# The dump is the custom-format archive produced by backup-postgres.sh. The
# target should be a FRESH database on a Supabase Postgres image (it must have
# the supabase roles, anon/authenticated/service_role, and the extensions; a
# vanilla postgres image will not restore cleanly). For an end-to-end drill on
# a scratch container, use scripts/ops/restore-drill.sh instead.
#
# ---------------------------------------------------------------------------
# Safety (US-3394). READ THIS BEFORE CHANGING THE GUARD.
# ---------------------------------------------------------------------------
# This script used to refuse only when the target string contained the
# substring "gradethread.com", unless ALLOW_PROD_RESTORE=1 was set.
#
# No GradeThread Postgres DSN contains that substring. gradethread.com names
# the HTTP surfaces (api. and functions.), while Postgres is reached either as
# postgres://postgres:...@<host>:5432/postgres (the documented shape, in
# services/edge-functions/.env.example) or not over a URL at all: migrate-prod
# reaches prod by ssh plus docker exec, and the backup cron runs on the DB host
# itself. So the guard never once fired, on any target, while the runbook
# described this script as "prod-guarded".
#
# The replacement does not try to recognise production. "This looks like prod"
# is a judgement no string match can make, and a heuristic that is wrong is
# worse than no heuristic, because it manufactures confidence. Instead:
#
#   EVERY target is refused by default, and the operator must name back the
#   specific host:port/dbname they are about to drop and replace.
#
# The confirmation is the target's own identity rather than a blanket flag, so
# it cannot be pre-set in a shell profile or a CI environment and forgotten,
# and it cannot be satisfied by confirming a different target than the one on
# the command line. It is credential-free on purpose: the operator never has to
# re-type a password into a second place.
#
# pg_restore's own failure is also no longer swallowed, and the script compares
# its sanity counts itself rather than printing them and asking an operator who
# is mid-incident to do the arithmetic.

set -euo pipefail

# ---------------------------------------------------------------------------
# Decision logic. These functions touch nothing; everything below the
# RESTORE_POSTGRES_SOURCE_ONLY hook is the half that drops a database.
# scripts/restore-postgres-guard.test.mjs sources this file with that variable
# set and calls them directly, which is how the guard finally gets exercised.
# ---------------------------------------------------------------------------

# Credential-free identity of a connection target: host:port/dbname.
# The password is never echoed, so the string is safe to print in an error and
# safe to paste back into a shell.
target_fingerprint() {
  local target="${1:-}" rest hostpart hostport db host port
  db=""
  hostport=""
  case "$target" in
    "")
      echo "(empty)"
      return 0
      ;;
    *://*)
      rest="${target#*://}"
      # Last '@' wins: a password may itself contain '@' or '/'.
      hostpart="${rest##*@}"
      hostport="${hostpart%%/*}"
      if [ "$hostpart" != "$hostport" ]; then db="${hostpart#*/}"; fi
      hostport="${hostport%%\?*}"
      db="${db%%\?*}"
      ;;
    *=*)
      # libpq keyword/value conninfo: host=... port=... dbname=...
      host="$(printf '%s' "$target" | tr ' ' '\n' | sed -n 's/^host=//p' | head -1)"
      port="$(printf '%s' "$target" | tr ' ' '\n' | sed -n 's/^port=//p' | head -1)"
      db="$(printf '%s' "$target" | tr ' ' '\n' | sed -n 's/^dbname=//p' | head -1)"
      hostport="$host"
      if [ -n "$port" ]; then hostport="$host:$port"; fi
      ;;
    *)
      # psql treats a bare word as a database name on the local socket.
      db="$target"
      ;;
  esac

  case "$hostport" in
    \[*\]*)
      # IPv6 literal, e.g. [::1]:5432
      host="${hostport%%\]*}]"
      port="${hostport##*\]}"
      port="${port#:}"
      ;;
    *:*)
      host="${hostport%%:*}"
      port="${hostport##*:}"
      ;;
    *)
      host="$hostport"
      port=""
      ;;
  esac

  [ -n "$host" ] || host="(local)"
  [ -n "$port" ] || port="5432"
  [ -n "$db" ] || db="(default)"
  printf '%s:%s/%s\n' "$host" "$port" "$db"
}

# Default-refuse gate. Returns 0 only when the operator has confirmed THIS
# target. Prints the string to confirm with, never the DSN.
confirm_target() {
  local target="${1:-}" fingerprint given
  fingerprint="$(target_fingerprint "$target")"
  given="$(printf '%s' "${RESTORE_CONFIRM_TARGET:-}" | tr -d '[:space:]')"

  if [ -n "${ALLOW_PROD_RESTORE:-}" ]; then
    echo "NOTE: ALLOW_PROD_RESTORE is set and is no longer read (US-3394). It" >&2
    echo "      gated on the target containing 'gradethread.com', which no" >&2
    echo "      GradeThread Postgres DSN contains, so it never once fired." >&2
  fi

  if [ -n "$given" ] && [ "$given" = "$fingerprint" ]; then
    echo "[restore-postgres] target confirmed: $fingerprint"
    return 0
  fi

  echo "ERROR: refusing to restore. This drops and replaces every object in the" >&2
  echo "       target database, so the target has to be named back explicitly." >&2
  echo "" >&2
  echo "  target resolves to: $fingerprint" >&2
  if [ -n "$given" ]; then
    echo "  you confirmed:      $given" >&2
    echo "" >&2
    echo "  Those do not match. Confirm the target you actually passed, or fix" >&2
    echo "  the target. This mismatch is the case the check exists for." >&2
  else
    echo "" >&2
    echo "  Re-run with:" >&2
    echo "    RESTORE_CONFIRM_TARGET='$fingerprint' \\" >&2
    echo "      $0 <dump-file> <target-db-url>" >&2
  fi
  echo "" >&2
  echo "  Read that line before you paste it. It carries no password, and it is" >&2
  echo "  the only thing standing between this dump and that database." >&2
  return 1
}

# pg_restore exits non-zero for TWO different things: a genuine failure, and a
# run that completed while ignoring errors (the pre-existing Supabase
# scaffolding case, which is expected). Echoes the ignored-error count, or -1
# when pg_restore reported no such line, which means the non-zero exit was a
# real failure.
restore_ignored_errors() {
  local n
  n="$(printf '%s\n' "${1:-}" |
    sed -n 's/.*errors ignored on restore: \([0-9][0-9]*\).*/\1/p' | tail -1)"
  if [ -n "$n" ]; then printf '%s\n' "$n"; else printf '%s\n' "-1"; fi
}

# schema.table for every TABLE entry in a "pg_restore --list" TOC, read on
# stdin. TABLE DATA entries are skipped: they repeat the same tables.
toc_tables_from_list() {
  awk '
    /^;/ { next }
    {
      for (i = 1; i <= NF; i++) {
        if ($i == "TABLE" && $(i + 1) != "DATA" && $(i + 2) != "") {
          print $(i + 1) "." $(i + 2)
          break
        }
      }
    }' | LC_ALL=C sort -u
}

# Judges the sanity counts on their own terms, with no source to compare to.
# Reads "label|value" lines on stdin. Returns 1 if anything is wrong.
evaluate_counts() {
  local label value failed=0
  while IFS='|' read -r label value; do
    [ -n "$label" ] || continue
    if [ "$label" = "latest_migration" ]; then
      if [ -z "$value" ]; then
        echo "  FAIL $label: supabase_migrations.schema_migrations is empty"
        failed=1
      else
        echo "  OK   $label: $value"
      fi
      continue
    fi
    case "$value" in
      '' | *[!0-9]*)
        echo "  FAIL $label: not a count ('$value')"
        failed=1
        ;;
      0)
        if [ "${RESTORE_ALLOW_EMPTY:-}" = "1" ]; then
          echo "  WARN $label: 0 rows, accepted via RESTORE_ALLOW_EMPTY=1"
        else
          echo "  FAIL $label: 0 rows. An empty table is what a half-applied"
          echo "       restore looks like. Set RESTORE_ALLOW_EMPTY=1 only if the"
          echo "       source database really is empty here."
          failed=1
        fi
        ;;
      *)
        echo "  OK   $label: $value"
        ;;
    esac
  done
  return "$failed"
}

# Compares two "label|value" blocks value-for-value. $1 = source, $2 = restored.
compare_counts() {
  local expected="${1:-}" actual="${2:-}" label want got failed=0
  while IFS='|' read -r label want; do
    [ -n "$label" ] || continue
    got="$(printf '%s\n' "$actual" | sed -n "s/^${label}|//p" | head -1)"
    if [ "$want" = "$got" ]; then
      echo "  OK   $label matches source: $want"
    else
      echo "  FAIL $label: source=$want restored=$got"
      failed=1
    fi
  done <<EOF
$expected
EOF
  return "$failed"
}

SANITY_SQL="
select 'latest_migration|' || coalesce(max(version), '') from supabase_migrations.schema_migrations;
select 'users|' || count(*) from public.users;
select 'submissions|' || count(*) from public.submissions;
select 'grade_reports|' || count(*) from public.grade_reports;
select 'storage_objects|' || count(*) from storage.objects;
select 'rls_policies|' || count(*) from pg_policies;
"

TABLE_LIST_SQL="
select n.nspname || '.' || c.relname
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where c.relkind in ('r', 'p')
  and n.nspname not in ('pg_catalog', 'information_schema', 'pg_toast')
"

# Sourcing hook for the test. An executed run never sets this.
if [ "${RESTORE_POSTGRES_SOURCE_ONLY:-}" = "1" ]; then
  return 0
fi

# ---------------------------------------------------------------------------
# From here down, this script changes a database.
# ---------------------------------------------------------------------------

DUMP="${1:?usage: restore-postgres.sh <dump-file> <target-db-url>}"
TARGET="${2:?usage: restore-postgres.sh <dump-file> <target-db-url>}"

[ -f "$DUMP" ] || { echo "ERROR: dump file not found: $DUMP" >&2; exit 1; }

confirm_target "$TARGET" || exit 1

# Checksum FIRST, against whatever was actually stored. For an encrypted backup
# that is the ciphertext, which is what backup-postgres.sh hashed. Verifying
# after decryption would be checking a file the bucket never held.
if [ -f "$DUMP.sha256" ]; then
  (cd "$(dirname "$DUMP")" && sha256sum -c "$(basename "$DUMP").sha256")
fi

PLAINTEXT_TMP=""
WORK_TMP=""
cleanup_tmp() {
  [ -n "$PLAINTEXT_TMP" ] && rm -f "$PLAINTEXT_TMP"
  [ -n "$WORK_TMP" ] && rm -rf "$WORK_TMP"
  return 0
}
trap cleanup_tmp EXIT

case "$DUMP" in
  *.age)
    AGE_BIN="${AGE_BIN:-age}"
    : "${BACKUP_AGE_IDENTITY:?BACKUP_AGE_IDENTITY is required to restore an encrypted (.age) backup}"
    [ -f "$BACKUP_AGE_IDENTITY" ] || {
      echo "ERROR: identity file not found: $BACKUP_AGE_IDENTITY" >&2; exit 1;
    }
    command -v "$AGE_BIN" >/dev/null 2>&1 || {
      echo "ERROR: $AGE_BIN not installed, cannot decrypt $DUMP" >&2; exit 1;
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

WORK_TMP="$(mktemp -d "${TMPDIR:-/tmp}/gradethread-restore-work-XXXXXX")"

# A dump pg_restore cannot list is not a backup, checked on the plaintext,
# which for the encrypted path only exists after a successful decrypt. The same
# listing is the inventory the coverage check below holds the target to.
pg_restore --list "$DUMP" > "$WORK_TMP/toc.txt"
toc_tables_from_list < "$WORK_TMP/toc.txt" > "$WORK_TMP/expected-tables.txt"
EXPECTED_TABLE_COUNT="$(wc -l < "$WORK_TMP/expected-tables.txt" | tr -d '[:space:]')"
if [ "$EXPECTED_TABLE_COUNT" = "0" ]; then
  echo "ERROR: the dump's table of contents lists no tables. Either this is not" >&2
  echo "       a GradeThread dump or it is truncated. Refusing to restore it." >&2
  exit 1
fi
echo "[restore-postgres] dump lists $EXPECTED_TABLE_COUNT tables"

if [ -n "${SOURCE_DB_URL:-}" ]; then
  echo "[restore-postgres] capturing source counts for comparison"
  if ! SOURCE_COUNTS="$(psql "$SOURCE_DB_URL" -v ON_ERROR_STOP=1 -At -c "$SANITY_SQL")"; then
    echo "ERROR: SOURCE_DB_URL is set but the sanity queries failed against it." >&2
    exit 1
  fi
fi

echo "[restore-postgres] restoring $DUMP -> $(target_fingerprint "$TARGET")"
START=$(date +%s)
# --clean --if-exists: drop objects the fresh Supabase image pre-creates
# (auth/storage schemas) before recreating them from the dump.
#
# US-3394: this line used to end in "|| true", which discarded pg_restore's
# exit code entirely, so a connection refused, a wrong target, a truncated
# archive and a clean restore all reached the same "done" message. The two
# meanings of a non-zero exit are now told apart, and neither reaches exit 0 on
# its own: the verification below is what decides.
set +e
pg_restore --no-owner --no-privileges --clean --if-exists \
  --dbname="$TARGET" "$DUMP" 2>&1 | tee "$WORK_TMP/restore.log"
RESTORE_RC="${PIPESTATUS[0]}"
set -e
ELAPSED=$(( $(date +%s) - START ))
IGNORED="$(restore_ignored_errors "$(cat "$WORK_TMP/restore.log")")"

if [ "$RESTORE_RC" != "0" ] && [ "$IGNORED" = "-1" ]; then
  echo "" >&2
  echo "ERROR: pg_restore exited $RESTORE_RC without reporting ignored errors." >&2
  echo "       That is a hard failure, an unreachable or wrong target, bad" >&2
  echo "       credentials, or an unreadable archive, not the scaffolding noise" >&2
  echo "       a fresh Supabase image produces. The target database is now in" >&2
  echo "       an UNKNOWN state: --clean dropped objects before this stopped." >&2
  echo "       Do not put it into service." >&2
  exit 1
fi

echo "[restore-postgres] pg_restore finished in ${ELAPSED}s (exit $RESTORE_RC, ignored errors: $IGNORED)"

FAILED=0

echo "[restore-postgres] sanity counts:"
if ! COUNTS="$(psql "$TARGET" -v ON_ERROR_STOP=1 -At -c "$SANITY_SQL")"; then
  echo "ERROR: the sanity queries did not run against the restored database." >&2
  echo "       A restore that cannot be queried has not succeeded." >&2
  exit 1
fi
if ! evaluate_counts <<< "$COUNTS"; then
  FAILED=1
fi

echo "[restore-postgres] table coverage (dump TOC vs restored database):"
if ! psql "$TARGET" -v ON_ERROR_STOP=1 -At -c "$TABLE_LIST_SQL" |
  LC_ALL=C sort -u > "$WORK_TMP/actual-tables.txt"; then
  echo "  FAIL could not list the tables in the restored database"
  FAILED=1
else
  MISSING="$(LC_ALL=C comm -23 "$WORK_TMP/expected-tables.txt" "$WORK_TMP/actual-tables.txt")"
  if [ -n "$MISSING" ]; then
    MISSING_COUNT="$(printf '%s\n' "$MISSING" | wc -l | tr -d '[:space:]')"
    echo "  FAIL $MISSING_COUNT of $EXPECTED_TABLE_COUNT tables in the dump are absent:"
    printf '%s\n' "$MISSING" | sed 's/^/         /'
    FAILED=1
  else
    echo "  OK   all $EXPECTED_TABLE_COUNT tables in the dump exist in the target"
  fi
fi

if [ -n "${SOURCE_DB_URL:-}" ]; then
  echo "[restore-postgres] source vs restored:"
  if ! compare_counts "$SOURCE_COUNTS" "$COUNTS"; then
    FAILED=1
  fi
else
  echo "[restore-postgres] no SOURCE_DB_URL set, so the counts above were judged"
  echo "                   on their own (queryable, non-empty, every table in"
  echo "                   the dump present). Set SOURCE_DB_URL when a source is"
  echo "                   reachable for a value-for-value check."
fi

echo ""
if [ "$FAILED" = "0" ]; then
  echo "[restore-postgres] PASS - restore verified in ${ELAPSED}s. Record the timing in vault/10-ops/backups.md (drill log)."
else
  echo "[restore-postgres] FAIL - the restored database did not pass verification." >&2
  echo "                   Do NOT put it into service. The lines marked FAIL" >&2
  echo "                   above say what is wrong." >&2
  exit 1
fi
