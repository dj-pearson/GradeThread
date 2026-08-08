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
#   STORAGE_BACKUP_ALLOW_PLAINTEXT=1  bypass the crypt-remote requirement below
#
# Encryption (US-2416 AC3). This mirror contains every submission image —
# including grading LABEL photos, which carry brand, size and often a name or
# order slip. An rclone sync to a plain bucket hands all of that to anyone
# holding the R2 credential.
#
# The postgres backup encrypts its own artifact with age. That does not fit
# here: this is an incremental sync of thousands of files where rclone must
# still be able to diff, and pre-encrypting each file per run would break that.
# So the mechanism is rclone's own CRYPT REMOTE, which encrypts client-side,
# per object, before upload and keeps sync working. It is a config-side fix,
# not a script-side one — so what this script can do is REFUSE to run against a
# remote that is not encrypted, which is what it now does. Setup is in
# vault/10-ops/backups.md.
#
# Old `storage-deleted/` prefixes age out via the same 30-day bucket lifecycle
# rule as Postgres dumps — see vault/10-ops/backups.md.

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

# US-2416 AC3: refuse to mirror garment photos to an unencrypted remote.
# Checked against rclone's own config rather than the remote's NAME, because a
# remote called "r2crypt" that is not actually of type crypt would otherwise
# read as safe.
REMOTE_NAME="${RCLONE_REMOTE%%:*}"
REMOTE_TYPE="$(rclone config show "$REMOTE_NAME" 2>/dev/null | sed -n 's/^type[[:space:]]*=[[:space:]]*//p' | head -1)"
if [ "$REMOTE_TYPE" != "crypt" ] && [ "${STORAGE_BACKUP_ALLOW_PLAINTEXT:-}" != "1" ]; then
  alert "remote '$REMOTE_NAME' is type '${REMOTE_TYPE:-unknown}', not 'crypt' — refusing to sync submission images (incl. label photos) to an unencrypted bucket. Configure an rclone crypt remote (vault/10-ops/backups.md) or set STORAGE_BACKUP_ALLOW_PLAINTEXT=1 to accept the risk deliberately."
  exit 1
fi
if [ "$REMOTE_TYPE" != "crypt" ]; then
  echo "[backup-storage] WARNING: STORAGE_BACKUP_ALLOW_PLAINTEXT=1 — syncing UNENCRYPTED to '$REMOTE_NAME'"
fi

echo "[backup-storage] syncing $STORAGE_DIR -> $RCLONE_REMOTE/storage"
rclone sync "$STORAGE_DIR" "$RCLONE_REMOTE/storage" \
  --backup-dir "$RCLONE_REMOTE/storage-deleted/$TS" \
  --transfers 8 --stats-one-line --stats 30s
echo "[backup-storage] done"
