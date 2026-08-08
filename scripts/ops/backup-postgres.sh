#!/usr/bin/env bash
# Nightly Postgres base backup for the self-hosted Supabase instance (US-494).
#
# Runs ON THE DB HOST (cron or Coolify scheduled task on the host — NOT inside
# the edge container). Produces a pg_dump custom-format archive, verifies it is
# readable, ships it offsite via rclone, and prunes local copies.
#
# Required env:
#   SUPABASE_DB_URL      postgres://... superuser/owner connection string.
#                        MUST be the DIRECT Postgres port (5432), NOT the
#                        transaction pooler (Supavisor/6543) — pg_dump holds a
#                        session-long snapshot the pooler can't preserve. Set it
#                        to SUPABASE_DB_DIRECT_URL for this cron. (US-570)
# Optional env:
#   BACKUP_DIR           local staging dir            (default /backups/pg)
#   RCLONE_REMOTE        offsite target, e.g. r2:gradethread-backups/pg
#                        (unset = local-only; the cron MUST set this in prod)
#   LOCAL_RETENTION_DAYS days to keep local copies    (default 7)
#   ALERT_WEBHOOK_URL    POSTed {"text": ...} on failure (Slack/Discord-style)
#   AGE_BIN              age implementation to use    (default `age`; `rage`,
#                        the Rust build, is format-compatible and is what the
#                        drill uses on Windows where age has no package)
#
# Encryption (US-2416). Anything leaving this host is encrypted FIRST, with a
# key GradeThread holds. The threat being defended against is a leaked R2
# credential, and R2's server-side encryption is transparent to exactly that —
# whoever can read the bucket gets plaintext. So:
#
#   BACKUP_AGE_RECIPIENT   age PUBLIC key ("age1...") — REQUIRED whenever
#                          RCLONE_REMOTE is set. Public-key on purpose: this
#                          host can encrypt but CANNOT decrypt, so rooting the
#                          DB box does not also hand over the backup archive.
#                          The matching identity lives off-host — see
#                          vault/10-ops/backups.md for where.
#
# The script FAILS rather than uploading plaintext if the recipient is missing.
# That is the whole point: a backup that silently degrades to plaintext is the
# bug this exists to prevent. A local-only run (no RCLONE_REMOTE) skips
# encryption, because nothing leaves the host.
#
# The local staging copy stays PLAINTEXT deliberately: it never leaves the box,
# and a restore under pressure should not also need the offsite key. Encrypting
# the host's own disk is a separate concern, tracked as US-2415.
#
# Offsite retention (30 days) is enforced by a lifecycle rule on the bucket —
# see vault/10-ops/backups.md. Restore with scripts/ops/restore-postgres.sh.

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
echo "[backup-postgres] ok: $(du -h "$DUMP" | cut -f1)"

if [ -n "${RCLONE_REMOTE:-}" ]; then
  AGE_BIN="${AGE_BIN:-age}"
  : "${BACKUP_AGE_RECIPIENT:?BACKUP_AGE_RECIPIENT is required when RCLONE_REMOTE is set — refusing to ship a plaintext dump offsite (US-2416)}"
  command -v "$AGE_BIN" >/dev/null 2>&1 || {
    alert "$AGE_BIN not installed — refusing to ship a plaintext dump offsite"
    exit 1
  }

  echo "[backup-postgres] encrypting for $BACKUP_AGE_RECIPIENT"
  "$AGE_BIN" --encrypt --recipient "$BACKUP_AGE_RECIPIENT" --output "$DUMP.age" "$DUMP"
  # An unreadable ciphertext is not a backup either. age has no --list, so the
  # cheapest real check is the format header: a truncated or empty output (a
  # full disk mid-encrypt, say) does not have one.
  head -c 21 "$DUMP.age" | grep -q '^age-encryption.org/v1' || {
    alert "encrypted artifact $DUMP.age is not a valid age file — NOT uploading"
    exit 1
  }

  # sha256 over the CIPHERTEXT, because the ciphertext is the object that
  # lands in the bucket and the offsite freshness check verifies what is
  # actually stored (AC2). A checksum of the plaintext would verify something
  # the bucket does not contain.
  #
  # Recorded as a BARE FILENAME (cd first), not the absolute staging path. The
  # sidecar travels to a scratch host where /backups/pg does not exist, and
  # `sha256sum -c` resolves whatever path the file records — so an absolute one
  # fails with "No such file or directory" on every real restore. Verified: the
  # previous form did exactly that.
  ( cd "$BACKUP_DIR" && sha256sum "$(basename "$DUMP.age")" > "$(basename "$DUMP.age").sha256" )

  echo "[backup-postgres] shipping offsite to $RCLONE_REMOTE"
  rclone copy "$DUMP.age" "$RCLONE_REMOTE/" --no-traverse
  rclone copy "$DUMP.age.sha256" "$RCLONE_REMOTE/" --no-traverse
else
  # Local-only: nothing crosses the network, so the plaintext sidecar is still
  # the right integrity check for the artifact that exists. Bare filename for
  # the same reason as above.
  ( cd "$BACKUP_DIR" && sha256sum "$(basename "$DUMP")" > "$(basename "$DUMP").sha256" )
  alert "RCLONE_REMOTE unset — backup $TS is LOCAL ONLY (no offsite copy)"
fi

find "$BACKUP_DIR" -name 'gradethread-*.dump*' -mtime "+$LOCAL_RETENTION_DAYS" -delete
echo "[backup-postgres] done (local retention ${LOCAL_RETENTION_DAYS}d)"
