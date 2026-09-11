#!/usr/bin/env bash
# Restore the Supabase Storage mirror from the offsite crypt remote (US-2659).
#
# The counterpart to backup-storage.sh, and until this existed there was a
# backup script and nothing else: no restore script, no drill, no procedure. The
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
#                              sync removed. See PARTIAL vs FULL below.
#   RESTORE_SAMPLE             how many files to byte-verify (default 25,
#                              0 disables). Never disable it in a drill.
#   RESTORE_ALLOW_NONEMPTY=1   restore into a directory that already has files
#   RESTORE_ALLOW_PLAINTEXT=1  accept a source remote that is not type crypt
#   ALERT_WEBHOOK_URL          POSTed {"text": ...} on failure
#
# --- PARTIAL vs FULL, which are different operations (AC5) ------------------
# FULL REBUILD: the storage volume is gone. RESTORE_PREFIX=storage, target is
# the empty STORAGE_DIR on a fresh host. This is the disaster-recovery case and
# the one the drill exercises. It is the DEFAULT, and it is only safe as a
# default because of the non-empty-target refusal below: pointed at a live
# volume it would otherwise pull the whole prefix over the top of it.
# SINGLE-OBJECT RECOVERY: someone deleted or overwrote a photo and the nightly
# sync propagated it. The old bytes are in storage-deleted/<ts>/ because
# backup-storage.sh passes --backup-dir. Restore that prefix to a SCRATCH
# directory and copy the one path across by hand. Do NOT point this at the live
# STORAGE_DIR for a single object: the copy below is remote->local over the
# WHOLE prefix, so using it to fix one file would drag every other file back to
# its backed-up state too.
#
# --- WHY exit 0 IS NOT ENOUGH, measured rather than assumed -----------------
# Every refusal below was made to fire on 2026-09-11 against a local crypt
# remote, and the observed output is in vault/10-ops/backups.md so nobody has to
# trust the prose.
#
# CORRECTED 2026-09-11: this header used to say a wrong crypt password "does not
# error on listing, it yields names that will not decrypt", and that the sample
# check is what proves the password. Both are false. rclone crypt is
# authenticated, so a wrong password fails the transfer loudly either way:
#   filename_encryption=standard -> "error reading source root directory:
#                                    directory not found", rclone exit 3
#   filename_encryption=off      -> "failed to authenticate decrypted block -
#                                    bad password?", rclone exit 3
# rclone itself catches the lost-key case. What it does NOT catch, and what the
# sample check is actually for, is a file ALREADY IN THE TARGET with the same
# name, size and modtime: rclone copy skips it, this script reports
# "restored N file(s)", and the bytes are wrong. Reproduced with a 10-byte
# impostor; only "rclone check --download" saw it ("a.jpg: contents differ"),
# and the restore then exited 1. That is precisely the case
# RESTORE_ALLOW_NONEMPTY=1 opens up, which is why the sample check and the
# non-empty refusal are a pair and neither should be turned off alone.
#
# The zero-file refusal covers the other half: rclone returns 0 for a copy that
# produced nothing, so an EXISTING BUT EMPTY prefix would read as a clean
# restore. (A prefix that does not exist at all errors inside rclone first,
# exit 3 - also a stop, just not this one's.)
#
# WARNING: THE PASSWORD IS THE WHOLE RESTORE. The crypt password and salt live
# in the rclone config; if they are only on the host this backup exists to
# survive losing, every object in the bucket is unreadable ciphertext and this
# script cannot help. See vault/10-ops/key-rotation.md.

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
  alert "target $TARGET_DIR is not empty. Restoring over live files can mix two generations of the mirror, and rclone SKIPS any same-name same-size file already sitting there rather than overwriting it. Set RESTORE_ALLOW_NONEMPTY=1 if that is genuinely what you want, and leave RESTORE_SAMPLE alone when you do - the sample check is the only thing that catches a skipped file."
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

# Compare CONTENT, not counts. "rclone check --download" re-reads both sides and
# compares bytes, which is the only thing that catches a file rclone decided it
# did not need to transfer. See the measured note in the header.
if [ "$RESTORE_SAMPLE" -gt 0 ]; then
  echo "[restore-storage] verifying up to $RESTORE_SAMPLE file(s) against the remote"
  SAMPLE_DIR="$(mktemp -d)"
  # shellcheck disable=SC2064
  trap "rm -rf '$SAMPLE_DIR'" EXIT
  find "$TARGET_DIR" -type f | head -n "$RESTORE_SAMPLE" \
    | sed "s#^$TARGET_DIR/##" > "$SAMPLE_DIR/files.txt"
  SAMPLE_COUNT="$(grep -c . "$SAMPLE_DIR/files.txt" || true)"
  # Zero files checked is zero differences found, which prints like a pass. The
  # list is built by find+sed, so a path the sed did not strip, or a file that
  # vanished between the copy and here, empties it without erroring.
  if [ "${SAMPLE_COUNT:-0}" -eq 0 ]; then
    alert "built an EMPTY verification list from $RESTORED restored file(s). Nothing would have been compared, and rclone check reports an empty comparison as zero differences, so this run would have printed success."
    exit 1
  fi
  rclone check "$TARGET_DIR" "$SRC" \
    --files-from "$SAMPLE_DIR/files.txt" --download --one-way
  echo "[restore-storage] $SAMPLE_COUNT file(s) verified byte-for-byte"
else
  echo "[restore-storage] WARNING: RESTORE_SAMPLE=0 - nothing was verified, only counted"
fi

echo "[restore-storage] done: $RESTORED file(s) in $TARGET_DIR"
