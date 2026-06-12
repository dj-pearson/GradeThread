#!/usr/bin/env bash
# Nightly Postgres base backup for the self-hosted Supabase instance (US-494).
#
# Runs ON THE DB HOST (cron or Coolify scheduled task on the host — NOT inside
# the edge container). Produces a pg_dump custom-format archive, verifies it is
# readable, ships it offsite via rclone, and prunes local copies.
#
# Required env:
#   SUPABASE_DB_URL      postgres://... superuser/owner connection string
# Optional env:
#   BACKUP_DIR           local staging dir            (default /backups/pg)
#   RCLONE_REMOTE        offsite target, e.g. r2:gradethread-backups/pg
#                        (unset = local-only; the cron MUST set this in prod)
#   LOCAL_RETENTION_DAYS days to keep local copies    (default 7)
#   ALERT_WEBHOOK_URL    POSTed {"text": ...} on failure (Slack/Discord-style)
#
# Offsite retention (30 days) is enforced by a lifecycle rule on the bucket —
# see BACKUPS.md. Restore with scripts/ops/restore-postgres.sh.

set -euo pipefail

BACKUP_DIR="${BACKUP_DIR:-/backups/pg}"
LOCAL_RETENTION_DAYS="${LOCAL_RETENTION_DAYS:-7}"
TS="$(date -u +%Y%m%dT%H%M%SZ)"
DUMP="$BACKUP_DIR/gradethread-$TS.dump"

alert() {
  echo "ERROR: $1" >&2
  if [ -n "${ALERT_WEBHOOK_URL:-}" ]; then
    curl -fsS -m 10 -X POST -H 'Content-Type: application/json' \
      -d "{\"text\":\"[gradethread backup-postgres] $1\"}" \
      "$ALERT_WEBHOOK_URL" >/dev/null || true
  fi
}
trap 'alert "backup failed at line $LINENO (ts $TS)"' ERR

: "${SUPABASE_DB_URL:?SUPABASE_DB_URL is required}"
mkdir -p "$BACKUP_DIR"

echo "[backup-postgres] dumping to $DUMP"
pg_dump --format=custom --compress=6 --no-owner \
  --dbname="$SUPABASE_DB_URL" --file="$DUMP"

# A dump pg_restore cannot list is not a backup.
pg_restore --list "$DUMP" >/dev/null
sha256sum "$DUMP" > "$DUMP.sha256"
echo "[backup-postgres] ok: $(du -h "$DUMP" | cut -f1)"

if [ -n "${RCLONE_REMOTE:-}" ]; then
  echo "[backup-postgres] shipping offsite to $RCLONE_REMOTE"
  rclone copy "$DUMP" "$RCLONE_REMOTE/" --no-traverse
  rclone copy "$DUMP.sha256" "$RCLONE_REMOTE/" --no-traverse
else
  alert "RCLONE_REMOTE unset — backup $TS is LOCAL ONLY (no offsite copy)"
fi

find "$BACKUP_DIR" -name 'gradethread-*.dump*' -mtime "+$LOCAL_RETENTION_DAYS" -delete
echo "[backup-postgres] done (local retention ${LOCAL_RETENTION_DAYS}d)"
