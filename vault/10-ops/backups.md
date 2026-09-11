---
title: Backups and restore drills
aliases: [BACKUPS, restore drill]
type: runbook
status: current
source_of_truth: vault
code_refs:
  - scripts/ops/backup-storage.sh
  - scripts/ops/restore-storage.sh
  - scripts/ops/restore-storage-drill.sh
  - scripts/ops/restore-postgres.sh
  - scripts/restore-postgres-guard.test.mjs
reviewed: 2026-09-11
tags: [ops, backup, disaster-recovery]
summary: What is backed up, how often, and the restore drills that prove it works — Postgres AND the storage mirror. The storage half has a restore script, a drill and a procedure; its crypt password still lives on the host it protects against losing, which is the open half.
---
# Backups & Restore (US-494)

The self-hosted Postgres **and** Supabase Storage must be backed up and
restorable, so a volume failure or a bad migration isn't unrecoverable.

All mechanism lives in **`scripts/ops/`** — this document is the runbook that
wires it to a schedule and records the verified restore procedure.

| Script | Purpose |
|---|---|
| `scripts/ops/backup-postgres.sh` | nightly `pg_dump` (custom format) → verify → **encrypt (age)** → sha256 of the ciphertext → offsite via rclone → prune local |
| `scripts/ops/backup-storage.sh` | daily `rclone sync` of the storage volume offsite **to a crypt remote**, deletions kept in dated `storage-deleted/` prefixes |
| `scripts/ops/restore-postgres.sh` | **refuse unless the target is named back** → verify sha256 → **decrypt** → restore into the target DB → **verify the restore itself** (non-empty counts, every table in the dump present, optional source comparison) |
| `scripts/ops/restore-drill.sh` | automated end-to-end drill: dump → **encrypt/verify/decrypt round-trip** → fresh scratch container → restore → source-vs-restored count comparison |

## Targets

- **RPO (max data loss):** ≤ 24h from the nightly base backup; ≤ 5 min once
  WAL archiving (below) is enabled — required before the paid revenue path
  carries meaningful volume.
- **RTO (max downtime to restore):** ≤ 2h. The drill on 2026-06-12 measured
  dump 1s + restore 11s for the full schema (near-empty data — scale with
  volume); budget the rest for provisioning a replacement host, repointing
  DNS/secrets, and the storage `rclone sync` back.

> [!danger] The 24h figure assumes the nightly cron is INSTALLED, and that has
> never been confirmed on the prod host (US-2002, [!LAUNCH BLOCKER])
> Every number above is a property of the backup *mechanism*. The scripts exist,
> they work, and the restore was drilled on 2026-06-12. What was never verified
> is that anything **runs them on a schedule in production**.
>
> If the cron is not installed, the real RPO is not 24 hours — it is **total
> loss**, and this table would have told an operator otherwise at exactly the
> moment being wrong costs the most. That is the specific failure AC3 of US-2002
> forbids: a documented RPO the infrastructure cannot deliver.
>
> **Confirm before trusting any number here.** On the prod DB host:
> `crontab -l` should list the backup line from the Setup section below, and the
> offsite bucket should hold an object from the last 24h **with its checksum
> beside it** — a dump with no checksum is a backup nobody has proven is
> readable. Once both are true, replace this callout with the date you checked.
>
> Since US-2416 the offsite object names are `gradethread-<ts>.dump.age` and
> `gradethread-<ts>.dump.age.sha256`. A bare `.dump` in the bucket is not a
> success — it means an older script version is still deployed and the nightly
> is shipping **plaintext**.
>
> Note the shape of this gap, because it is not a missing feature: it is a
> runbook step marked MANUAL that nobody performed. Everything needed already
> exists.

## What to back up

1. **Postgres** — all application data (users, submissions, grades, billing,
   ledger, FlipDesk) plus the `auth`/`storage` schemas Supabase keeps in the
   same database.
2. **Supabase Storage** — the `submission-images` (private grading photos) and
   `item-photos` (public listing imagery) buckets on the host volume.

## Encryption (US-2416)

Everything that leaves the host is encrypted with a key GradeThread holds,
**before** it reaches Cloudflare R2.

