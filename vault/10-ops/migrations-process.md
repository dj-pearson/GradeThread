---
title: Migration process
aliases: [MIGRATIONS, migration process]
type: runbook
status: current
source_of_truth: vault
code_refs: []
reviewed: 2026-09-03
tags: [ops, database, migrations]
summary: How migrations are authored, verified and applied to self-hosted prod.
---
# Database Migration Process (US-493)

Schema migrations must be applied to production **reliably and in order**, so the
deployed code never runs against a schema that's missing a column/table (the root
cause of the `/verified/*` + `/flipdesk/pricing/*` 500s).

## 🚨 Fast recovery: edge crash-looping on a stale DB (`npm run catchup`)

**Symptom** — the edge container won't boot and the site is down; logs repeat:

```
[schema-version] DB is STALE: applied=00256, this build expects 00282. Refusing to start.
```

This means prod's DB is behind the deployed edge build (a push redeployed edge
before the migrations were pasted into Studio). To recover, apply every migration
above `applied=NNNNN`. **One command builds that paste for you:**

```bash
npm run catchup -- 00256     # use the applied=NNNNN number straight from the log
```

It bundles every migration after `00256` into `scripts/prod-catchup-<today>.sql`,
**copies the SQL to your clipboard** (Windows), and prints the target version. Then:

1. Back up prod first (`vault/10-ops/backups.md`).
2. Supabase Studio → SQL editor → **paste** (clipboard) → Run.
3. Confirm the final `SELECT public.latest_schema_migration()` prints the target
   version. The edge boots clean on the next restart.

The bundle is idempotent and self-recording, so it's safe to re-run. You can pass
the number any way the log shows it — `00256`, `256`, or `applied=00256`.

> **Stop the bleeding for good:** run `npm run catchup`, paste into Studio, **then**
> `git push`. Applying migrations *before* the push means the edge never redeploys
> ahead of the DB, so it never crash-loops. (`generate the bundle` = `make-catchup.mjs`.)

## Where migrations live

`supabase/migrations/NNNNN_description.sql`, applied in lexical order. Each file
must be idempotent (`IF NOT EXISTS`, `ON CONFLICT DO NOTHING`,
`DO $$ ... IF NOT EXISTS ... $$`, `CREATE OR REPLACE FUNCTION`, and a
`DROP ... IF EXISTS` before every `CREATE TRIGGER` / `CREATE POLICY`).

This used to read "idempotent **where practical**", which was a hedge over an
unmeasured claim. It is measured now, and enforced by
`scripts/migrations-lint.mjs` (US-2837): a `CREATE FUNCTION` that is not
`CREATE OR REPLACE` fails at zero, and an unguarded `CREATE TRIGGER` /
`CREATE POLICY` fails above 00291.

> [!warning] The files at or below 00291 are NOT all re-runnable
> 48 `CREATE TRIGGER` and 251 `CREATE POLICY` statements across 61 early
> migrations have no `DROP ... IF EXISTS`, because the rule post-dates them.
> Re-applying one of those raises 42710 and aborts the rest of that file. They
> are grandfathered and counted rather than fixed: retro-editing 299 statements
> in migrations that production has already applied is a larger risk than the
> one it removes. **Read this before following the gap-fill loop below** — that
> loop's "re-applying an already-present one is safe" is true from 00292 up, and
> not before.

## Applying to production (gated runbook)

Self-hosted Supabase exposes Postgres directly, but not on a public port — it
runs in a Coolify container, which is why the Studio-paste loop existed. Since
US-3113 there is a direct path that needs no connection string and no browser:

```bash
# 1. Read-only. Asks prod which versions it has recorded and diffs the repo.
npm run migrate:prod

# 2. Backs up with pg_dump, applies pending files in order, stops at the first
#    failure, then sends NOTIFY pgrst, 'reload schema'.
npm run migrate:prod -- --apply --yes

# 3. Redeploy the edge on Coolify, then re-test what depends on the new schema:
curl -fsS https://functions.gradethread.com/api/grading/public | jq .
```

It reaches the database over ssh (`PROD_SSH_HOST`) and finds the right container
by asking each Supabase stack on the host whether it carries our marker tables,
so no host or container id lives in the repo. `--apply` alone does nothing;
`--yes` is a second, deliberate flag. `--check` exits non-zero when anything is
pending, which makes it usable as a gate.

`PROD_SSH_HOST` is read from the shell or from the gitignored repo-root `.env`,
with the shell winning. Setting `PROD_DB_CONTAINER` there too skips discovery,
which saves one ssh round trip per container on the host.

