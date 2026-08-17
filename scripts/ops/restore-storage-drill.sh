#!/usr/bin/env bash
# Automated storage backup → restore drill (US-2659).
#
# The counterpart to restore-drill.sh, which proves the Postgres procedure. The
# storage half had no equivalent, so the photo mirror had never been read back
# even once. This proves the whole path end-to-end WITHOUT TOUCHING PRODUCTION
# and without needing an R2 credential:
#
#   1. build a fake storage volume of known files (content chosen so hashes differ)
#   2. define an EPHEMERAL rclone crypt remote over a local directory, in a
#      throwaway rclone config — the real config is never read or written
#   3. sync to it with backup-storage.sh's own flags, including --backup-dir
#   4. restore it back into a fresh directory with restore-storage.sh
#   5. compare file COUNT and every file's SHA-256 against the originals
#   6. delete a file from the source, re-sync, and prove the old bytes are
#      recoverable from storage-deleted/<ts>/ — the partial-restore case, which
#      is a different operation from a full rebuild (AC5)
#
# STEP 2 IS THE POINT AND IS NOT OPTIONAL. The mirror is a crypt remote, and
# "the backup is encrypted with a password nobody can produce" is the actual
# risk here — a drill that synced plaintext would be measuring a procedure prod
# does not use. The ephemeral password proves the ROUND TRIP works; it says
# nothing about whether the real password is stored anywhere survivable, which
# is an operator question and stays open (AC3/AC6).
#
# Run from the repo root. Needs rclone (scoop install rclone) and nothing else —
# no Docker, no network, no credentials:
#   bash scripts/ops/restore-storage-drill.sh
#
# Optional env:
#   KEEP=1   keep the work directory for inspection

set -euo pipefail

WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/gradethread-storage-drill.XXXXXX")"
SOURCE_DIR="$WORK_DIR/source"
REMOTE_DIR="$WORK_DIR/remote"
RESTORE_DIR="$WORK_DIR/restored"
RCLONE_CONFIG="$WORK_DIR/rclone.conf"
export RCLONE_CONFIG
FAILURES=0

cleanup() {
  if [ "${KEEP:-}" = "1" ]; then
    echo "[drill] KEEP=1 — work dir left at $WORK_DIR"
  else
    rm -rf "$WORK_DIR"
  fi
}
trap cleanup EXIT

step() { echo; echo "── $1"; }
ok()   { echo "  PASS  $1"; }
bad()  { echo "  FAIL  $1"; FAILURES=$((FAILURES + 1)); }

# ── 1. a fake storage volume ────────────────────────────────────────────────
step "1. building a source volume"
mkdir -p "$SOURCE_DIR/submission-images/user-a" "$SOURCE_DIR/item-photos/user-b"
for i in 1 2 3 4 5; do
  printf 'submission image %s — label photo bytes\n' "$i" \
    > "$SOURCE_DIR/submission-images/user-a/label_$i.jpg"
done
for i in 1 2 3; do
  printf 'listing photo %s\n' "$i" > "$SOURCE_DIR/item-photos/user-b/front_$i.jpg"
done
SOURCE_COUNT="$(find "$SOURCE_DIR" -type f | wc -l | tr -d ' ')"
echo "  $SOURCE_COUNT file(s)"

# ── 2. an ephemeral crypt remote over a local directory ─────────────────────
step "2. defining an ephemeral crypt remote (throwaway config)"
mkdir -p "$REMOTE_DIR"
rclone config create drillbase local >/dev/null
# obscure: rclone stores passwords obscured, and config create expects that form.
CRYPT_PASS="$(rclone obscure "drill-$(date -u +%s)-$$")"
CRYPT_SALT="$(rclone obscure "drill-salt-$$")"
rclone config create drillcrypt crypt \
  remote "drillbase:$REMOTE_DIR" \
  password "$CRYPT_PASS" \
  password2 "$CRYPT_SALT" >/dev/null
REMOTE_TYPE="$(rclone config show drillcrypt | sed -n 's/^type[[:space:]]*=[[:space:]]*//p' | head -1)"
if [ "$REMOTE_TYPE" = "crypt" ]; then
  ok "remote is type crypt (what backup-storage.sh requires)"
else
  bad "remote type is '$REMOTE_TYPE', expected crypt"
fi