The threat is a leaked R2 credential, not a hostile Cloudflare. R2's
server-side encryption is transparent to exactly that credential, so it does
not help here: whoever can list the bucket gets a full plaintext dump of every
user, address, grade and credit-ledger row. Host-disk encryption is a separate
gap, tracked as US-2415 in the backlog.

| Artifact | Mechanism | Key |
|---|---|---|
| Postgres dump | `age`, public-key, applied by `backup-postgres.sh` before `rclone copy` | `BACKUP_AGE_RECIPIENT` (public) on the host; identity (private) off-host |
| Storage mirror | rclone **crypt remote** (client-side, per object, keeps `sync` diffable) | rclone crypt password + salt |

**Why public-key for the dump.** The DB host holds only the *recipient*
(public) half, so it can encrypt but cannot decrypt. Rooting the database box
therefore does not also hand over the offsite archive. `backup-postgres.sh`
**refuses to upload at all** if `BACKUP_AGE_RECIPIENT` is unset — a backup that
silently degrades to plaintext is the failure this exists to prevent.

The **local** staging copy in `/backups/pg` stays plaintext on purpose: it never
crosses the network, and a restore under pressure should not also depend on
fetching the offsite key.

> [!danger] Lose the key and you lose every backup
> There is no recovery path, no escrow and no support ticket that undoes this.
> An age-encrypted dump without its identity file is random bytes forever. This
> risk is *created* by encrypting backups and is the price of it — so the key
> needs at least two independent, durable homes, and neither of them may be the
> machine being backed up.
>
> It also must not depend on the platform it protects: if the only copy lived in
> a system that authenticates through the same host, a total host loss would
> take the backups with it.

> [!todo] **MANUAL (one-time, before the encrypted cron goes live):** generate
> the keypair and store it. Nobody has done this yet — the scripts are ready and
> the key does not exist.
>
> ```bash
> age-keygen -o gradethread-backup-identity.txt   # prints the public recipient
> ```
>
> 1. Put the **identity** (the whole file, private) in Infisical as
>    `BACKUP_AGE_IDENTITY`. Note it is NOT an application env var and no
>    deployment surface reads it — it is an operator recovery key, which is why
>    it does not appear in [[env-reference]]. It is set by hand, only during a
>    restore.
> 2. Put a **second copy** somewhere offline and durable that does not depend on
>    Infisical or the Contabo host.
> 3. Put the **public recipient** (`age1...`) in the cron line below as
>    `BACKUP_AGE_RECIPIENT`. It is not secret.
> 4. Shred the local file. Then tick this box with the date and *where*, never
>    the value.
>
> For the storage mirror, `rclone config` a `crypt` remote wrapping the R2
> remote and point `RCLONE_REMOTE` at it. `backup-storage.sh` now **refuses** a
> non-crypt remote unless `STORAGE_BACKUP_ALLOW_PLAINTEXT=1` is set
> deliberately — that mirror contains grading **label** photos, which carry
> brand, size and frequently a name or packing slip.

Rotation, including what to do about ciphertext already sitting in the 30-day
bucket under the old key, is in [[key-rotation]].

## Schedule (cron on the DB host)

These run on the **host** that carries the Postgres + storage volumes (not in
the edge container — that container has no volume access and Coolify
"scheduled tasks" only exec inside it). Install as root crontab entries:

```cron
# /etc/cron.d/gradethread-backups
15 2 * * * root SUPABASE_DB_URL=postgres://... RCLONE_REMOTE=r2:gradethread-backups/pg BACKUP_AGE_RECIPIENT=age1... ALERT_WEBHOOK_URL=https://... /opt/gradethread/scripts/ops/backup-postgres.sh >> /var/log/gradethread-backup.log 2>&1
45 2 * * * root RCLONE_REMOTE=r2crypt:gradethread-backups STORAGE_DIR=/var/lib/supabase/storage ALERT_WEBHOOK_URL=https://... /opt/gradethread/scripts/ops/backup-storage.sh >> /var/log/gradethread-backup.log 2>&1
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

> [!todo] **MANUAL (one-time):** create the two R2 lifecycle rules (30-day expiry on
> `pg/` and `storage-deleted/`) when creating the bucket, and tick the
> "backups confirmed running" box in `vault/10-ops/launch-checklist.md` §5 after the first
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

> [!todo] **MANUAL:** wal-g setup happens on the prod host; record the chosen
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
3. `bash scripts/ops/restore-postgres.sh <dump> <target-db-url>`. **It refuses
   the first time, on purpose** (see [The restore guard](#the-restore-guard-us-3394)
   below): copy the `RESTORE_CONFIRM_TARGET='<host>:<port>/<dbname>'` line out
   of the refusal, read it, and re-run with it. Then it verifies the sha256,
   restores with `--no-owner --no-privileges --clean --if-exists`, and
   **decides for itself** whether the restore worked. `pg_restore` reporting
   "errors ignored" for pre-existing Supabase scaffolding (extension comments,
   event triggers) is still expected and is not a failure; `pg_restore` failing
   for any other reason now stops the run instead of being swallowed.
   The verdict is a single `PASS` or `FAIL` line and the exit code matches it.
   Set `SOURCE_DB_URL` when a source database is reachable and it compares the
   two value-for-value; without one it still fails the run on an empty table,
   an empty `schema_migrations`, or any table present in the dump and absent
   from the target.
4. For PITR instead (bad migration, not lost volume): wal-g path above.
5. Restore storage: `RCLONE_REMOTE=r2crypt:gradethread-backups bash scripts/ops/restore-storage.sh /var/lib/supabase/storage`
   — see [Storage restore](#storage-restore-procedure-us-2659) below.
   ⚠ This step used to read `rclone sync r2:gradethread-backups/storage/
   /var/lib/supabase/storage/`, which was wrong three ways and is kept here so
   nobody reinstates it: `sync` (rather than `copy`) DELETES local files absent
   from the backup, so running it against a partly-recovered volume destroys
   what you just salvaged; it names the plaintext remote rather than the crypt
   one `backup-storage.sh` actually writes to; and it treats rclone's exit code
   as success, which is 0 for a copy that produced zero files.
6. Point the Supabase services / edge service at the restored DB; smoke test:
   `/health/ready` returns 200, edge logs show `[schema-version] OK`, a known
   certificate page loads, a test grade submits.

### The restore guard (US-3394)

Until 2026-09-11 this page called `restore-postgres.sh` "prod-guarded". It was
not. The only check was:

```bash
case "$TARGET" in
  *gradethread.com*) [ "$ALLOW_PROD_RESTORE" = 1 ] || exit 1 ;;
esac
```

**No GradeThread Postgres DSN contains `gradethread.com`.** That name belongs to
the HTTP surfaces (`api.`, `functions.`). Postgres is reached as
`postgres://postgres:...@<host>:5432/postgres`, or over ssh plus `docker exec`
with no URL at all, or from the DB host itself by the backup cron. So the arm
never matched any target the script was ever pointed at, and nothing in the repo
exercised it: `restore-drill.sh` reimplements the restore rather than calling
this script, so three months of green drills said nothing about the guard.

**What replaced it, and why not a better hostname list.** "This looks like prod"
is a judgement a string match cannot make, and a heuristic that is wrong is
worse than no heuristic because it manufactures confidence at the one moment
being wrong is unrecoverable. So the script now refuses **every** target and
makes the operator name back the one they are about to destroy:

```
ERROR: refusing to restore. ...
  target resolves to: db-host:5432/postgres
  Re-run with:
    RESTORE_CONFIRM_TARGET='db-host:5432/postgres' \
      scripts/ops/restore-postgres.sh <dump-file> <target-db-url>
```

Three properties that are deliberate, so leave them alone:

- It is the **target's own identity**, not a flag. A blanket `ALLOW=1` in a shell
  profile or a CI environment cannot satisfy it, and confirming one database
  does not let you restore over a different one.
- It is **credential-free**: `host:port/dbname`, never the password. Nobody has
  to re-type a secret into a second place mid-incident, and the line is safe in
  scrollback.
- `ALLOW_PROD_RESTORE` is **no longer read**. Setting it prints a note saying so,
  so an old copy of this runbook fails loudly rather than appearing to work.

The guard is exercised by `scripts/restore-postgres-guard.test.mjs` in
`npm run test:scripts`. It runs the real script against fake `pg_restore` and
`psql` binaries on `PATH` and asserts the destructive call was never made, so a
future rewrite that neuters the guard turns the lane red. No database needed:
a guard test that required Postgres would not run, and a guard that does not run
is exactly how this survived.

