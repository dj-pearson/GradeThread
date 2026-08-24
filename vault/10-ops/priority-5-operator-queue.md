---
title: Priority-5 operator queue
type: runbook
status: current
source_of_truth: vault
code_refs:
  - scripts/prod-diagnostics-console.sql
  - supabase/migrations/00527_revoke_public_function_execute.sql.BLOCKED
reviewed: 2026-08-21
tags: [operator, prod, priority-5, backlog]
summary: The priority-5 backlog is almost entirely code-complete and waiting on production actions only the owner can take; this is that queue, grouped by what you have to open.
---

# Priority-5 operator queue

Audited 2026-08-21. Of the 22 open priority-5 stories, **19 have their code
written and merged.** They are open because each ends in an `OPERATOR:` criterion
nobody has run yet. One needs a product decision before any code makes sense.

So the bottleneck is not engineering capacity. It is a queue of production
actions, and this is that queue, ordered so each session opens one thing.

> [!warning] An `OPERATOR:` criterion is not automatically correct.
> US-2284's told the owner to rotate a Chrome Web Store signing key that does
> not exist, and they went looking for the button before anyone questioned the
> instruction. These lines were written by whoever found the problem, often
> without access to the system they describe. Check the premise before spending
> an evening on the task.

Related: [[migrations-process]], [[key-rotation]], [[backups]].

## US-2284 — closed, and the instruction it carried was wrong

This story used to head the queue with "rotate the Chrome Web Store signing
key". **There is no such key to rotate**, and the owner lost time looking for
the control. Recording why, because the mistake is an easy one to repeat.

`extension.pem` is generated LOCALLY by Chrome's *Pack extension* button. It
signs a self-hosted `.crx` and derives an extension id from its public key. When
a ZIP is uploaded to the Web Store, **Google signs it with Google's key** and the
Web Store assigns the item id. The local pem never enters that path, which is
why the Developer Dashboard has no rotation control.

Three things would each have made the leak serious. Checked 2026-08-21, all
three negative:

| check | result |
|---|---|
| a `"key"` field in any manifest | **none** in `extension/`, `extension-condition/` or `extension-unified/`, so no shipping extension id derives from that keypair |
| an `update_url` in any manifest | **none**, so there is no self-hosted update channel to push a malicious update through |
| published to the store | **no** — US-1757 has not shipped |

The key signs nothing that exists. Resolution: treat it as burned, never pack
with it again, delete the local copy so a future *Pack extension* cannot pick it
up, and **do not rewrite git history** — that rewrites every open PR to scrub a
key which authorises nothing.

**At publish time (US-1757):** let the Web Store assign the item id and do not
add a `key` field to the manifest. Adding one would pin the published id to a
locally-held keypair and recreate exactly this exposure, for real.

What stays is the code half, which was always the durable part: the file
untracked, `*.pem`/`*.crx` gitignored, and a weekly full-history gitleaks sweep
at `.github/workflows/secret-scan-history.yml`. Per-push scanning cannot find a
secret already in history, which is why this sat green for a month.

**Closed out 2026-08-24.** That weekly sweep had gone red on all four runs it
had ever had, because the resolution above was recorded here but never applied
to the scanner. The finding is now allowlisted in `.gitleaks.toml`, scoped to
commit `e1dbc4da` **AND** path `extension.pem`, so committing a pem today still
fails. Full reasoning and the three re-checks live in the comment above the
stanza and in [[key-rotation]]. The stanza that had been left ready to
uncomment would not have worked: it named rule id `gitleaks-private-key` (the
rule is `private-key`) and sat inside the `[allowlist]` table, where it would
have swallowed the placeholder `regexes` list.

## One psql session against prod

Order matters for the first one only; the rest are independent.

**1. US-2403, and it gates two other stories.** Read-only, one line:

```sql
show supautils.hint_roles;
```

If `anon` is absent, the segfault does not reproduce here, US-2403 AC1 closes as
does-not-reproduce, and **00527 unblocks, which unblocks US-2282.** If `anon` is
present, stop and mitigate before anything else.

> **Do NOT confirm by calling a revoked function.** That call *is* the outage.

**2. US-2282, before and after 00527:**

```sql
SELECT proname, proacl FROM pg_proc
WHERE pronamespace = 'public'::regnamespace AND prosecdef;
```

**3. US-2287, two reads:**

```sql
SELECT pg_get_constraintdef(oid) FROM pg_constraint
WHERE conname = 'users_billing_source_chk';          -- expect it to contain googleplay
SELECT count(*) FROM public.users WHERE billing_source = 'googleplay';
```

A zero on the second is also what a still-broken constraint produces, so the
Play Console chain in the story is the load-bearing evidence, not the count.