# ── 3. back up, using the real script ───────────────────────────────────────
step "3. backup-storage.sh -> crypt remote"
STORAGE_DIR="$SOURCE_DIR" RCLONE_REMOTE="drillcrypt:" \
  bash scripts/ops/backup-storage.sh
# The bytes on "disk" must NOT be readable. This is what distinguishes a crypt
# remote from a plain one, and it is the claim vault/10-ops/backups.md makes.
if grep -rqs "label photo bytes" "$REMOTE_DIR"; then
  bad "plaintext found in the remote directory — the mirror is NOT encrypted"
else
  ok "no plaintext in the remote directory"
fi

# ── 4. restore, using the real script ───────────────────────────────────────
step "4. restore-storage.sh -> fresh directory"
RCLONE_REMOTE="drillcrypt:" bash scripts/ops/restore-storage.sh "$RESTORE_DIR"

# ── 5. count and content ────────────────────────────────────────────────────
step "5. comparing counts and hashes"
RESTORED_COUNT="$(find "$RESTORE_DIR" -type f | wc -l | tr -d ' ')"
if [ "$RESTORED_COUNT" = "$SOURCE_COUNT" ]; then
  ok "file count matches ($RESTORED_COUNT)"
else
  bad "file count $RESTORED_COUNT != source $SOURCE_COUNT"
fi

MISMATCH=0
while IFS= read -r rel; do
  a="$(sha256sum < "$SOURCE_DIR/$rel" | cut -d' ' -f1)"
  if [ ! -f "$RESTORE_DIR/$rel" ]; then
    echo "    missing: $rel"; MISMATCH=$((MISMATCH + 1)); continue
  fi
  b="$(sha256sum < "$RESTORE_DIR/$rel" | cut -d' ' -f1)"
  [ "$a" = "$b" ] || { echo "    differs: $rel"; MISMATCH=$((MISMATCH + 1)); }
done < <(cd "$SOURCE_DIR" && find . -type f | sed 's#^\./##')
if [ "$MISMATCH" -eq 0 ]; then
  ok "every file round-tripped byte-for-byte through the crypt remote"
else
  bad "$MISMATCH file(s) missing or altered"
fi

# ── 6. the partial case: recover one deleted object ─────────────────────────
step "6. single-object recovery from storage-deleted/"
VICTIM="submission-images/user-a/label_3.jpg"
VICTIM_HASH="$(sha256sum < "$SOURCE_DIR/$VICTIM" | cut -d' ' -f1)"
rm "$SOURCE_DIR/$VICTIM"
STORAGE_DIR="$SOURCE_DIR" RCLONE_REMOTE="drillcrypt:" \
  bash scripts/ops/backup-storage.sh >/dev/null
# The sync has now propagated the deletion, which is exactly the accident this
# prefix exists for. Find the dated prefix and pull it to a SCRATCH dir.
DELETED_TS="$(rclone lsf drillcrypt:storage-deleted --dirs-only 2>/dev/null | head -1 | tr -d '/')"
if [ -z "$DELETED_TS" ]; then
  bad "no storage-deleted/<ts>/ prefix was created — --backup-dir is not working"
else
  SCRATCH="$WORK_DIR/scratch"
  RCLONE_REMOTE="drillcrypt:" RESTORE_PREFIX="storage-deleted/$DELETED_TS" \
    bash scripts/ops/restore-storage.sh "$SCRATCH" >/dev/null
  if [ -f "$SCRATCH/$VICTIM" ] \
     && [ "$(sha256sum < "$SCRATCH/$VICTIM" | cut -d' ' -f1)" = "$VICTIM_HASH" ]; then
    ok "deleted object recovered intact from storage-deleted/$DELETED_TS"
  else
    bad "deleted object was NOT recoverable from storage-deleted/$DELETED_TS"
  fi
fi

# ── result ──────────────────────────────────────────────────────────────────
echo
if [ "$FAILURES" -eq 0 ]; then
  echo "STORAGE RESTORE DRILL: PASS"
  echo
  echo "What this did NOT prove, and it is the serious half: whether the REAL"
  echo "crypt password and salt exist anywhere other than the host this backup"
  echo "exists to survive losing. See vault/10-ops/key-rotation.md (US-2659)."
else
  echo "STORAGE RESTORE DRILL: FAIL ($FAILURES check(s))"
  exit 1
fi
