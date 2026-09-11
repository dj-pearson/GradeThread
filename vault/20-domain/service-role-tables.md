---
title: Operator tables and the rls-guard discovery rule
aliases: [SERVICE_ROLE_ONLY, rls-guard, operator tables]
type: contract
status: current
source_of_truth: code
code_refs:
  - services/edge-functions/src/tests/rls-guard_test.ts
  - services/edge-functions/src/tests/service-role-grant-posture_test.ts
reviewed: 2026-09-11
tags: [security, rls, tenant-isolation, contract]
summary: rls-guard discovers tenant tables by regex on the CREATE TABLE block - any column ending in user_id or owner_id - so an operator table must be registered in SERVICE_ROLE_ONLY; the same file also enforces the (select auth.uid()) initplan form, with a five-entry exemption list whose entries fall into two DIFFERENT cases - a negligible table, and a policy already superseded by a corrective migration. Of the two layers an operator table is supposed to have, only RLS-with-zero-policies is load-bearing: 88 of the 142 registered tables carry no REVOKE at all, so service-role-grant-posture_test.ts fails any of them that gains a policy while its grant is open.
---

> **Re-reviewed 2026-09-11.** Drift flagged `rls-guard_test.ts` for US-3334,
> which registered one new operator table, `grading_reference_photos`, in
> `SERVICE_ROLE_ONLY` twice over: once as deny-all (which customer photos may
> be shown to a grader is an operator decision behind step-up and audit) and
> once as having no owner column, being keyed through `submission_images` and
> `grade_reports`. That is this note's rule being FOLLOWED, not changed. No
> discovery regex, no exemption entry and no initplan rule moved, and the note
> states no count that a new entry could falsify. Re-read against the diff:
> still accurate.

# Operator tables and the rls-guard discovery rule

`rls-guard_test.ts` auto-discovers tenant tables by matching an owner column
against each table's `CREATE TABLE` block (and against any later
`ALTER TABLE … ADD COLUMN`), then asserts every discovered table has RLS enabled
and either carries a restrictive policy **or** is named in `SERVICE_ROLE_ONLY`.

The pattern is `OWNER_COLUMN = /\b\w*user_id\b|\b\w*owner_id\b/i`: **any column
whose name ENDS in `user_id` or `owner_id`**, not the bare token.

An **operator table** carries no tenant data: config caches and ops bookkeeping
like `garment_baselines`, `grading_exemplar_sets`, `abuse_signals`,
`content_moderation_flags`. It is deny-all: RLS on, zero policies, and ideally
`revoke ... from anon, authenticated` as well.

**That last clause is aspiration, not description, and the section below is
the measurement.** This note used to state the revoke as part of the definition.
Most operator tables do not have one.

## Which of the two layers is load-bearing (US-3350, measured 2026-09-11)

**RLS with zero policies is the layer that is holding. The grant is not a second
layer on most of these tables, because most of them never revoked anything.**

Counted over all 785 migrations:

| | tables |
|---|---|
| registered in `SERVICE_ROLE_ONLY` | 142 |
| ... of which carry NO table `REVOKE` anywhere in their history | **88** |
| tables carrying a table `REVOKE` against anon/authenticated | 83 |
| ... `revoke all` (SELECT gone too) | 64 |
| ... `revoke insert, update, delete` (public read on purpose) | 19 |

Those 88 hold all seven privileges for both `anon` and `authenticated`, granted
at `CREATE TABLE` by the `ALTER DEFAULT PRIVILEGES` entries the Supabase image
installs for `postgres` and `supabase_admin` in schema `public`. Nothing revoked
them. They are unreachable today only because RLS is on and there is no policy,
and **that is one layer, not two**. One `create policy` in a future migration is
the whole distance between "deny-all" and "world-readable", which is what
`service-role-grant-posture_test.ts` now fails on.

### The 83 revokes DID hold on prod. The local stack is where they look broken.

A finding on 2026-09-11 reported `anon` and `authenticated` holding all seven
privileges on `marketplace_supply_cells`, `marketplace_supply_samples`,
`comp_condition_reads` and `job_locks` despite their migrations revoking them.
That is true of the local stack, true of all 83 tables there, and **an artifact
of the local stack rather than a property of the migrations.**

