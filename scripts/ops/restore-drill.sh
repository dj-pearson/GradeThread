#!/usr/bin/env bash
# Automated backup → restore drill (US-494).
#
# Proves the backup/restore procedure end-to-end without touching production:
#   1. pg_dump the SOURCE database (default: the local `supabase db start`
#      stack) using the same custom format as backup-postgres.sh
#   2. encrypt + checksum + decrypt it exactly as backup-postgres.sh and
#      restore-postgres.sh do (US-2416), under an EPHEMERAL keypair generated
#      for this run — so what gets restored below is a round-tripped
#      ciphertext, not the plaintext dump
#   3. boot a FRESH scratch Postgres container from the same Supabase image
#   4. pg_restore the dump into it (same flags as restore-postgres.sh)
#   5. compare row counts + latest migration between source and restored copy
#   6. report PASS/FAIL and the observed restore time (informs RTO)
#
# Step 2 is on by default and not optional-by-accident: "an encryption change
# that breaks restore is worse than no encryption" is the whole risk, so a
# drill that silently skipped it would be measuring the wrong procedure.
#
# Run it from the repo root with Docker up and `supabase db start` running:
#   bash scripts/ops/restore-drill.sh
#
# Optional env:
#   SOURCE_CONTAINER  source Postgres container (default supabase_db_gradethread)
#   PGPASSWORD        supabase_admin password in both containers (default postgres,
#                     which is what the supabase CLI stack uses)
#   KEEP=1            keep the scratch container + dump for inspection
#   AGE_BIN           age implementation. Unset, it prefers `age` and falls back
#                     to `rage` (the Rust build, format-compatible, and the only
#                     one packaged for Windows — `scoop install rage`). Set it to
#                     pin one on a host that has both.
#   AGE_KEYGEN_BIN    keygen binary (default "<AGE_BIN>-keygen")
#   DRILL_SKIP_ENCRYPTION=1  skip step 2. Deliberate opt-out only; it makes the
#                     drill measure a procedure prod does not use.
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
    rm -f "$WORK_DIR/$DUMP_NAME" "$WORK_DIR/$DUMP_NAME.age" \
      "$WORK_DIR/$DUMP_NAME.age.sha256" "$WORK_DIR/drill-identity.txt"
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

echo "[drill] 1/5 pg_dump (custom format, as backup-postgres.sh does)"
T0=$(date +%s)
# Streamed over stdout (not --file) so no container paths are involved —
# Git-for-Windows would rewrite a /tmp argument into a Windows path.
docker exec -e PGPASSWORD="$PGPASSWORD" "$SOURCE_CONTAINER" pg_dump -U supabase_admin -d postgres \
  --format=custom --compress=6 --no-owner > "$WORK_DIR/$DUMP_NAME"
T_DUMP=$(( $(date +%s) - T0 ))
echo "[drill] dump ok: $(du -h "$WORK_DIR/$DUMP_NAME" | cut -f1) in ${T_DUMP}s"

# ── 2/5 encryption round-trip (US-2416) ──────────────────────────────────────
# Mirrors backup-postgres.sh (encrypt to a recipient, sha256 the CIPHERTEXT)
# and restore-postgres.sh (verify the sha256, then decrypt with the identity).
# The keypair is generated per run and thrown away, so the drill never needs
# the real backup key and cannot leak it.
ENCRYPTION_NOTE="SKIPPED"
if [ "${DRILL_SKIP_ENCRYPTION:-}" = "1" ]; then
  echo "[drill] 2/5 encryption round-trip SKIPPED (DRILL_SKIP_ENCRYPTION=1)"
  echo "[drill] WARNING: prod ships ENCRYPTED backups — this run does not prove they restore"
