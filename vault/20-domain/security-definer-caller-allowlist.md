---
title: SECURITY DEFINER functions — the caller allowlist
aliases: [anon rpc exposure, auth.role allowlist, 42501]
type: contract
status: current
source_of_truth: code
code_refs:
  - supabase/migrations/00614_analytics_rpc_allowlist.sql
  - supabase/migrations/00615_credit_functions_service_role_only.sql
  - supabase/migrations/00616_sql_functions_service_role_only.sql
  - supabase/migrations/00610_revenue_dashboard_trial_cohort.sql
  - src/test/permissive-admin-guard.test.ts
reviewed: 2026-08-17
tags: [security, postgres, rpc, contract]
summary: A SECURITY DEFINER function bypasses RLS, so its only protection is what it checks itself — and the check must be a positive allowlist, because the obvious negative one lets anonymous callers straight through.
---
# SECURITY DEFINER — the caller allowlist

A `SECURITY DEFINER` function runs as its owner and **bypasses RLS**. PostgREST
exposes every one of them at `/rest/v1/rpc/<name>`. So the only thing standing
between an anonymous caller and the function's body is what the function checks
about its caller.

## The guard, and the one that looks like it

```sql
-- ✅ CORRECT — a positive allowlist.
if not (auth.role() = 'service_role' or public.is_admin()) then
  raise exception '<fn>: service role required' using errcode = '42501';
end if;

-- ❌ WRONG — and it shipped on six functions.
if auth.uid() is not null and not public.is_admin() then
  raise exception '<fn>: admin role required' using errcode = '42501';
end if;
```

**An anonymous caller has no `auth.uid()`.** The second condition is therefore
false, no exception fires, and the document is returned. It only ever constrained
users who were signed *in* — the population least likely to be the attacker. It
reads as a real check, which is why it passed review six times.

## Three defect shapes, all found 2026-08-17

| Shape | Count | Fixed by |
|---|---|---|
| Guard present but negative (above) | 6 | `00614` |
| No guard at all — relied on the grant | 9 | `00615` |
| `LANGUAGE sql`, so no block to raise from | 2 here, 4 in `00611` | `00616` |

All were measured against production with the anon key that ships in the browser
bundle, not inferred: real AI spend, retention cohorts, budget rows, **customer
email addresses** (`reconciliation_candidates`), and the demonstrated credit
exploit — an anonymous caller moving a balance `0 → 999`.

## Why an allowlist and never a REVOKE

Tightening the GRANT is the obvious fix and is **not available here**:

- `REVOKE … FROM anon` is a **no-op**: the `CREATE FUNCTION` grant to PUBLIC
  survives it and every role belongs to PUBLIC.
- A **denied** call from `anon` or `authenticated` restarts the database on this
  Postgres image (US-2403), so a revoke that *did* work would hand out a restart
  button.

Both are established in [[postgres-revoke-from-anon-is-a-noop]], which is also
why `00527_revoke_public_function_execute.sql` is a permanent **DO NOT APPLY** —
an owner decision, not a hold on this work.

A body check raises an ordinary error, so it arms neither problem.

## Rules for a new SECURITY DEFINER function

1. **Positive allowlist**, in the words above. Name the function in the message —
   several share the shape, and a bare "service role required" does not say which
   call was refused.
2. **`LANGUAGE plpgsql`.** Plain SQL has no block to raise from. Converting later
   is a body rewrite; starting there is free.
3. **Check who calls it from SQL, not just from TypeScript.** `auth.role()` reads
   the *session* claims and `SECURITY DEFINER` does not change them, so a guarded
   function called from inside another function evaluates the guard in the
   original caller's role. Exactly one such path exists today (`refund_grade` →
   `refund_buyer_reward_credit`) and it is service-role only.
4. **Some functions must stay open.** `peek_workspace_invitation` is called from
   the browser *before* the user has an account, gated by a capability token
   rather than identity. A role check would break invitation acceptance.

`src/test/permissive-admin-guard.test.ts` fails any migration at or after `00614`
that uses the negative form, and pins the guard counts per migration.

## What this does NOT cover

The table layer, which is separately clean: 289 tables in `public`, none with RLS
disabled, and only five with a blanket anonymous `SELECT` — all public content
(blog links, author bylines, help categories, the two pricing tables). Read from
`pg_class`/`pg_policies`, which are schema state and so unaffected by the
tenant-isolation fixture's blanket GRANT that contaminated function-privilege
readings the same day.

## Related

- [[postgres-revoke-from-anon-is-a-noop]] — why the grant route does not work
- [[migrations-process]] — a recorded version is not evidence a migration worked