The two integration workflows (`tenant-isolation.yml`, `money-cert-integration.yml`)
run `GRANT ALL ON ALL TABLES IN SCHEMA public TO anon, authenticated, service_role`
before seeding, and CLAUDE.md tells operators to run that same block locally. It
re-grants every revoke in the schema.

The ACL ordering is the proof, and it is free to re-take:

- 64 of 64 `revoke all` tables have `anon` positioned **after** `service_role`
  in `pg_class.relacl`, the signature of an entry removed and later re-added.
- 19 of 19 write-only-revoke tables keep the default order, because a partial
  revoke leaves the entry in place and a later `GRANT ALL` refills it.
- 277 of 277 tables with no revoke keep the default order. There are no
  exceptions in either direction.

On **production**, read credential-free through PostgREST's OpenAPI document
with the anon key, exactly 65 of the 367 public relations are absent, and 64 of
those 65 are the `revoke all` tables. The 65th is `grading_reference_photos`
(00789), which prod has not applied. Every one of the 19 write-revoke tables is
present, which is correct: they kept `SELECT` on purpose.

> [!warning] What that prod read does NOT cover
> PostgREST emits `get/post/patch/delete` for every table it lists regardless of
> privilege, so the document says nothing about whether the 19 write-only
> revokes held, or whether `anon` holds INSERT/UPDATE/DELETE on the 64. Only the
> `SELECT` half is readable this way. The rest needs an operator query, in
> [[migrations-process]] terms a pure read:
> `select grantee, table_name, privilege_type from information_schema.role_table_grants where table_schema='public' and grantee in ('anon','authenticated') order by 2,1,3;`

### Table revokes are safe on this image. FUNCTION revokes are not.

`memory/no-revoke-in-new-migrations.md` and 00609's "DELIBERATELY NO REVOKE"
block forbid a revoke because a denied call segfaults the backend. **That is a
statement about functions, and it does not extend to tables.** Both halves
measured back to back on `supabase_db_gradethread` on 2026-09-11:

- denied `select` and `update` as `anon`/`authenticated` on a revoked table:
  clean `ERROR: permission denied for table`, the supautils `HINT: Grant the
  required privileges ...` appended, server untouched, crash markers in the
  container log 3 before and 3 after.
- `node scripts/db-denied-rpc-crash-check.mjs` on the same container minutes
  later: connection dropped mid-statement, a backend-crash line in the log, and
  every other session terminated.

So the 83 table revokes are not a latent crash surface and should stay. The
no-revoke rule keeps its full force over `REVOKE ... ON FUNCTION`.

> [!tip] The function-side counterpart
> This note is about TABLES. For `SECURITY DEFINER` functions the edge calls,
> see [[admin-rpc-guards]] — `is_admin()` is always false for the service role,
> so a bare `is_admin()` guard rejects every call the edge makes.

> **Re-reviewed 2026-09-10.** Drift flagged `rls-guard_test.ts` for five new
> entries across three stories. `marketplace_supply_cells` and
> `marketplace_supply_samples` (US-3132, migration 00745, in **both** lists
> because neither has an owner column), `cloud_storage_oauth_states` (US-3159,
> 00766) and `phone_capture_sessions` / `phone_capture_photos` (US-3161, 00767).
> All five follow the rules below rather than bending them.
>
> ⚠ **Re-reading the file turned up something four earlier re-reviews missed.**
> This note said discovery matched `\buser_id\b`, and that `owner_user_id` and
> `subject_user_id` therefore slipped past it. **That stopped being true on
> 2026-07-18**, when US-2008 widened the pattern to
> `/\b\w*user_id\b|\b\w*owner_id\b/i` precisely because the underscore hole had
> left 21 owner-column tables unchecked. The naming advice this note gave (call
> the column `owner_user_id` to dodge discovery) was advice to do the thing the
> guard now catches. Rule 2 below is rewritten; nothing else in the note
> depended on it, because every table it names is registered in
> `SERVICE_ROLE_ONLY` and so passes whether it is discovered or not.
>
> **Re-reviewed 2026-09-01.** Drift flagged `rls-guard_test.ts`. The change is
> one new entry, `garment_measurement_stats` (US-3033, migration 00709), added
> by following the "no owner column at all" rule below rather than by changing
> it: no owning column of any kind, deny-all, so it is registered in **both**
> lists. Its grain is `(brand, style, department, group, size, field)` and the
> row is a statement about a garment, not about whose closet the numbers came
> from. The observations behind it live in `garment_measurements`, an ordinary
> tenant table with four per-user policies, so identity stays exactly one table
> away from the published aggregate. The rule this note states did not move.
>
> **Gap found while doing it, not fixed here.** `help_article_views` is in
> `SERVICE_ROLE_ONLY` and NOT in `SERVICE_ONLY_FORCED`. It has no owner column
> either — that is the whole point of the US-2592 callout below — so by this
> note's own rule it is currently invisible to the guard, and dropping its RLS
> would go unnoticed. Confirming it is genuinely deny-all and adding it needs
> its own change; recorded here so the next reader does not assume the callout
> below finished the job.

