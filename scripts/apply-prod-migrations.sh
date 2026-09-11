#!/usr/bin/env bash
# US-1108 / US-3395: apply pending migrations to a target Postgres AND record
# each version, so the edge schema-version guard (US-778) never goes stale from
# the apply method.
#
# WHICH TOOL SHOULD YOU BE USING?
# For a hands-on production apply, use `npm run migrate:prod`
# (scripts/migrate-prod.mjs). It reaches the database over ssh, prints the
# pending list before touching anything, takes a pg_dump backup first, and needs
# two deliberate flags. That is the tool the runbook and the migrations skill
# name.
#
# THIS script is the non-interactive path for a host that already holds a direct
# connection string and no ssh: the Coolify pre-deployment command
# (services/edge-functions/COOLIFY.md) and one-off psql-only shells. It has no
# backup step and no confirmation prompt, because a pre-deploy hook cannot
# answer one. Back prod up yourself first (vault/10-ops/backups.md).
#
#   SUPABASE_DB_URL="postgres://...@host:5432/postgres" ./scripts/apply-prod-migrations.sh
#
# WHAT "PENDING" MEANS HERE (US-3395)
# Pending is computed by MEMBERSHIP in public.applied_migrations, identical to
# computePending() in scripts/lib/prod-db.mjs. It used to be computed by
# comparing each filename prefix against the HIGHEST recorded version, which
# skipped every file at or below that maximum, so a hole below it was never
# applied. That is how `listings.draft_id` from 00134 stayed missing in
# production for months while every version above it was recorded
# (US-2726, US-2832). scripts/apply-prod-migrations-gap.test.mjs is the proof
# that a hole below the maximum is now filled.
#
# Re-running is safe: every migration is idempotent and recording uses
# ON CONFLICT DO NOTHING. What re-running does NOT prove is that the objects are
# actually there. A file applied without ON_ERROR_STOP can record its version
# after failing (00611 did, 2026-08-17). scripts/prod-schema-audit.sql answers
# that question, and it is a read.
#
# A FAILED VERSION LOOKUP IS NOT A FRESH DATABASE (US-3395)
# This used to swallow the psql error and fall back to "00000", so a refused
# connection and an empty database looked the same and the script replayed the
# whole directory. Now only a genuinely absent public.applied_migrations counts
# as fresh; every other failure exits non-zero with the reason and applies
# nothing.
#
# Migrations are forward-only.
set -euo pipefail

: "${SUPABASE_DB_URL:?set SUPABASE_DB_URL to the target Postgres connection string}"

# Overridable so the gap test can point this at a small fixture directory
# instead of the real 600+ migrations. Unset in every operator use.
DIR="${MIGRATIONS_DIR:-$(cd "$(dirname "$0")/../supabase/migrations" && pwd)}"
[ -d "$DIR" ] || { echo "[migrate] no migrations directory at $DIR" >&2; exit 1; }

