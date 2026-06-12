#!/usr/bin/env bash
# Daily Supabase Storage backup for the self-hosted instance (US-494).
#
# Runs ON THE HOST that holds the storage volume. Mirrors the storage backend
# (the `submission-images` and `item-photos` buckets live under it) to an
# offsite, cross-region bucket. Deletions/overwrites are kept for rollback in
# a dated `storage-deleted/<ts>/` prefix instead of being lost on sync.
#
# Required env:
#   RCLONE_REMOTE        offsite root, e.g. r2:gradethread-backups
# Optional env:
#   STORAGE_DIR          storage file backend dir (default /var/lib/supabase/storage)
#   ALERT_WEBHOOK_URL    POSTed {"text": ...} on failure
#
# Old `storage-deleted/` prefixes age out via the same 30-day bucket lifecycle
# rule as Postgres dumps — see BACKUPS.md.

set -euo pipefail

STORAGE_DIR="${STORAGE_DIR:-/var/lib/supabase/storage}"
TS="$(date -u +%Y%m%dT%H%M%SZ)"

alert() {
  echo "ERROR: $1" >&2
  if [ -n "${ALERT_WEBHOOK_URL:-}" ]; then
    curl -fsS -m 10 -X POST -H 'Content-Type: application/json' \
      -d "{\"text\":\"[gradethread backup-storage] $1\"}" \
      "$ALERT_WEBHOOK_URL" >/dev/null || true
  fi
}
trap 'alert "storage backup failed at line $LINENO (ts $TS)"' ERR

: "${RCLONE_REMOTE:?RCLONE_REMOTE is required (e.g. r2:gradethread-backups)}"
[ -d "$STORAGE_DIR" ] || { alert "STORAGE_DIR $STORAGE_DIR does not exist"; exit 1; }

echo "[backup-storage] syncing $STORAGE_DIR -> $RCLONE_REMOTE/storage"
rclone sync "$STORAGE_DIR" "$RCLONE_REMOTE/storage" \
  --backup-dir "$RCLONE_REMOTE/storage-deleted/$TS" \
  --transfers 8 --stats-one-line --stats 30s
echo "[backup-storage] done"