> **Re-reviewed 2026-08-30.** Drift flagged `rls-guard_test.ts` again. The
> change is one new entry, `qbo_oauth_states` (US-2997, migration 00704), and
> it is the rules below working rather than bending: the OAuth CSRF state is
> single-use, self-expiring, deleted-and-returned in one statement at the
> callback, and the SPA never reads it. The connection and account-mapping
> tables beside it are ORDINARY tenant tables with per-user policies, because
> the status card reads them straight through PostgREST - only the state
> belongs behind the service role. Registering all three would have claimed the
> excuse for two tables that do not need it.

> **Re-reviewed 2026-08-21.** Drift flagged `rls-guard_test.ts`. The change is
> one new entry in `SERVICE_ROLE_ONLY` — `identification_provenance` (US-2774,
> migration 00641) — added by following the two rules below rather than by
> changing them. (Corrected 2026-09-10: this block used to say the table dodged
> discovery by naming its column `owner_user_id`. It does not. `owner_user_id`
> has matched since US-2008, so `identification_provenance` IS discovered and
> passes on its `SERVICE_ROLE_ONLY` registration alone.)

## Two things to get right when adding one

**1. Register it in `SERVICE_ROLE_ONLY`** with a one-line justification, or the
guard fails with *"no RLS policy and not in SERVICE_ROLE_ONLY"*.

**2. Expect the table to be discovered anyway, and do not try to dodge it.**

Since US-2008 (2026-07-18) the pattern is `\b\w*user_id\b|\b\w*owner_id\b`, so
`owner_user_id`, `subject_user_id`, `admin_user_id`, `seller_user_id` and a bare
`owner_id` **all** match. A synthetic test drives each of those five shapes
through the parser, so the widening cannot quietly narrow again.

Discovery is not the thing to avoid. A discovered table passes as long as RLS is
enabled and it is either policied or registered, and registering it is rule 1.
Two things still follow from the pattern:

- A **comment** like `-- (NOT user_id) ...` matches too. Comments are inside the
  `CREATE TABLE` block and nothing strips them, so a table with no owner column
  can be dragged into discovery by prose alone. Do not explain in a comment that
  the table has no `user_id`; saying the words is what triggers it.
- A name with no `user_id` / `owner_id` tail (`actor_id`, `target_id`,
  `article_slug`) is still invisible, which is the case the `SERVICE_ONLY_FORCED`
  section below exists for.

> [!note] A third case: nothing to scope to at all (US-2592, 2026-08-15)
> `help_article_views` registered without an owning column of any kind. Its grain
> is `(article, surface, day)` — no user id, no session, no IP — which is what
> lets a public help page increment it with no consent prompt.
>
> That is different from the usual operator table, which HAS an owner and simply
> is not read through RLS. Here a tenant policy has nothing to attach to, so
> asking for one is not a stricter version of the same thing, it is a category
> error. Register it, and say in the justification why the table holds no
> identity rather than only that it is operator-facing — otherwise the next
> reviewer reasonably asks for the policy the guard would have demanded.