else
  # Pick the implementation rather than demanding one. `rage` is the Rust build,
  # format-compatible, and the only one packaged for Windows — so on the dev box
  # the default `age` is never present and the drill stopped with an error the
  # first time anyone ran it, having already done the pg_dump. The header said to
  # re-run with AGE_BIN=rage; a drill is exactly the thing people run rarely and
  # under stress, and "it told you in a comment" is not a working default.
  #
  # An explicit AGE_BIN still wins, so pinning one implementation on a host that
  # has both stays possible.
  if [ -z "${AGE_BIN:-}" ]; then
    if command -v age >/dev/null 2>&1; then AGE_BIN=age
    elif command -v rage >/dev/null 2>&1; then
      AGE_BIN=rage
      echo "[drill] age not found; using rage (format-compatible)"
    else
      AGE_BIN=age
    fi
  fi
  AGE_KEYGEN_BIN="${AGE_KEYGEN_BIN:-${AGE_BIN}-keygen}"
  command -v "$AGE_BIN" >/dev/null 2>&1 || {
    echo "ERROR: neither age nor rage found. Prod backups are encrypted, so a drill" >&2
    echo "       without one proves nothing about restoring them. Install age, or" >&2
    echo "       \`scoop install rage\` on Windows, or set DRILL_SKIP_ENCRYPTION=1" >&2
    echo "       knowingly." >&2
    exit 1
  }
  command -v "$AGE_KEYGEN_BIN" >/dev/null 2>&1 || {
    # Checked separately because it fails LATER otherwise — after the dump, at
    # the keygen line, with a bare "command not found" that names neither the
    # step nor the fix.
    echo "ERROR: $AGE_BIN is installed but $AGE_KEYGEN_BIN is not." >&2
    echo "       Set AGE_KEYGEN_BIN to the keygen binary for your build." >&2
    exit 1
  }
  echo "[drill] 2/5 encryption round-trip via $AGE_BIN (ephemeral keypair)"
  "$AGE_KEYGEN_BIN" -o "$WORK_DIR/drill-identity.txt" 2>/dev/null
  chmod 600 "$WORK_DIR/drill-identity.txt"
  DRILL_RECIPIENT="$("$AGE_KEYGEN_BIN" -y "$WORK_DIR/drill-identity.txt")"

  "$AGE_BIN" --encrypt --recipient "$DRILL_RECIPIENT" \
    --output "$WORK_DIR/$DUMP_NAME.age" "$WORK_DIR/$DUMP_NAME"
  head -c 21 "$WORK_DIR/$DUMP_NAME.age" | grep -q '^age-encryption.org/v1' || {
    echo "ERROR: encrypted artifact has no age header" >&2; exit 1;
  }

  # Prove it is actually ciphertext rather than a copy — a passthrough bug here
  # would leave the drill green while backups shipped in the clear.
  if pg_restore --list "$WORK_DIR/$DUMP_NAME.age" >/dev/null 2>&1; then
    echo "ERROR: the '.age' artifact is still a readable pg_dump — encryption did nothing" >&2
    exit 1
  fi

  (cd "$WORK_DIR" && sha256sum "$DUMP_NAME.age" > "$DUMP_NAME.age.sha256")
  (cd "$WORK_DIR" && sha256sum -c "$DUMP_NAME.age.sha256" >/dev/null)

  rm -f "$WORK_DIR/$DUMP_NAME"
  "$AGE_BIN" --decrypt --identity "$WORK_DIR/drill-identity.txt" \
    --output "$WORK_DIR/$DUMP_NAME" "$WORK_DIR/$DUMP_NAME.age"
  pg_restore --list "$WORK_DIR/$DUMP_NAME" >/dev/null
  echo "[drill] encrypt -> sha256 -> verify -> decrypt OK ($(du -h "$WORK_DIR/$DUMP_NAME.age" | cut -f1) ciphertext)"
  ENCRYPTION_NOTE="age round-trip PASSED"
fi

echo "[drill] 3/5 booting fresh scratch container from $IMAGE"
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

echo "[drill] 4/5 pg_restore into scratch (flags match restore-postgres.sh)"
T0=$(date +%s)
docker exec -i -e PGPASSWORD="$PGPASSWORD" "$SCRATCH_CONTAINER" pg_restore -U supabase_admin -d postgres \
  --no-owner --no-privileges --clean --if-exists < "$WORK_DIR/$DUMP_NAME" || true
T_RESTORE=$(( $(date +%s) - T0 ))
echo "[drill] pg_restore finished in ${T_RESTORE}s (\"errors ignored\" for pre-existing scaffolding are expected)"

echo "[drill] 5/5 verifying restored copy against source"
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
  echo "[drill] PASS — dump ${T_DUMP}s, restore ${T_RESTORE}s, encryption: ${ENCRYPTION_NOTE}. Record this run in vault/10-ops/backups.md (drill log) and vault/10-ops/launch-checklist.md §5."
else
  echo "[drill] FAIL — restored copy does not match source. Do NOT trust backups until this passes." >&2
  exit 1
fi
