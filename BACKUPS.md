# Backups & Restore (US-494)

The self-hosted Postgres **and** Supabase Storage must be backed up and
restorable, so a volume failure or a bad migration isn't unrecoverable.

All mechanism lives in **`scripts/ops/`** — this document is the runbook that
wires it to a schedule and records the verified restore procedure.

| Script | Purpose |
|---|---|
| `scripts/ops/backup-postgres.sh` | nightly `pg_dump` (custom format) → verify → sha256 → offsite via rclone → prune local |
| `scripts/ops/backup-storage.sh` | daily `rclone sync` of the storage volume offsite, deletions kept in dated `storage-deleted/` prefixes |
| `scripts/ops/restore-postgres.sh` | restore a dump into a target DB (prod-guarded) + sanity queries |
| `scripts/ops/restore-drill.sh` | automated end-to-end drill: dump → fresh scratch container → restore → source-vs-restored count comparison |

## Targets

- **RPO (max data loss):** ≤ 24h from the nightly base backup; ≤ 5 min once
  WAL archiving (below) is enabled — required before the paid revenue path
  carries meaningful volume.
- **RTO (max downtime to restore):** ≤ 2h. The drill on 2026-06-12 measured
  dump 1s + restore 11s for the full schema (near-empty data — scale with
  volume); budget the rest for provisioning a replacement host, repointing
  DNS/secrets, and the storage `rclone sync` back.

## What to back up

1. **Postgres** — all application data (users, submissions, grades, billing,
   ledger, FlipDesk) plus the `auth`/`storage` schemas Supabase keeps in the
   same database.
2. **Supabase Storage** — the `submission-images` (private grading photos) and
   `item-photos` (public listing imagery) buckets on the host volume.

## Schedule (cron on the DB host)

These run on the **host** that carries the Postgres + storage volumes (not in
the edge container — that container has no volume access and Coolify
"scheduled tasks" only exec inside it). Install as root crontab entries:

```cron
# /etc/cron.d/gradethread-backups
15 2 * * * root SUPABASE_DB_URL=postgres://... RCLONE_REMOTE=r2:gradethread-backups/pg ALERT_WEBHOOK_URL=https://... /opt/gradethread/scripts/ops/backup-postgres.sh >> /var/log/gradethread-backup.log 2>&1
45 2 * * * root RCLONE_REMOTE=r2:gradethread-backups STORAGE_DIR=/var/lib/supabase/storage ALERT_WEBHOOK_URL=https://... /opt/gradethread/scripts/ops/backup-storage.sh >> /var/log/gradethread-backup.log 2>&1
```

Both scripts POST to `ALERT_WEBHOOK_URL` on any failure — point it at the same
Slack/Discord webhook the edge service uses (`MONITOR_ALERT_WEBHOOK`), so a
silently failing backup pages somebody.

**Offsite target:** a Cloudflare R2 bucket (`gradethread-backups`) in a
different region/provider than the Hetzner/Coolify host, configured as an
rclone remote named `r2` on the host (`rclone config`, S3-compatible, R2
endpoint).

## Retention

| Copy | Where | Retention | Enforced by |
|---|---|---|---|
| Nightly pg dump (local) | `/backups/pg` on the DB host | 7 days | `backup-postgres.sh` (`find -mtime +7 -delete`) |
| Nightly pg dump (offsite) | `r2:gradethread-backups/pg` | 30 days | R2 lifecycle rule on the `pg/` prefix |
| Storage mirror | `r2:gradethread-backups/storage` | live mirror | n/a (sync) |
| Storage deleted/overwritten files | `r2:gradethread-backups/storage-deleted/<ts>/` | 30 days | R2 lifecycle rule on the `storage-deleted/` prefix |

This is the "backup rotation policy" referenced by `vault/10-ops/data-retention.md`:
data deleted under GDPR/CCPA ages out of all backups within **30 days**.