> [!tip] Two owner columns? `admin_impersonation_sessions` named them plainly.
> `admin_impersonation_sessions` (US-2351) has both an actor and a target, and
> its columns are `actor_id` and `target_id` rather than `actor_user_id` /
> `target_user_id`. The migration's own comment says the choice was made to keep
> them out of discovery, and under the current pattern it still has that effect:
> `actor_user_id` would match `\b\w*user_id\b`, `actor_id` matches neither arm.
>
> Read it as history, not as a technique. Since US-2008 the honest move is a
> descriptive name plus a `SERVICE_ROLE_ONLY` entry; a table that dodges the
> regex is a table nothing checks.

### The case where the DATA is public and the table still must be deny-all

Added 2026-08-14 (US-2569). `grade_report_revisions` records every retired
certificate — number, score, tier — and all of that ends up rendered on a
**public** certificate page. The instinct is a permissive read policy, since
nothing in the row is secret.

It is deny-all anyway. The public certificate endpoint reads the chain
service-role and then re-applies `isCertificateWithheld` to the successor, so a
direct read policy would let anyone walk a revision chain to a grade that is
currently withheld for moderation. The revision trail would become the way around
the hold.

**The question is not "is this data secret" but "does the only correct read run a
check first".** `api_idempotency_records` (US-2563) is the same shape from the
other direction: `response_body` is the caller's own prior 2xx, not a secret
from them, but readable it would hand any authenticated session whatever another
tenant happened to have mid-retry.

## A table with NO owner column at all is not discovered — force it

Discovery only sees tables whose `CREATE TABLE` block carries an owner column.
Pure CONFIG — `job_locks`, `reward_quests` (US-1852) — has none, so it sails past
the guard entirely and a later commit could drop its RLS with nothing going red.

For those, register in **both** lists: `SERVICE_ROLE_ONLY` (the justification)
and `SERVICE_ONLY_FORCED` (which drags the table into the guard so the
RLS-enabled + zero-policy state is asserted rather than assumed). Being invisible
to the guard is not the same as being safe.

### The third case: no owner column, but it DOES have a policy

Added 2026-08-08 (US-2438). The pair above assumes deny-all, and the two lists
answer different questions, so a table can need one without the other.

`ai_prompt_versions` and `ai_prompt_block_versions` hold grading prompt text.
A prompt belongs to the platform, not to a user, so neither has an owner column
and neither was ever discovered — but they are not deny-all either: admins keep
`SELECT`, and only writes are service-role (US-2348, migration 00510, after the
original admin write grant let the SPA reach around the scope guard, the step-up,
the audit row and the eval gate).

So they belong in `SERVICE_ONLY_FORCED` **and not** in `SERVICE_ROLE_ONLY`.
`SERVICE_ROLE_ONLY` is the excuse for having zero policies; claiming it for a
table that has one would be false, and it would also switch off the very check
worth having here — that the surviving `SELECT` policy is not `USING(true)`.

The general form: **`SERVICE_ONLY_FORCED` is about COVERAGE, `SERVICE_ROLE_ONLY`
is about JUSTIFICATION.** Ask "would anything go red if this table's RLS
vanished?" first, and only then ask whether zero policies is the right shape.
`ai_prompt_versions` answered no to the first question for months after 00510
locked it down, because nobody asked it separately.

## The other guard in the same file: the initplan form (US-1927 AC1)

`rls-guard_test.ts` also asserts that every policy written since migration
**00451** uses `((select auth.uid()) = user_id)` rather than a bare
`auth.uid()`. The two forms are semantically identical — `auth.uid()` is
`STABLE` — but the bare one is re-evaluated **per row** while the wrapped one
hoists to a single InitPlan. On a large per-user scan that is the whole cost.

`INITPLAN_EXEMPT` is the escape hatch, and it exists for a specific trade
rather than for convenience. There are now FIVE entries and they fall into two
different cases, which matters because only the first is a judgement that the
bare form is acceptable.