### Rehearsing the drill locally

```bash
supabase db start && supabase db reset   # local stack with current schema
bash scripts/ops/restore-drill.sh        # PASS/FAIL + timings
```

## Storage restore procedure (US-2659)

The photo mirror is every listing photo, every grading photo **including label
shots**, and every certificate asset. Until 2026-08-16 there was a backup script
and nothing else — no restore script, no drill, and no procedure here. It had
never been read back.

```bash
# FULL REBUILD — the volume is gone, the target is empty.
RCLONE_REMOTE=r2crypt:gradethread-backups \
  bash scripts/ops/restore-storage.sh /var/lib/supabase/storage
```

`restore-storage.sh` does four things `rclone copy` alone does not, each because
of a way this can look like it worked when it did not. Every one was made to
fire on 2026-09-11 against a local crypt remote; the observed output is quoted
so the list stays falsifiable.

- **refuses a zero-file restore** (exit 1): `restore produced ZERO files from
  cryptr:/storage-empty`. rclone exits 0 on a copy that produced nothing, so an
  existing-but-empty prefix reads as success. A prefix that does not exist at
  all errors inside rclone first, exit 3.
- **refuses a source remote that is not type `crypt`** (exit 1): `remote
  'plainalias' is type 'alias', not 'crypt'`. Checked against
  `rclone config show`, not the remote's name.
- **refuses a non-empty target** unless you set `RESTORE_ALLOW_NONEMPTY=1`
  (exit 1), so you cannot mix two generations of the mirror by accident.
- **re-checks a sample byte-for-byte** with `rclone check --download`, and
  refuses an empty verification list, because zero files compared is zero
  differences found and prints like a pass.

> [!note] **What the sample check is really for, corrected 2026-09-11**
> This section used to say a wrong crypt password "does not error on listing, it
> yields names that decrypt to garbage", and that content comparison is what
> proves the password. Both are wrong. rclone crypt is authenticated, so a wrong
> password fails the transfer outright in either configuration, measured:
> `error reading source root directory: directory not found` with filename
> encryption on, `failed to authenticate decrypted block - bad password?` with
> it off. rclone catches the lost-key case by itself.
>
> The case that gets *through* rclone is a file already sitting in the target
> under the same name, size and modtime: `rclone copy` **skips** it, the script
> reports `restored N file(s)`, and the bytes are someone else's. Reproduced
> with a 10-byte impostor. With `RESTORE_SAMPLE=0` the restore exited **0** and
> left the wrong bytes in place; with the check on it reported `a.jpg: contents
> differ` and exited **1**. That is the case `RESTORE_ALLOW_NONEMPTY=1` opens
> up, so the two settings are a pair. Never turn the sample off, least of all
> when you have turned the non-empty refusal off.

> [!note] **A rotten object and a lost key print the same sentence, measured 2026-09-11**
> Corrupt one object in the bucket (bit rot, a truncated multipart upload, a
> partial overwrite) and the restore stops with `failed to authenticate
> decrypted block - bad password?`, exit 1, having written the other files.
> Reproduced by flipping one byte of a ciphertext object, and again by cutting 8
> bytes off its tail; both give that message. It is the *same* message a wrong
> crypt password gives, and the difference is the count:
>
> - **one object fails, the rest copy** -> that object is damaged. Recover it
>   from a dated `storage-deleted/<ts>` prefix, or accept the loss of that file.
>   The key is fine.
> - **every object fails, or the listing itself fails** -> the password or salt
>   is wrong. Nothing in the bucket is readable until the right one is produced.
>
> Do not read "bad password?" off a single file and conclude the key is gone.
> Drill step 8 keeps this case exercised.

### Partial vs full — different operations (US-2659 AC5)

|  | Full rebuild | Single-object recovery |
|---|---|---|
| When | Volume lost; disaster recovery | Someone deleted or overwrote one photo and the nightly sync propagated it |
| Prefix | `storage` (**the default**) | `storage-deleted/<ts>` |
| Target | the real `STORAGE_DIR`, empty | a **scratch** directory |
| Then | point services at it | copy the one path across by hand |
| How often | once, in a disaster | the routine case |
| What it risks | pulls the entire prefix; against a live volume it reverts every object to its backed-up state | nothing, as long as the target is a scratch directory |

