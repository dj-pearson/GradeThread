---
title: Operator tables and the rls-guard discovery rule
aliases: [SERVICE_ROLE_ONLY, rls-guard, operator tables]
type: contract
status: current
source_of_truth: code
code_refs:
  - services/edge-functions/src/tests/rls-guard_test.ts
reviewed: 2026-08-07
tags: [security, rls, tenant-isolation, contract]
summary: rls-guard discovers tenant tables by regex on the CREATE TABLE block, so an operator table must be registered AND must avoid the literal token user_id.
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

> [!tip] Two owner columns? Drop `_user` entirely.
> `admin_impersonation_sessions` (US-2351) has both an actor and a target. The
> obvious names — `actor_user_id`, `target_user_id` — read fine and are wrong
> here, because they contain the literal token and force discovery on a table
> that must have no policy at all. They are `actor_id` and `target_id`. The rule
> is about the STRING, not the semantics.

## A table with NO owner column at all is not discovered — force it

Discovery only sees tables whose `CREATE TABLE` block carries an owner column.
Pure CONFIG — `job_locks`, `reward_quests` (US-1852) — has none, so it sails past
the guard entirely and a later commit could drop its RLS with nothing going red.

For those, register in **both** lists: `SERVICE_ROLE_ONLY` (the justification)
and `SERVICE_ONLY_FORCED` (which drags the table into the guard so the
RLS-enabled + zero-policy state is asserted rather than assumed). Being invisible
to the guard is not the same as being safe.

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