> [!important] It compares by membership; `apply-prod-migrations.sh` compares by maximum
> The shell script skips every file at or below the highest recorded version, so
> a gap BELOW that maximum is never re-applied. That is exactly how
> `listings.draft_id` from 00134 stayed missing in production for months while
> every version above it was recorded (US-2726, US-2832). `npm run migrate:prod`
> checks each file against the full `applied_migrations` set instead, so it sees
> the hole. Read the grandfathering warning above before applying anything at or
> below 00291.

The older paths still work and are still correct where a connection string is
available: `SUPABASE_DB_URL="…" ./scripts/apply-prod-migrations.sh`, or pasting
into the Studio SQL editor for a one-off. Every migration **self-records its own
version** (footer below), so the guard stays in sync whichever route is used —
**as long as the apply happens before the edge redeploys.** When a push
redeploys edge first, use the `npm run catchup` recovery at the top of this doc.

Record each production apply (date, migrations applied, operator) in the deploy
log / incident channel.

## Self-recording footer (US-1108 — the fix for stale-guard catchups)

Every migration `00255+` MUST end with this footer, so applying it by ANY method
(Studio paste, `psql -f`, the apply script, or the Supabase CLI) records its
version into `public.applied_migrations` — the table `latest_schema_migration()`
reads alongside the CLI's `supabase_migrations.schema_migrations`. This is what
stops the edge refusing to boot against a "stale" DB when the apply path didn't
write a tracker row. The footer makes the catchup *correct* without a separate
backfill; `npm run catchup` (top of this doc) is still how you *recover* when a
deploy outpaces the Studio paste.

```sql
-- self-record (US-1108): keeps the edge schema-version guard (US-778) in sync no
-- matter how this migration is applied. Version = this file's NNNNN prefix.
INSERT INTO public.applied_migrations (version) VALUES ('00255')
ON CONFLICT (version) DO NOTHING;
```