**The default is the full rebuild, and that is deliberate.** It is the more
destructive of the two, so the argument for it is not "it is safer" but that the
non-empty-target refusal stands in front of it: the full form only proceeds into
an empty or absent directory, which is exactly the disaster shape. Making
single-object recovery the default would have been worse, because it silently
recovers *the wrong generation* of a file if you forget to set the prefix, and
nothing refuses that. Recovering one object is a two-flag operation on purpose.

```bash
# SINGLE OBJECT — find the dated prefix, restore it somewhere harmless.
rclone lsf r2crypt:gradethread-backups/storage-deleted --dirs-only
RCLONE_REMOTE=r2crypt:gradethread-backups RESTORE_PREFIX=storage-deleted/<ts> \
  bash scripts/ops/restore-storage.sh /tmp/recovered
cp /tmp/recovered/<bucket>/<user>/<file> /var/lib/supabase/storage/<...>
```

Never point the full-rebuild form at the live `STORAGE_DIR` to recover one file:
it pulls the whole prefix, so it would drag every other object back to its
backed-up state as well.

### Rehearsing the storage drill locally

Needs `rclone` (`scoop install rclone`) and nothing else — no Docker, no
network, no R2 credential. It defines an ephemeral crypt remote over a local
directory in a throwaway config, so the real config is never read or written.

```bash
bash scripts/ops/restore-storage-drill.sh   # PASS/FAIL
```

> [!warning] **The encryption check was scanning an empty directory (fixed 2026-09-11)**
> `rclone` under Git Bash is a native Windows binary, so it read the drill's
> MSYS work path `/tmp/drill.X/remote` as `C:\tmp\drill.X\remote` and wrote the
> whole mirror there. The shell's own `$REMOTE_DIR` pointed somewhere else, so
> the step that greps the remote for plaintext was grepping a directory with
> nothing in it. It found no plaintext, printed PASS, and had inspected zero
> bytes. Every other step goes through rclone, which knew where it really wrote,
> so the drill stayed green and 15 abandoned remote trees piled up outside the
> work directory the cleanup trap deletes.
>
> The drill now converts the path with `cygpath -w` before handing it to rclone,
> and counts the objects it is about to scan: fewer objects on the remote than
> files in the source is a FAIL, and the PASS line names the count
> (`no plaintext across 8 encrypted object(s)`). A pass that cannot say how much
> it looked at is the shape this repo keeps finding in its own guards.
> Pinned by `src/test/storage-drill-remote-visibility.test.ts`.

> [!warning] **What the drill cannot prove.** It uses an ephemeral password, so
> it proves the *round trip* works. It says nothing about whether the REAL crypt
> password and salt exist anywhere other than the DB host — and that host is the
> exact thing an offsite mirror exists to survive losing. See
> [[key-rotation]]. Until that is answered, a total host loss still means every
> object in R2 is unreadable ciphertext.

## Restore drill log

