#!/usr/bin/env bash
# Automated storage backup -> restore drill (US-2659).
#
# The counterpart to restore-drill.sh, which proves the Postgres procedure. The
# storage half had no equivalent, so the photo mirror had never been read back
# even once. This proves the whole path end-to-end WITHOUT TOUCHING PRODUCTION
# and without needing an R2 credential:
#
#   1. build a fake storage volume of known files (content chosen so hashes differ)
#   2. define an EPHEMERAL rclone crypt remote over a local directory, in a
#      throwaway rclone config: the real config is never read or written
#   3. sync to it with backup-storage.sh's own flags, including --backup-dir
#   4. restore it back into a fresh directory with restore-storage.sh
#   5. compare file COUNT and every file's SHA-256 against the originals
#   6. delete a file from the source, re-sync, and prove the old bytes are
#      recoverable from storage-deleted/<ts>/. That is the partial-restore case,
#      a different operation from a full rebuild (AC5)
#   7. put an impostor of the same name and size in a target and prove the
#      restore refuses it, because rclone copy will SKIP it
#
# STEP 2 IS THE POINT AND IS NOT OPTIONAL. The mirror is a crypt remote, and
# "the backup is encrypted with a password nobody can produce" is the actual
# risk here. A drill that synced plaintext would be measuring a procedure prod
# does not use. The ephemeral password proves the ROUND TRIP works; it says
# nothing about whether the real password is stored anywhere survivable, which
# is an operator question and stays open (AC3/AC6).
#
# EVERY COMPARISON COUNTS WHAT IT COMPARED. Zero files compared is zero
# mismatches found, which prints exactly like a clean pass, and that is the
# failure this repo keeps finding in its own guards. So step 1 refuses an empty
# source volume and step 5 fails unless it compared every source file.
#
# Run from the repo root. Needs rclone (scoop install rclone) and nothing else:
# no Docker, no network, no credentials.
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
    echo "[drill] KEEP=1: work dir left at $WORK_DIR"
  else
    rm -rf "$WORK_DIR"
  fi
}
trap cleanup EXIT

step() { echo; echo "--- $1"; }
ok()   { echo "  PASS  $1"; }
bad()  { echo "  FAIL  $1"; FAILURES=$((FAILURES + 1)); }

# --- 1. a fake storage volume -----------------------------------------------
step "1. building a source volume"
mkdir -p "$SOURCE_DIR/submission-images/user-a" "$SOURCE_DIR/item-photos/user-b"
for i in 1 2 3 4 5; do
  printf 'submission image %s - label photo bytes\n' "$i" \
    > "$SOURCE_DIR/submission-images/user-a/label_$i.jpg"
done
for i in 1 2 3; do
  printf 'listing photo %s\n' "$i" > "$SOURCE_DIR/item-photos/user-b/front_$i.jpg"
done
SOURCE_COUNT="$(find "$SOURCE_DIR" -type f | wc -l | tr -d ' ')"
echo "  $SOURCE_COUNT file(s)"
# A drill over an empty volume passes every check below without comparing
# anything. Stop here rather than report that as a green run.
if [ "$SOURCE_COUNT" -lt 8 ]; then
  echo "  FAIL  source volume has $SOURCE_COUNT file(s), expected 8 - the drill would have proved nothing"
  exit 1
fi

# --- 2. an ephemeral crypt remote over a local directory --------------------
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

# --- 3. back up, using the real script --------------------------------------
step "3. backup-storage.sh -> crypt remote"
STORAGE_DIR="$SOURCE_DIR" RCLONE_REMOTE="drillcrypt:" \
  bash scripts/ops/backup-storage.sh
# The bytes on "disk" must NOT be readable. This is what distinguishes a crypt
# remote from a plain one, and it is the claim vault/10-ops/backups.md makes.
if grep -rqs "label photo bytes" "$REMOTE_DIR"; then
  bad "plaintext found in the remote directory - the mirror is NOT encrypted"
else
  ok "no plaintext in the remote directory"
fi

# --- 4. restore, using the real script --------------------------------------
step "4. restore-storage.sh -> fresh directory"
RCLONE_REMOTE="drillcrypt:" bash scripts/ops/restore-storage.sh "$RESTORE_DIR"

# --- 5. count and content ---------------------------------------------------
step "5. comparing counts and hashes"
RESTORED_COUNT="$(find "$RESTORE_DIR" -type f | wc -l | tr -d ' ')"
if [ "$RESTORED_COUNT" = "$SOURCE_COUNT" ]; then
  ok "file count matches ($RESTORED_COUNT)"