**4. US-2729, the tail of 00627 only.** Both statements are idempotent:

- the `CREATE OR REPLACE FUNCTION style_code_sweep_candidates` block and its `GRANT`
- `CREATE INDEX IF NOT EXISTS inventory_items_style_code_idx`

then `NOTIFY pgrst, 'reload schema';`

> **Do NOT re-run the whole file.** Its `CREATE TRIGGER` at line 50 has no
> `DROP TRIGGER IF EXISTS` guard and will abort the way 00134 did.

**5. US-2347 and the money queries.** Run `scripts/prod-diagnostics-console.sql`.
It is read-only and runs with `ON_ERROR_STOP=1`, so a wrong column name cannot
kill your session. Two sections are the ones with money attached:

- **§19** feeds US-2288 (trials started vs converted, plus-tag and dot-normalised
  duplicate mailboxes, grading spend attributable to trials).
- **§20** feeds US-2289 and produces a **refund list**. Note that refunding a
  credit does not withdraw a public certificate; the section returns duplicate
  certificates separately for that reason.

**6. US-2662, if you have a shell there anyway.** Production GoTrue is
**v2.174.0** (already measured). What is still unknown is whether
`POST /admin/users/{id}/logout` exists on it, which decides whether stopping an
impersonation revokes anything at all.

Probe with the **service role** against a nil UUID, which matches no user so
nothing is revoked, and read the **body**, not the status:

```
POST /auth/v1/admin/users/00000000-0000-0000-0000-000000000000/logout
```

A GoTrue-shaped "user not found" means the route exists. A generic router 404
means it does not, and US-2351 AC2 is not true in production.

> Do not probe this with the anon key. Kong 401s before GoTrue routes at all, so
> a nonexistent control route answers 401 too and the reading is meaningless.

## Coolify and Cloudflare

Nothing outstanding. **US-2612 closed on 2026-08-21**: `/health/ready` now
reports the Pages-origin bypass as armed and proven from the other side, by
counting inbound requests carrying a valid `x-pages-origin`.

Two unrelated things that endpoint is currently reporting, neither a
priority-5 story:

- `release: unattributable` — no `RELEASE_SHA`/`COMMIT_SHA`/`SOURCE_COMMIT`/
  `GIT_SHA` holds a real commit, so Sentry errors cannot be tied to a build.
- `hostWatchdog: unconfigured` — an edge hang would not be capped. Install
  `scripts/ops/edge-watchdog.sh`.

## Dashboards, one visit each

| Story | Where | What to read |
|---|---|---|
| US-2286 | App Store Connect | Purchase history, for entitlements granted from a **sandbox** receipt. Pre-marker grants are NULL in the DB, so they cannot be found from SQL. |
| US-2337 | Sentry + PostHog | Users whose local item count dropped to zero. Correlate with the breadcrumbs `Sync reconcile aborted: tenant scope unresolved` and `Sync reconcile refused: prune requested under an unresolved tenant scope`. |
| US-2662 | Sentry | `GoTrue logout returned`, route `impersonation.revoke`. |
| US-2351 | Supabase auth config | The GoTrue OTP TTL. It sets the real lifetime of impersonation and resume tokens, so the 30-minute cap in code is only the shorter of the two. |
| US-2668 | Cron ledger, after deploy | Confirm trial-expiry answers 200 and report the first `downgraded` value. That number is the backlog: how many accounts held Pro past their trial end. |
| US-2658 | `item-photos` bucket | EXIF on a few Android-uploaded objects. Decides whether US-2658 is forward-looking only or needs a backfill. |
| US-2606 | The app, signed in | Load the FlipDesk Overview page. The migration is confirmed applied; the page rendering is not. |

## On the host

**US-2659 — the storage mirror's key lives on the host it protects.**

Move the rclone crypt password and salt off the DB host, take a second offline
copy, and record the location in [[key-rotation]] (**location, never value**).
Nothing in this repository can do this, and until it is done the offsite photo
mirror does not survive losing the host it backs up. The restore script and its
drill already exist at `scripts/ops/restore-storage.sh` and
`restore-storage-drill.sh`.

## The one that is not an operator task

**US-2288 — unlimited free trials.** Every new signup gets 14 days of Pro with no
card, no device fingerprint, no email-domain check and no prior-trial lookup.
Delete the account, sign up again, get another 14 days.

Its AC1 deliberately refuses to pick an abuse control until §19 has been run,
and that is the right call: the correct control at two abusers is a different
control from the correct one at two hundred. Run §19, then decide between

- card-on-file for the trial,
- a prior-trial record keyed on something that survives account deletion, or
- a hard cap on trial grading volume, independent of the plan's allowance.

Then it becomes ordinary engineering.