| Date | What was restored | Result | Timing | Operator |
|---|---|---|---|---|
| 2026-06-12 | Full pg dump (schema at migration 00151 + seeded auth user/submission/grade_report/inventory_item/storage.object rows) → fresh `public.ecr.aws/supabase/postgres:17.6.1.106` scratch container via `restore-drill.sh` | PASS — latest migration, all row counts, and all 270 RLS policies matched source | dump 1s, restore 11s | Ralph (US-494) |
| 2026-08-08 | **Encrypted** artifact: local stack at migration 00559 (5 auth users → 5 `public.users`, 20 submissions, 375 RLS policies) → `age` encrypt → sha256 → verify → decrypt → fresh `public.ecr.aws/supabase/postgres:17.6.1.106` scratch container. Also run separately through the real `backup-postgres.sh` + `restore-postgres.sh` pair, restoring from a **different directory** than the backup wrote, which is what an offsite fetch actually does. | PASS — migration, all row counts and all 375 policies matched source | dump 1s, restore 5s | US-2416 |
| 2026-08-16 | **Encrypted** artifact: local stack at migration **00609** → `rage` encrypt → sha256 → verify → decrypt → fresh `public.ecr.aws/supabase/postgres:17.6.1.106` scratch container. **388 RLS policies**, up from 375 in August. ⚠ All row counts were **0** — the stack was the throwaway one `supabase db reset` builds, so this run proves the schema, policy and encryption path and says nothing about restoring DATA. The 2026-08-08 row above is the one that covers that. | PASS — migration 00609 and all 388 policies matched source | dump 1s, restore 8s | US-2618 loop |
| 2026-08-16 | **STORAGE**, first time ever: 8-file volume (submission-images incl. label shots + item-photos) → `backup-storage.sh` → ephemeral rclone **crypt** remote → `restore-storage.sh` → fresh dir. Verified no plaintext on the remote, file count, and every file SHA-256. Then deleted one object, re-synced, and recovered the original bytes from `storage-deleted/<ts>/`. | PASS — 8/8 byte-identical, deleted object recovered intact | <10s | US-2659 |
| 2026-09-11 | **STORAGE**, re-run of the above plus a 7th step: an impostor of the same name and size planted in the target, which `rclone copy` skips. Each of the four refusals was also fired by hand against a local crypt remote (missing remote, missing target arg, `alias` remote, non-empty target, empty prefix), and both new guards were sabotage-verified: emptying the hash loop reports `compared 0 file(s) but the source has 8`, and `RESTORE_SAMPLE=0` lets the impostor through with exit 0. | PASS — 7/7 checks, 8/8 byte-identical; impostor caught with `contents differ`, exit 1 | ~13s | US-2659 |
| 2026-09-11 | **STORAGE**, 8 steps. The 8th is new: one object on the remote corrupted (one byte flipped, and separately 8 bytes cut off the tail) to prove a rotten object stops the restore instead of landing as clean bytes. This run also found that the plaintext scan had been reading an EMPTY directory on every Windows run since 2026-08-16 (see the warning above), so the mirror's one encryption claim had never actually been checked; it now scans 8 real ciphertext objects and says so. Both new guards sabotage-verified: reverting the path conversion gives `the remote directory holds 0 file(s) for 8 source file(s)`, and making the restore swallow rclone's error gives `restore exited 0 on a corrupted remote object`. | PASS — 8/8 checks, 8/8 byte-identical; corrupted object stopped the restore at exit 1 with `failed to authenticate decrypted block` | ~15s | US-2659 |
| _before launch_ | A real **prod** offsite dump → scratch host (LAUNCH_CHECKLIST §5) | | | |

> [!danger] **LAUNCH GATE:** the local drill proves the *procedure*; §5 of
> `vault/10-ops/launch-checklist.md` still requires one drill against a real prod offsite
> dump before launch. A backup that has never been restored is not a backup.

> [!warning] **The table is no longer Postgres-only, but the key problem is still open (US-2659)**
> This callout used to say `scripts/ops/` had no storage restore script, no
> drill and no procedure here, and that nothing had ever read the photo mirror
> back. All three stopped being true on 2026-08-16 and the callout sat here
> saying otherwise until 2026-09-11. A warning that contradicts the section
> above it gets skipped, and then so does the half of it that is still true.
> Here is that half:
>
> [[key-rotation]] still records the rclone crypt password and salt as living in
> the *DB host rclone config*, and nowhere else. If that host is lost, which is
> the disaster an offsite mirror exists for, the config goes with it and every
> object in R2 is unreadable ciphertext. `restore-storage.sh` cannot help; it
> will stop with `failed to authenticate decrypted block - bad password?`. That
> is the exact mistake the age procedure above was written to avoid, since the
> Postgres identity is required to be off-host with a second offline copy.
>
> So the storage row below is evidence that the *procedure* works under a
> password you hold. It is not evidence that you will hold the real one.

> [!tip] Running it on Windows no longer needs a flag
> `restore-drill.sh` used to default to `age`, which is not packaged for Windows,
> so on the dev box it stopped with an error — after completing the pg_dump —
> and the fix was a sentence in its own header. It now prefers `age` and falls
> back to `rage` (format-compatible), announcing which it used. `AGE_BIN` still
> pins one where both exist. A drill is the thing people run rarely and under
> stress; a documented workaround is not a working default.

## Related

- [[deploy]] — take a backup before any forward-only migration
- [[rollback]] — migrations are forward-only, so DB rollback means restore
- [[data-retention]] — what a backup may legally still contain
- [[moc-ops]]