else
  bad "file count $RESTORED_COUNT != source $SOURCE_COUNT"
fi

MISMATCH=0
COMPARED=0
while IFS= read -r rel; do
  a="$(sha256sum < "$SOURCE_DIR/$rel" | cut -d' ' -f1)"
  COMPARED=$((COMPARED + 1))
  if [ ! -f "$RESTORE_DIR/$rel" ]; then
    echo "    missing: $rel"; MISMATCH=$((MISMATCH + 1)); continue
  fi
  b="$(sha256sum < "$RESTORE_DIR/$rel" | cut -d' ' -f1)"
  [ "$a" = "$b" ] || { echo "    differs: $rel"; MISMATCH=$((MISMATCH + 1)); }
done < <(cd "$SOURCE_DIR" && find . -type f | sed 's#^\./##')
# A loop that iterated zero times reports zero mismatches, which reads as a
# pass. Assert the work happened before believing the result.
if [ "$COMPARED" -ne "$SOURCE_COUNT" ]; then
  bad "compared $COMPARED file(s) but the source has $SOURCE_COUNT - the comparison itself did not run over everything"
elif [ "$MISMATCH" -eq 0 ]; then
  ok "all $COMPARED file(s) round-tripped byte-for-byte through the crypt remote"
else
  bad "$MISMATCH of $COMPARED file(s) missing or altered"
fi

# --- 6. the partial case: recover one deleted object ------------------------
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
  bad "no storage-deleted/<ts>/ prefix was created - --backup-dir is not working"
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

# --- 7. the case rclone does not catch on its own ---------------------------
# A wrong crypt password fails inside rclone, loudly, because crypt is
# authenticated. The case that gets THROUGH rclone is a file already sitting in
# the target with the same name and size: copy skips it, the count comes out
# right, and the bytes are somebody else's. Measured 2026-09-11 - this is what
# the --download sample check in restore-storage.sh is for, and step 7 keeps it
# honest, because a check with nothing to catch quietly stops being one.
step "7. an impostor already in the target must not pass"
IMPOSTOR_DIR="$WORK_DIR/impostor"
mkdir -p "$IMPOSTOR_DIR/item-photos/user-b"
REAL="item-photos/user-b/front_1.jpg"
REAL_BYTES="$(wc -c < "$SOURCE_DIR/$REAL" | tr -d ' ')"
# Same byte length, different content, so only a content comparison can tell.
head -c "$REAL_BYTES" /dev/zero | tr '\0' 'X' > "$IMPOSTOR_DIR/$REAL"
REMOTE_MTIME="$(rclone lsl "drillcrypt:storage/$REAL" 2>/dev/null | awk '{print $2" "$3}')"
[ -n "$REMOTE_MTIME" ] && touch -d "$REMOTE_MTIME" "$IMPOSTOR_DIR/$REAL" 2>/dev/null || true
set +e
IMPOSTOR_OUT="$(RCLONE_REMOTE="drillcrypt:" RESTORE_ALLOW_NONEMPTY=1 \
  bash scripts/ops/restore-storage.sh "$IMPOSTOR_DIR" 2>&1)"
IMPOSTOR_CODE=$?
set -e
IMPOSTOR_NOW="$(sha256sum < "$IMPOSTOR_DIR/$REAL" | cut -d' ' -f1)"
REAL_HASH="$(sha256sum < "$SOURCE_DIR/$REAL" | cut -d' ' -f1)"
if [ "$IMPOSTOR_NOW" = "$REAL_HASH" ]; then
  # rclone chose to re-transfer it. Nothing was skipped, so there is no skipped
  # file to catch and the case did not get set up. Say so rather than pass.
  bad "step 7 did not reproduce a skip: rclone re-transferred $REAL, so nothing was left for the sample check to catch"
elif [ "$IMPOSTOR_CODE" -ne 0 ] && printf '%s' "$IMPOSTOR_OUT" | grep -q "contents differ"; then
  ok "restore exited $IMPOSTOR_CODE on a skipped impostor (rclone check --download saw 'contents differ')"
else
  bad "restore exited $IMPOSTOR_CODE and did NOT flag the impostor - a wrong-byte file passed as a clean restore"
fi

# --- result -----------------------------------------------------------------
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
