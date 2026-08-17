#!/usr/bin/env bash
# Restore the Supabase Storage mirror from the offsite crypt remote (US-2659).
#
# The counterpart to backup-storage.sh, and until now it did not exist. There
# was a backup script, no restore script, no drill and no procedure — so the
# photo mirror had never once been read back. That mirror is every listing
# photo, every grading photo including LABEL shots, and every certificate asset.
#
# Required env:
#   RCLONE_REMOTE      offsite root, same value backup-storage.sh syncs TO
#                      (e.g. r2crypt:gradethread-backups)
# Arguments:
#   $1                 target directory to restore INTO (must be empty or absent
#                      unless RESTORE_ALLOW_NONEMPTY=1)
# Optional env:
#   RESTORE_PREFIX             what to pull (default "storage"). Point it at
#                              "storage-deleted/<ts>" to recover objects that a
#                              sync removed — see PARTIAL vs FULL below.
#   RESTORE_SAMPLE             how many files to checksum-verify (default 25,
#                              0 disables). Never disable it in a drill.
#   RESTORE_ALLOW_NONEMPTY=1   restore into a directory that already has files
#   ALERT_WEBHOOK_URL          POSTed {"text": ...} on failure
#
# ── PARTIAL vs FULL, which are different operations (AC5) ────────────────────
# FULL REBUILD: the storage volume is gone. RESTORE_PREFIX=storage, target is
# the empty STORAGE_DIR on a fresh host. This is the disaster-recovery case and
# the one the drill exercises.
# SINGLE-OBJECT RECOVERY: someone deleted or overwrote a photo and the nightly
# sync propagated it. The old bytes are in storage-deleted/<ts>/ because
# backup-storage.sh passes --backup-dir. Restore that prefix to a SCRATCH
# directory and copy the one path across by hand. Do NOT point this at the live
# STORAGE_DIR for a single object: the sync direction below is remote->local
# over the whole prefix, and using it to fix one file would drag every other
# file back to its backed-up state too.
#
# ── WHY exit 0 IS NOT ENOUGH ─────────────────────────────────────────────────
# rclone returns 0 for a copy that produced zero files, and a crypt remote whose
# password is wrong does not error on LISTING — it yields names that will not
# decrypt. So this script verifies rather than trusting the exit code: it counts
# what arrived, refuses an empty restore, and re-checksums a sample against the
# remote. That last check is the one that proves the crypt password is right,
# because a wrong password produces bytes that hash differently.
#
# ⚠ THE PASSWORD IS THE WHOLE RESTORE. The crypt password + salt live in the
# rclone config; if they are only on the host this backup exists to survive
# losing, every object in the bucket is unreadable ciphertext and this script
# cannot help. See vault/10-ops/key-rotation.md.

set -euo pipefail

TARGET_DIR="${1:-}"
RESTORE_PREFIX="${RESTORE_PREFIX:-storage}"
RESTORE_SAMPLE="${RESTORE_SAMPLE:-25}"

alert() {
  echo "ERROR: $1" >&2
  if [ -n "${ALERT_WEBHOOK_URL:-}" ]; then
    curl -fsS -m 10 -X POST -H 'Content-Type: application/json' \
      -d "{\"text\":\"[gradethread restore-storage] $1\"}" \
      "$ALERT_WEBHOOK_URL" >/dev/null || true
  fi
}
trap 'alert "storage restore failed at line $LINENO"' ERR

: "${RCLONE_REMOTE:?RCLONE_REMOTE is required (e.g. r2crypt:gradethread-backups)}"
if [ -z "$TARGET_DIR" ]; then
  echo "usage: restore-storage.sh <target-dir>   (RCLONE_REMOTE must be set)" >&2
  exit 2
fi

if [ -d "$TARGET_DIR" ] && [ -n "$(ls -A "$TARGET_DIR" 2>/dev/null)" ] \
   && [ "${RESTORE_ALLOW_NONEMPTY:-}" != "1" ]; then
  alert "target $TARGET_DIR is not empty — restoring over live files can mix two generations of the mirror. Set RESTORE_ALLOW_NONEMPTY=1 if that is genuinely what you want."
  exit 1
fi
mkdir -p "$TARGET_DIR"

# Same crypt check as the backup side, for the same reason: a remote NAMED
# r2crypt that is not of type crypt would otherwise read as safe. Here it also
# tells you early that you are pointed at the wrong remote, before a long pull.
REMOTE_NAME="${RCLONE_REMOTE%%:*}"
REMOTE_TYPE="$(rclone config show "$REMOTE_NAME" 2>/dev/null | sed -n 's/^type[[:space:]]*=[[:space:]]*//p' | head -1)"
if [ "$REMOTE_TYPE" != "crypt" ] && [ "${RESTORE_ALLOW_PLAINTEXT:-}" != "1" ]; then
  alert "remote '$REMOTE_NAME' is type '${REMOTE_TYPE:-unknown}', not 'crypt'. backup-storage.sh refuses to write anywhere but a crypt remote, so a non-crypt source here means you are restoring from the wrong place. Set RESTORE_ALLOW_PLAINTEXT=1 only if you know the mirror really is plaintext."
  exit 1
fi

SRC="$RCLONE_REMOTE/$RESTORE_PREFIX"
echo "[restore-storage] pulling $SRC -> $TARGET_DIR"
rclone copy "$SRC" "$TARGET_DIR" \
  --transfers 8 --stats-one-line --stats 30s

RESTORED="$(find "$TARGET_DIR" -type f | wc -l | tr -d ' ')"
echo "[restore-storage] restored $RESTORED file(s)"
if [ "$RESTORED" -eq 0 ]; then
  alert "restore produced ZERO files from $SRC. rclone exits 0 on an empty copy, so this is the check that catches a wrong prefix, an empty bucket, or a remote pointing somewhere unexpected."
  exit 1
fi

# The verification that actually proves the crypt password: compare content, not
# counts. `rclone check --download` re-reads both sides and compares bytes, so a
# password that lists names but decrypts to garbage fails here rather than
# looking like a clean restore.
if [ "$RESTORE_SAMPLE" -gt 0 ]; then
  echo "[restore-storage] verifying up to $RESTORE_SAMPLE file(s) against the remote"
  SAMPLE_DIR="$(mktemp -d)"
  # shellcheck disable=SC2064
  trap "rm -rf '$SAMPLE_DIR'" EXIT
  find "$TARGET_DIR" -type f | head -n "$RESTORE_SAMPLE" \
    | sed "s#^$TARGET_DIR/##" > "$SAMPLE_DIR/files.txt"
  rclone check "$TARGET_DIR" "$SRC" \
    --files-from "$SAMPLE_DIR/files.txt" --download --one-way
  echo "[restore-storage] sample verified byte-for-byte"
else
  echo "[restore-storage] WARNING: RESTORE_SAMPLE=0 — nothing was verified, only counted"
fi

echo "[restore-storage] done: $RESTORED file(s) in $TARGET_DIR"