> **MANUAL (one-time):** create the two R2 lifecycle rules (30-day expiry on
> `pg/` and `storage-deleted/`) when creating the bucket, and tick the
> "backups confirmed running" box in `LAUNCH_CHECKLIST.md` §5 after the first
> cron-produced dump lands offsite.

## PITR (WAL archiving) — tightens RPO to ~5 min

The nightly dump alone means up to 24h of loss. Before launch-scale revenue,
enable WAL archiving with [wal-g](https://github.com/wal-g/wal-g) on the DB
host, shipping to the same R2 bucket:

1. Install `wal-g`, configure env in `/etc/wal-g.d/env` (R2 keys,
   `WALG_S3_PREFIX=s3://gradethread-backups/walg`).
2. In `postgresql.conf`:
   `archive_mode = on`, `archive_command = 'wal-g wal-push %p'`,
   `archive_timeout = 300` (forces a segment at least every 5 min → the RPO).
3. Weekly base backup from cron: `wal-g backup-push $PGDATA`, retention
   `wal-g delete retain FULL 4 --confirm`.
4. PITR restore: `wal-g backup-fetch` the base, then set
   `recovery_target_time = '<just before the bad migration>'` and
   `restore_command = 'wal-g wal-fetch %f %p'` — this is the "undo a bad
   migration" path; the nightly dump is the "volume is gone" path.

> **MANUAL:** wal-g setup happens on the prod host; record the chosen
> `WALG_S3_PREFIX` and the base-backup cron line here once configured. Until
> then the stated RPO is the 24h nightly-dump figure.

## Restore procedure (VERIFIED 2026-06-12)

The procedure below is exactly what `scripts/ops/restore-drill.sh` automates
and was executed end-to-end on 2026-06-12 (see drill log).

1. Provision a target Postgres from the **same Supabase image** as prod
   (`public.ecr.aws/supabase/postgres:<prod tag>`). A vanilla `postgres` image
   will NOT restore cleanly — the dump's RLS policies reference the
   `anon`/`authenticated`/`service_role` roles and Supabase extensions that
   only the Supabase image pre-creates.
2. Fetch the latest dump + checksum: `rclone copy r2:gradethread-backups/pg/<latest>.dump* .`
3. `bash scripts/ops/restore-postgres.sh <dump> <target-db-url>` — it verifies
   the sha256, restores with `--no-owner --no-privileges --clean --if-exists`,
   and prints sanity counts. `pg_restore` reporting "errors ignored" for
   pre-existing Supabase scaffolding (extension comments, event triggers) is
   expected; the sanity counts are the success criterion.
4. For PITR instead (bad migration, not lost volume): wal-g path above.
5. Restore storage: `rclone sync r2:gradethread-backups/storage/ /var/lib/supabase/storage/`
   (check `storage-deleted/<ts>/` prefixes if recovering files deleted after
   the incident started).
6. Point the Supabase services / edge service at the restored DB; smoke test:
   `/health/ready` returns 200, edge logs show `[schema-version] OK`, a known
   certificate page loads, a test grade submits.

### Rehearsing the drill locally

```bash
supabase db start && supabase db reset   # local stack with current schema
bash scripts/ops/restore-drill.sh        # PASS/FAIL + timings
```

## Restore drill log

| Date | What was restored | Result | Timing | Operator |
|---|---|---|---|---|
| 2026-06-12 | Full pg dump (schema at migration 00151 + seeded auth user/submission/grade_report/inventory_item/storage.object rows) → fresh `public.ecr.aws/supabase/postgres:17.6.1.106` scratch container via `restore-drill.sh` | PASS — latest migration, all row counts, and all 270 RLS policies matched source | dump 1s, restore 11s | Ralph (US-494) |
| _before launch_ | A real **prod** offsite dump → scratch host (LAUNCH_CHECKLIST §5) | | | |

> **LAUNCH GATE:** the local drill proves the *procedure*; §5 of
> `LAUNCH_CHECKLIST.md` still requires one drill against a real prod offsite
> dump before launch. A backup that has never been restored is not a backup.
