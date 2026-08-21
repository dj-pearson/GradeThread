---
title: Operator tables and the rls-guard discovery rule
aliases: [SERVICE_ROLE_ONLY, rls-guard, operator tables]
type: contract
status: current
source_of_truth: code
code_refs:
  - services/edge-functions/src/tests/rls-guard_test.ts
reviewed: 2026-08-21
tags: [security, rls, tenant-isolation, contract]
summary: rls-guard discovers tenant tables by regex on the CREATE TABLE block, so an operator table must be registered AND must avoid the literal token user_id; the same file also enforces the (select auth.uid()) initplan form, with a two-entry exemption list that carries repayment triggers.
---

# Operator tables and the rls-guard discovery rule

`rls-guard_test.ts` auto-discovers tenant tables by matching `\buser_id\b`
against each table's `CREATE TABLE` block, then asserts every discovered table
either has a restrictive RLS policy **or** is named in `SERVICE_ROLE_ONLY`.

An **operator table** carries no tenant data — config caches and ops bookkeeping
like `garment_baselines`, `grading_exemplar_sets`, `abuse_signals`,
`content_moderation_flags`. It is deny-all: RLS on, `revoke insert, update,
delete from anon, authenticated`, and zero policies.

> [!tip] The function-side counterpart
> This note is about TABLES. For `SECURITY DEFINER` functions the edge calls,
> see [[admin-rpc-guards]] — `is_admin()` is always false for the service role,
> so a bare `is_admin()` guard rejects every call the edge makes.

> **Re-reviewed 2026-08-21.** Drift flagged `rls-guard_test.ts`. The change is
> one new entry in `SERVICE_ROLE_ONLY` — `identification_provenance` (US-2774,
> migration 00641) — added by following the two rules below rather than by
> changing them: it owns an `owner_user_id` and keeps the literal token out of
> its `CREATE TABLE` block. The rule this note states did not move.

## Two things to get right when adding one

**1. Register it in `SERVICE_ROLE_ONLY`** with a one-line justification, or the
guard fails with *"no RLS policy and not in SERVICE_ROLE_ONLY"*.

**2. Keep the literal token `user_id` out of the `CREATE TABLE` block — including
comments.**

This is subtler than it looks and is the part people get wrong:

- `owner_user_id` / `subject_user_id` as a **column name** does **not** match.
  `_` is a word character, so `\buser_id\b` finds no boundary.
- A **comment** like `-- (NOT user_id) ...` **does** match, and forces discovery.
  The table is then treated as user-owned data and the guard demands an RLS
  policy it should not have.

So name the owning column `owner_user_id` or `subject_user_id`, and resist the
urge to explain in a comment that the table has no `user_id` — saying the words
is what triggers it.

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

> [!tip] Two owner columns? Drop `_user` entirely.
> `admin_impersonation_sessions` (US-2351) has both an actor and a target. The
> obvious names — `actor_user_id`, `target_user_id` — read fine and are wrong
> here, because they contain the literal token and force discovery on a table
> that must have no policy at all. They are `actor_id` and `target_id`. The rule
> is about the STRING, not the semantics.

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

`INITPLAN_EXEMPT` is the escape hatch, and it exists for one specific trade
rather than for convenience. Both current entries share the same three facts:
the table holds a handful of rows per user, so the planner win is single-digit;
the migration is already applied and therefore immutable, so the correct form
needs a NEW migration; and RLS DDL cannot be validated without Docker, so that
migration would ship unverified.

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

**Do not add a third entry to silence a hot table.** If the table is read many
rows at a time, the exemption's reasoning does not apply to it and the answer is
the migration.

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
