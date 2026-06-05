# Backups & Restore (US-494)

The self-hosted Postgres **and** Supabase Storage must be backed up and
restorable, so a volume failure or a bad migration isn't unrecoverable.

## Targets

- **RPO (max data loss):** ≤ 24h from base backups; ≤ 5 min if WAL archiving /
  PITR is enabled (recommended for the paid revenue path).
- **RTO (max downtime to restore):** ≤ 2h.

## What to back up

1. **Postgres** — all application data (users, submissions, grades, billing,
   ledger, FlipDesk).
2. **Supabase Storage** — the `submission-images` (private grading photos) and
   `item-photos` (public listing imagery) buckets, stored on the host volume /
   S3-compatible backend.

## Postgres backups

### Daily base backup (cron on the DB host)

```bash
# /etc/cron.daily/gradethread-pgdump
TS=$(date -u +%Y%m%dT%H%M%SZ)
pg_dump --format=custom --no-owner "$SUPABASE_DB_URL" \
  | gzip > /backups/pg/gradethread-$TS.dump.gz
# Push offsite (cross-region) — e.g. to Cloudflare R2 / S3:
rclone copy /backups/pg/gradethread-$TS.dump.gz remote:gradethread-backups/pg/
find /backups/pg -name '*.dump.gz' -mtime +7 -delete   # local retention 7d
```

Offsite retention: **30 days** (lifecycle rule on the bucket).

### PITR (recommended) — base + WAL

Enable `archive_mode = on` and `archive_command` to ship WAL segments offsite
continuously; take a weekly `pg_basebackup`. This gives ~5-min RPO and
point-in-time recovery to just before a bad migration.

> **MANUAL:** configure `archive_command` (e.g. `wal-g`/`pgbackrest` → R2/S3) on
> the Postgres host. Document the chosen tool's config here once set.

## Storage backups

```bash
# Mirror both buckets offsite daily (object storage → cross-region bucket).
rclone sync /var/lib/supabase/storage remote:gradethread-backups/storage/
```

## Restore procedure (TESTED)

1. Provision a fresh Postgres (or scratch instance for a test restore).
2. `gunzip -c gradethread-<TS>.dump.gz | pg_restore --no-owner -d "$TARGET_DB_URL"`
3. For PITR: restore the base backup, then replay WAL to the target timestamp
   via `recovery_target_time`.
4. Restore storage: `rclone sync remote:gradethread-backups/storage/ <target>`.
5. Point the edge service / Supabase at the restored DB; run a smoke test
   (`/health/ready` 200, a known certificate loads, a test grade submits).

## Restore drill log

| Date | What was restored | Result | RTO observed | Operator |
|---|---|---|---|---|
| _TODO before launch_ | Full pg + storage to scratch | | | |

> **MANUAL / LAUNCH-BLOCKER:** perform one real restore drill into a scratch
> environment and record the verified procedure + timings in the table above.
> A backup that has never been restored is not a backup.