**Case 1, the negligible table** (`00474_push_subscriptions.sql`,
`00588_extension_work_queue.sql`). Three facts together: the table holds a handful of
rows per user, so the planner win is single-digit; the migration is applied and
therefore immutable, so the correct form needs a NEW migration; and RLS DDL
cannot be validated without Docker, so that migration would ship unverified.
The trade is that shipping an unverifiable rewrite for a negligible gain is the
worse bargain.

**Case 2, superseded** (`00683_tax_profiles.sql`, `00684_ledger_accounts.sql`,
`00685_ledger_entries.sql`, added 2026-08-29 under US-3005). These are NOT a
judgement that the form is acceptable — it is not, and `ledger_entries` is the
sharpest counter-example in the schema, because the ledger derivation writes
**nine rows per completed sale**. All thirteen policies are rewritten correctly
by **00687**. They are listed only because this guard reads the SOURCE of every
migration file, so a later corrective migration cannot satisfy it, and the three
originals are immutable.

⚠ **The distinction is worth keeping straight when the next entry is proposed.**
Case 1 says "small table, leave it". Case 2 says "already fixed elsewhere". A
third case — "large table, not fixed" — has no entry and should not get one:
write the policy correctly instead.

## The connector tables (added 2026-08-18, recorded 2026-08-19)

The MCP connector work registered six more tables in `SERVICE_ROLE_ONLY` and
this note did not follow them, which is the drift the guard is for. All six are
deny-all in BOTH directions, and in each case the write side is the sharper
risk rather than the read:

| Table | Readable, it is | Writable, it would let a caller |
|---|---|---|
| `oauth_clients` | which integrations exist | register their own |
| `oauth_grants` | which sellers connected what, and when | mint a grant and skip the consent screen |
| `oauth_authorization_codes` | a short-lived exchange in flight | forge one |
| `oauth_refresh_tokens` | who holds long-lived access | issue themselves some |
| `oauth_access_tokens` | who is currently connected | impersonate a seller |
| `mcp_tool_calls` | every seller's connector activity: which items, when, how often | fabricate the record that exonerates them |

Secrets in the OAuth tables are stored hashed, so even a read is not a read of
credentials — it is a read of who authorized whom, which is its own disclosure.
The audit log is the one where writability is the whole point: an audit log a
caller can edit is not an audit log.

**`ebay_search_terms` (00622, US-2683) is deliberately NOT here.** It carries a
per-seller RLS SELECT policy, so a seller reads their own rows through the anon
key like any other tenant table. It is listed for contrast because it looks like
an operator table at a glance — written only by a cron, through the service-role
client — and it is not one. The test for that distinction is whether a SELLER
has any business reading it, and here they do: they are their own search terms.

| File | Table | Repay when |
|---|---|---|
| `00474_push_subscriptions.sql` | `push_subscriptions` | the next migration touching it |
| `00588_extension_work_queue.sql` | `extension_work_queue` | the next migration touching it — or **immediately** if it grows a per-user scan (a history view, an admin sweep) |

**Do not add an entry to silence a hot table.** If the table is read many rows
at a time, the exemption's reasoning does not apply to it and the answer is the
migration.

The three Case 2 entries are not in that table because they carry no debt:
`00683`, `00684` and `00685` are **already repaid** by 00687, which rewrites all
thirteen policies. They stay listed in `INITPLAN_EXEMPT` only because the guard
reads migration SOURCE and those three files are immutable. Nothing is owed and
nothing is waiting for a future migration.

⚠ `ledger_entries` is the case the paragraph above is warning about, and it went
in anyway — nine rows per completed sale, read a year at a time. It was caught
by this guard failing an unrelated push rather than by review, which is worth
knowing about how those three migrations were checked.

## Why discovery-by-regex rather than an explicit list

An explicit list of tenant tables would go stale the moment someone added a
table and forgot to list it — and the failure would be silent, which is the
worst property a security guard can have. Regex discovery fails **loudly** on
anything unrecognised, and pushes the cost onto the rare operator table instead
of the common tenant one. The awkward comment rule is the price of that trade.

## Related

- [[INDEX]]
- The procedure for scoping edge queries lives in the `tenant-isolation` skill;
  this note is the fact it operates on.