# ---------------------------------------------------------------------------
# version canonicalization
# ---------------------------------------------------------------------------
# Prod records five digits. Three files (000355, 000375, 000385) are NAMED with
# six, and a plain string compare treats those as different migrations, which
# would make them look forever pending. Mirrors canonicalVersion() in
# scripts/lib/prod-db.mjs so the two appliers cannot disagree about what a
# version is.
canon() {
  local v="$1"
  v="${v//[[:space:]]/}"
  case "$v" in
    '' | *[!0-9]*) printf '%s' "$v"; return 0 ;;
  esac
  local n=$((10#$v))
  if [ "${#v}" -gt 5 ] && [ "$n" -gt 99999 ]; then
    printf '%s' "$v"
  else
    printf '%05d' "$n"
  fi
}

# ---------------------------------------------------------------------------
# what the target already records
# ---------------------------------------------------------------------------
# Reads public.applied_migrations, the same tracker migrate-prod.mjs reads.
# Returns non-zero on any failure other than the table genuinely not existing.
read_applied() {
  local out rc
  set +e
  out="$(psql "$SUPABASE_DB_URL" -tAX </dev/null \
    -c "SELECT version FROM public.applied_migrations ORDER BY 1;" 2>&1)"
  rc=$?
  set -e
  if [ "$rc" -ne 0 ]; then
    if printf '%s' "$out" | grep -qiE 'relation "?(public[.])?applied_migrations"? does not exist'; then
      echo "[migrate] public.applied_migrations is absent; treating this database as FRESH." >&2
      printf ''
      return 0
    fi
    echo "[migrate] could not read public.applied_migrations. Refusing to guess whether" >&2
    echo "[migrate] this database is empty or simply unreachable. Nothing was applied." >&2
    printf '%s\n' "$out" >&2
    return 1
  fi
  printf '%s' "$out"
}

if ! applied_raw="$(read_applied)"; then
  exit 1
fi

applied_list=""
applied_count=0
while IFS= read -r v; do
  [ -n "${v//[[:space:]]/}" ] || continue
  applied_list="${applied_list}$(canon "$v")"$'\n'
  applied_count=$((applied_count + 1))
done <<< "$applied_raw"

is_applied() { printf '%s' "$applied_list" | grep -Fxq -- "$1"; }

echo "[migrate] migrations dir: $DIR"
echo "[migrate] recorded on target: $applied_count version(s)"

# ---------------------------------------------------------------------------
# pending, by membership
# ---------------------------------------------------------------------------
# LC_ALL=C so the apply order is byte order, matching the JS .sort() in
# migrate-prod.mjs rather than whatever collation the host happens to have.
files="$(cd "$DIR" && LC_ALL=C ls -1 -- *.sql 2>/dev/null | LC_ALL=C sort || true)"

local_list=""
pending=""
pending_count=0
while IFS= read -r base; do
  [ -n "$base" ] || continue
  version="$(canon "${base%%_*}")"
  local_list="${local_list}${version}"$'\n'
  if is_applied "$version"; then continue; fi
  pending="${pending}${version} ${base}"$'\n'
  pending_count=$((pending_count + 1))
done <<< "$files"

# Versions the target records that no local file accounts for. Usually renamed
# or squashed files. Reported, never acted on.
unknown_count=0
while IFS= read -r v; do
  [ -n "$v" ] || continue
  if printf '%s' "$local_list" | grep -Fxq -- "$v"; then continue; fi
  if [ "$unknown_count" -eq 0 ]; then
    echo "[migrate] recorded on target with no local file (not applied by this script):"
  fi
  echo "[migrate]   $v"
  unknown_count=$((unknown_count + 1))
done <<< "$applied_list"

if [ "$pending_count" -eq 0 ]; then
  echo "[migrate] nothing pending; the target records every local migration."
  echo "[migrate] That is what it RECORDS, not proof each one took effect."
  echo "[migrate] Run scripts/prod-schema-audit.sql to ask whether the objects are there."
  exit 0
fi

echo "[migrate] pending ($pending_count), in apply order:"
printf '%s' "$pending" | while read -r version base; do
  [ -n "$base" ] || continue
  echo "[migrate]   $version  $base"
done

# ---------------------------------------------------------------------------
# apply
# ---------------------------------------------------------------------------
applied=0
while read -r version base; do
  [ -n "$base" ] || continue
  echo "[migrate] applying $base"
  psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 </dev/null -f "$DIR/$base"

  # Record it (idempotent), under the CANONICAL version so this script and
  # migrate-prod.mjs agree on what is recorded. Guarded so files BEFORE 00254,
  # which run before the tracker table exists, do not abort; 00254's seed
  # records those instead.
  psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 </dev/null -c \
    "DO \$\$ BEGIN
       INSERT INTO public.applied_migrations (version) VALUES ('$version')
       ON CONFLICT (version) DO NOTHING;
     EXCEPTION WHEN undefined_table THEN NULL; END \$\$;"
  applied=$((applied + 1))
done <<< "$pending"

final="$(psql "$SUPABASE_DB_URL" -tAX </dev/null \
  -c "SELECT coalesce(max(version), '(none)') FROM public.applied_migrations;" | tr -d '[:space:]')"
echo "[migrate] done. applied $applied file(s); highest recorded version is now: $final"
echo "[migrate] Send NOTIFY pgrst, 'reload schema'; if a table, column or RPC changed."