A CI guard (`services/edge-functions/src/tests/schema-version_test.ts`, in
`verify:edge`) fails the build if a migration after `00254` omits it. The footer
writes ONLY to `public.applied_migrations` (never the CLI's table), so it can't
collide with `supabase db reset` in the local `verify:db` lane.

> [!danger] A RECORDED VERSION IS NOT EVIDENCE THE MIGRATION TOOK EFFECT
> This is the belief the footer invites, it has been written down as a proof more
> than once, and on **2026-08-17 it was false in production**: `00611` was in
> `applied_migrations` while all six functions it rewrites still answered an
> anonymous caller — measured, with `revenue_dashboard` refusing on the same
> database in the same minute as a control.
>
> The reasoning was "the footer is the LAST statement, so a failure aborts before
> anything is recorded". That holds **only under `ON_ERROR_STOP=1`**. Without it
> psql prints the error, carries on, and reaches the footer anyway — so the
> version records and nothing else did. A Studio paste has the same property.
>
> There is a second route to the same state, and it needs no failure at all:
> `CREATE OR REPLACE FUNCTION` only replaces a function with the **same argument
> list**. A different signature creates a second **overload**, leaves the
> original live, and every statement succeeds. (00609's own header records this
> trap in the other direction — it drops the old 6-argument signature precisely
> to avoid it. As of US-2837 that file reads `DROP` + `CREATE OR REPLACE`, not
> `DROP` + `CREATE`: the drop is what stops the overload, and the `OR REPLACE`
> is what lets the file be run twice. Both halves are load-bearing and they are
> not in tension, which the original header did not say.)
>
> **So the footer proves the file was RUN, never that it WORKED.** Two habits
> follow, and both are cheap:
>
> 1. **Always `-v ON_ERROR_STOP=1`.** It is what makes the recorded version mean
>    anything at all.
> 2. **Make the migration assert its own effect before the footer.** 00611-00613
>    each end with a `DO` block that raises if the change is not present, naming
>    the offending signature. Under `ON_ERROR_STOP` the raise aborts and the
>    version is never recorded; without it the operator still gets a loud error.
>    A migration that *can* be recorded without having landed is worse than one
>    that fails, because the record is what everyone trusts afterwards.
>
> And prefer a check that reads the **effect** over one that reads the version:
> for a permission change, an unauthenticated request to the endpoint answers the
> question from outside with no console at all.

## CI validation (drift + clean-apply)

`.github/workflows/*` should fail a deploy when migrations don't apply cleanly on
a fresh schema. The check: spin up `postgres`, apply every migration in order
with `ON_ERROR_STOP=1`. A migration that references a column a prior migration
didn't create fails here, not in prod.

> [!todo] **MANUAL / FOLLOW-UP:** wire `scripts/check-migrations.sh` (clean-apply on a
> throwaway Postgres service container) into CI as a required check.

## Schema-version assertion at edge boot (US-778 — DONE)

The edge service refuses to start against a **stale** DB. At boot
`assertSchemaVersion()` (`services/edge-functions/src/lib/schema-version.ts`)
compares a hardcoded `EXPECTED_SCHEMA_VERSION` to the latest applied migration,
read via the `public.latest_schema_migration()` RPC (a `SECURITY DEFINER`
bridge to `supabase_migrations.schema_migrations`, migration 00126):

- **Behind in production** → logs expected-vs-actual and exits non-zero (Coolify's
  restart loop makes the bad deploy loud).
- **Behind in dev** → warns only.
- **Migrations table unreadable / not recorded** → warns and proceeds
  (fail-OPEN; only a *confirmed* behind-version is fatal).

> [!important] **THE RULE:** every commit that adds a `supabase/migrations/NNNNN_*.sql` file
> MUST bump `EXPECTED_SCHEMA_VERSION` to that same `NNNNN` in the same commit.
> A CI sync-check (`src/tests/schema-version_test.ts`, in `verify:edge`) fails the
> build if the constant doesn't equal the lexically-last migration prefix, so it
> can't silently go stale.

> [!warning] **PROD APPLY NOTE:** for the assertion to be *active* in prod, the apply path
> must record versions into `supabase_migrations.schema_migrations` (the Supabase
> CLI does this automatically; a raw `psql -f` loop does NOT — add the version
> rows, or prefer the CLI). If it isn't recorded the check simply fail-opens.

### The max hides a hole — ask /health/ready for the SET (US-2603)

`applied` in the boot log and in the `/health/ready` schema block is a
**maximum**, and a maximum cannot see a gap beneath it. Apply `00606` while
`00605` never ran and every version check reports `match` forever, because the
watermark only moves forward.

> [!danger] It found one on its first read, and the file that had ruled it out
> Deployed 2026-08-15. The first response from the new image was
> `{"expected":"00606","applied":"00606","status":"match","missing":["00594"]}`.
> `00594_flipdesk_overview_metrics.sql` had never run, so
> `public.flipdesk_overview_metrics` did not exist and the FlipDesk Overview page
> was failing for every seller (US-2606).
>
> The part worth carrying: `PENDING_MIGRATIONS.md` had marked 00594 **applied**
> the day before, reasoning that the version sits *below* the recorded maximum
> and its file carries a self-recording footer, so it must have run. Both clauses
> true, conclusion false — and that same file warned against that exact inference
> 160 lines earlier. Being able to state the rule is not the same as not using
> it. **A version below the maximum is evidence of nothing.**

That is not a thought experiment. On **2026-08-15** prod reported
`{"expected":"00603","applied":"00606","status":"ahead"}` while only *some* of
`00604`-`00606` had actually been run, and the only way to find out which was a
psql session against prod.

`/health/ready` now answers it, unauthenticated, in one GET:

```bash
curl -fsS https://functions.gradethread.com/health/ready | jq .schema
# { "expected": "00606", "applied": "00606", "status": "incomplete",
#   "missing": ["00605"] }        <- versions in this build, absent from the DB
```

`status` was `"match"` in that shape until US-2620, because both versions are
maxima and the max comparison genuinely was satisfied. Publishing it that way
was still wrong: [[launch-checklist]]'s "All migrations applied" row sends an
operator to `status`, and it said the schema was fine while the same object
named a migration missing from it. **A hole under the maximum now outranks the
version relation** and reports `incomplete`. Only `match` is overridden —
relabelling `behind` or `unknown` would hide a worse finding behind a milder
word, which is this same bug inverted.

- **`missing`** — never applied. Apply those files, in order.
- **`unexpected`** — recorded with no such file in this build (a rollback, or a
  deploy from a branch). Do **not** "fix" it by applying anything. `00479` is
  excused by name (`KNOWN_PHANTOM_VERSIONS` in `schema-version.ts`): it was never
  authored, which is why `00480` onward were numbered around it, and a field that
  is never empty is a field nobody reads. That list is written by hand rather
  than derived from `migrations-lint`'s `KNOWN_GAPS`, because `KNOWN_GAPS` also
  holds `00527` — the security migration parked as `.BLOCKED` — and 00527 showing
  up as applied is the one thing this field must scream about.
- **`complete: false`** — the applied set could not be read. That is *we do not
  know*, not clean, and it is deliberately a different shape from an empty
  `missing`.
- Neither finding affects `ready`. A diagnostic that can pull the container out
  of rotation is a worse bug than the blind spot it closes.

The read is cached ~60 s, so the uptime monitor pays for one query a minute and
an operator still sees a fresh answer within a tick. It is **not** a boot-time
snapshot: the case it exists for is a migration applied or skipped while the
container is up.

> [!warning] The `generate_series` backfill below fills EVERY version in the
> range, including ones that never ran. Read `.schema.missing` first — backfill
> over a real gap is exactly the "masks the real gap" column of the table above.

### The trap: creating the tracker arms the guard

Fail-open and fatal are not two settings — they are the **same guard with and
without a tracker table**. Prod ran for a long time with no
`supabase_migrations.schema_migrations` at all (`42P01`), so a hand `psql -f`
apply silently skipped files and the guard warned rather than blocked. Real drift
hid behind that: functions from `00126` and `00148` absent while tables from
`00212`/`00220`/`00228` existed, surfacing as a 404 on an RPC, a 400 on a
`listings` select, and 500s on two FlipDesk routes.

Creating the tracker to fix that **arms the guard**, and the next deploy
crash-looped on `applied=00231, this build expects 00249`. Nothing regressed —
the DDL was current and the *tracker* lagged, because hand-applying runs the DDL
without inserting version rows.

So when the guard says STALE, establish which of two states you are in before
acting:

| | DDL missing | DDL present, tracker lagging |
|---|---|---|
| Fix | apply the migrations (`npm run catchup`) | backfill the version range only |
| Do **not** | backfill — it masks the real gap | re-apply DDL or reload the schema |

**Verify the top migration's objects actually exist before backfilling.** That
check is the entire difference between the two columns, and skipping it converts
a visible outage into a silent one.

Backfill form:

```sql
INSERT INTO supabase_migrations.schema_migrations(version)
SELECT lpad(g::text, 5, '0') FROM generate_series(<first>, <last>) g
ON CONFLICT DO NOTHING;
```

After any hand-apply, also run `NOTIFY pgrst, 'reload schema';` — PostgREST
caches the schema and will keep 404ing a new RPC until it does.

### The grace window, and the gate that would make it unnecessary

A migration and an edge roll are separate steps ([[deploy]]), so the container
can boot moments before the SQL lands. The guard therefore re-polls across a
grace window before declaring fatal — `SCHEMA_GUARD_GRACE_ATTEMPTS` (8) ×
`SCHEMA_GUARD_GRACE_DELAY_MS` (5000), about 40s, tunable without a redeploy. A
race becomes a delayed boot; a genuinely forgotten migration still ends in the
same loud fatal.

That is the safety net. The root fix — wiring `npm run migrate:prod` as the
edge's Coolify **Pre-deployment Command**, so a failed migration aborts the
rollout and the old container keeps serving — is a one-time ops setup that is
**still pending**; see [[deploy]] step 3 and [[blocked-work-gates]].

## One-time backfill: confirm 00057–00074 (and 00094–00097) are applied

The audit found 00057–00074 may be unapplied in prod. Verify and apply:

```bash
psql "$SUPABASE_DB_URL" -c \
  "select count(*) from supabase_migrations.schema_migrations where version between '00057' and '00097';"
```

If rows are missing, apply the gap with the loop above. Re-applying an
already-present file is safe from 00292 up; **below that, check it first** —
these are exactly the versions carrying the grandfathered unguarded
`CREATE TRIGGER` / `CREATE POLICY` statements described under "Where migrations
live", and one of those aborts the file with 42710 partway through. The new
production-ops migrations
**00094 (job_locks), 00095 (email_deliveries), 00096 (feature_flags), 00097
(integrity constraints)** must be applied before the new crons/kill-switches work.

## Rollback

Migrations are forward-only. To revert a bad schema change, write a new
compensating migration. For a catastrophic bad migration, restore from backup
(see `vault/10-ops/backups.md` + `vault/10-ops/rollback.md`).

## Why `PENDING_MIGRATIONS.md` is NOT in the vault

Decided during US-2051. `PENDING_MIGRATIONS.md` is **3,830 lines** — the largest
markdown file in the repo by roughly 6× — and it was deliberately left at the
repo root.

It is a **mutable work queue**, not durable knowledge. Rows are appended as
migrations are written and removed as they are applied to production; the file's
value is entirely in its current contents, and nothing in it is true a month
later. That is the opposite of what a vault note is for.

Two concrete reasons it would make the vault worse:

- **It would blow the retrieval budget.** The index is capped at 400 lines
  precisely so an agent reads one page and stops. A 3,830-line queue in the
  knowledge surface is 10× the entire index, for content that changes weekly.
- **The drift guard has nothing to say about it.** `reviewed` is meaningless for
  a file whose whole purpose is to change; it would generate a permanent warning
  nobody can action, which is how a review queue loses credibility.

The *process* for handling pending migrations belongs here. The *queue* stays
where the work is. Do not revisit this without a reason that addresses both
points above.

## Related

- [[deploy]] — migrations are the first step of the deploy order
- [[backups]] — take one first; migrations are forward-only
- [[moc-ops]]
