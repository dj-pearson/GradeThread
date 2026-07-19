#!/usr/bin/env bash
# Automated backup → restore drill (US-494).
#
# Proves the backup/restore procedure end-to-end without touching production:
#   1. pg_dump the SOURCE database (default: the local `supabase db start`
#      stack) using the same custom format as backup-postgres.sh
#   2. boot a FRESH scratch Postgres container from the same Supabase image
#   3. pg_restore the dump into it (same flags as restore-postgres.sh)
#   4. compare row counts + latest migration between source and restored copy
#   5. report PASS/FAIL and the observed restore time (informs RTO)
#
# Run it from the repo root with Docker up and `supabase db start` running:
#   bash scripts/ops/restore-drill.sh
#
# Optional env:
#   SOURCE_CONTAINER  source Postgres container (default supabase_db_gradethread)
#   PGPASSWORD        supabase_admin password in both containers (default postgres,
#                     which is what the supabase CLI stack uses)
#   KEEP=1            keep the scratch container + dump for inspection
#
# For a PROD drill: copy the latest offsite dump to a scratch host and run
# scripts/ops/restore-postgres.sh against a fresh Supabase Postgres container
# there — the steps below are exactly that procedure, automated.

set -euo pipefail

SOURCE_CONTAINER="${SOURCE_CONTAINER:-supabase_db_gradethread}"
PGPASSWORD="${PGPASSWORD:-postgres}"
SCRATCH_CONTAINER="gradethread-restore-drill"
TS="$(date -u +%Y%m%dT%H%M%SZ)"
DUMP_NAME="drill-$TS.dump"
WORK_DIR="${TMPDIR:-/tmp}/gradethread-drill"
mkdir -p "$WORK_DIR"

SANITY_SQL="
select coalesce(max(version),'<none>') from supabase_migrations.schema_migrations;
select count(*) from public.users;
select count(*) from public.submissions;
select count(*) from public.grade_reports;
select count(*) from public.inventory_items;
select count(*) from storage.objects;
select count(*) from pg_policies;
"

cleanup() {
  if [ "${KEEP:-}" != "1" ]; then
    docker rm -f "$SCRATCH_CONTAINER" >/dev/null 2>&1 || true
    rm -f "$WORK_DIR/$DUMP_NAME"
  else
    echo "[drill] KEEP=1 — scratch container '$SCRATCH_CONTAINER' and $WORK_DIR/$DUMP_NAME left in place"
  fi
}
trap cleanup EXIT

docker inspect "$SOURCE_CONTAINER" >/dev/null 2>&1 || {
  echo "ERROR: source container '$SOURCE_CONTAINER' not running — start it with 'supabase db start'" >&2
  exit 1
}
IMAGE="$(docker inspect --format '{{.Config.Image}}' "$SOURCE_CONTAINER")"
echo "[drill] source=$SOURCE_CONTAINER image=$IMAGE"

echo "[drill] capturing source sanity counts"
SRC_COUNTS="$(docker exec -e PGPASSWORD="$PGPASSWORD" "$SOURCE_CONTAINER" psql -U supabase_admin -d postgres -At -c "$SANITY_SQL")"

echo "[drill] 1/4 pg_dump (custom format, as backup-postgres.sh does)"
T0=$(date +%s)
# Streamed over stdout (not --file) so no container paths are involved —
# Git-for-Windows would rewrite a /tmp argument into a Windows path.
docker exec -e PGPASSWORD="$PGPASSWORD" "$SOURCE_CONTAINER" pg_dump -U supabase_admin -d postgres \
  --format=custom --compress=6 --no-owner > "$WORK_DIR/$DUMP_NAME"
T_DUMP=$(( $(date +%s) - T0 ))
echo "[drill] dump ok: $(du -h "$WORK_DIR/$DUMP_NAME" | cut -f1) in ${T_DUMP}s"

echo "[drill] 2/4 booting fresh scratch container from $IMAGE"
docker rm -f "$SCRATCH_CONTAINER" >/dev/null 2>&1 || true
docker run -d --name "$SCRATCH_CONTAINER" \
  -e POSTGRES_PASSWORD="$PGPASSWORD" -e JWT_SECRET=drill-only-not-a-real-secret \
  "$IMAGE" >/dev/null
for i in $(seq 1 60); do
  if docker exec "$SCRATCH_CONTAINER" pg_isready -U supabase_admin -d postgres >/dev/null 2>&1; then
    break
  fi
  [ "$i" = 60 ] && { echo "ERROR: scratch Postgres never became ready" >&2; exit 1; }
  sleep 2
done
# The image's init scripts keep configuring roles briefly after pg_isready.
sleep 5

echo "[drill] 3/4 pg_restore into scratch (flags match restore-postgres.sh)"
T0=$(date +%s)
docker exec -i -e PGPASSWORD="$PGPASSWORD" "$SCRATCH_CONTAINER" pg_restore -U supabase_admin -d postgres \
  --no-owner --no-privileges --clean --if-exists < "$WORK_DIR/$DUMP_NAME" || true
T_RESTORE=$(( $(date +%s) - T0 ))
echo "[drill] pg_restore finished in ${T_RESTORE}s (\"errors ignored\" for pre-existing scaffolding are expected)"

echo "[drill] 4/4 verifying restored copy against source"
DST_COUNTS="$(docker exec -e PGPASSWORD="$PGPASSWORD" "$SCRATCH_CONTAINER" psql -U supabase_admin -d postgres -At -c "$SANITY_SQL")"

LABELS="latest_migration users submissions grade_reports inventory_items storage.objects rls_policies"
FAIL=0
i=1
for label in $LABELS; do
  src="$(echo "$SRC_COUNTS" | sed -n "${i}p")"
  dst="$(echo "$DST_COUNTS" | sed -n "${i}p")"
  if [ "$src" = "$dst" ]; then
    echo "  OK   $label: $src"
  else
    echo "  FAIL $label: source=$src restored=$dst"
    FAIL=1
  fi
  i=$((i+1))
done

echo
if [ "$FAIL" = "0" ]; then
  echo "[drill] PASS — dump ${T_DUMP}s, restore ${T_RESTORE}s. Record this run in vault/10-ops/backups.md (drill log) and vault/10-ops/launch-checklist.md §5."
else
  echo "[drill] FAIL — restored copy does not match source. Do NOT trust backups until this passes." >&2
  exit 1
fi
