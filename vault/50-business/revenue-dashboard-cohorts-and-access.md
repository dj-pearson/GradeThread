---
title: revenue_dashboard — the trial cohort key and who may call it
aliases: [revenue_dashboard, trial cohort]
type: contract
status: current
source_of_truth: code
code_refs:
  - supabase/migrations/00610_revenue_dashboard_trial_cohort.sql
  - supabase/migrations/00215_revenue_dashboard.sql
  - supabase/migrations/00608_exclude_sandbox_from_revenue.sql
  - scripts/check-rpc-column-refs.mjs
reviewed: 2026-08-17
tags: [revenue, metrics, security, postgres]
summary: The trial cohort keys on created_at, not on a derived start date, and the function authorises by allowlist rather than by grant. Both because it shipped broken in 00215 and the break was the only thing hiding a leak.
---
# revenue_dashboard — cohorts and access

`public.revenue_dashboard(p_start, p_end, p_granularity)` is the admin revenue
document: MRR, ARR, ARPU, plan mix, movement, trial conversion, credit packs.
`admin_revenue_metrics` is a **different** function covering the snapshot half;
the two are not interchangeable and only one of them worked until 2026-08-16.

## It had never worked, from 00215 to 00610

Its trial branch selected `public.users.trial_started_at`. **That column has
never existed on that table.** No migration added or dropped it; the name lives
on `ai_prompt_versions.trial_started_at` (00155), so it reads like the wrong
table's column. The `trial` key is built unconditionally into the returned
jsonb, so every call raised `42703` — there is no parameter combination that
avoids it.

It survived because every gate asked a different question. The db lane
**applies** migrations, and `CREATE FUNCTION` does not validate a plpgsql body,
so a function naming a missing column installs perfectly. `tsc`/`deno check` see
a string passed to `.rpc()`. The unit suite mocks the client. A body only fails
when it **executes**. `scripts/check-rpc-column-refs.mjs` now calls every RPC the
edge invokes, in a rolled-back transaction, and gates the db lane on it.

## The cohort keys on `created_at` (the decision)

"Trials started in the window" needs a start instant. Two candidates exist and
they are not equivalent:

| | Behaviour | Verdict |
|---|---|---|
| `trial_ends_at - interval '14 days'` | `trial_ends_at` **moves** after signup — `routes/webhooks.ts` writes it from the Stripe subscription's `trial_end`, `routes/admin-billing.ts` lets an admin set it outright | **Rejected.** Extending a trial would silently relocate that user into a different historical cohort, changing a number already reported. It also bakes the trial length into the metric, so changing the offer rewrites history. |
| `created_at`, filtered to users who got a trial | `handle_new_user` sets `trial_ends_at = now() + interval '14 days'` at insert, so `created_at` **is** the trial start by construction, and never moves | **Taken.** |

`trial_ends_at is not null` is the direct translation of the original
`trial_started_at is not null`: buyer-only signups get NULL and no trial, and
must stay out of the denominator.

**Known imprecision, deliberately accepted:** a user who signed up without a
trial and was granted one later by Stripe lands in their *signup* window rather
than their trial window. Rare, and the same direction of error the original
intended; the rejected option is wrong in a worse way because it is retroactive.

## Access is an allowlist, not a grant

> [!danger] The bug was the only thing guarding the data
> The guard read `if auth.uid() is not null and not public.is_admin()`, with a
> comment asserting *"anon can't reach this — execute is not granted to it"*.
> Both halves are false **together**: anon does have EXECUTE (see
> [[postgres-revoke-from-anon-is-a-noop]] — the `CREATE FUNCTION` grant to
> PUBLIC survives `REVOKE … FROM anon`), and anon's `auth.uid()` **is** null, so
> the guard's own condition passed it straight through.
>
> Fixing the column alone would have turned a function that always errored into
> one that hands the full revenue document to anyone holding the public anon
> key. That is why 00610 changes both, and why they must never be split.

The form now matches `admin_revenue_metrics`:

```sql
if not (auth.role() = 'service_role' or public.is_admin()) then
  raise exception '…: admin role required' using errcode = '42501';
end if;
```

Verified over real PostgREST, not by inspection: anon gets **HTTP 401 / 42501**,
the service role gets a full document, and `admin_revenue_metrics` refuses the
identical anon call with the identical code.

**One property worth knowing:** with no `request.jwt.claims` set at all,
`auth.role()` is NULL, the whole condition is NULL, and `IF NULL THEN` does not
fire — so a *direct database* connection is not stopped by this. PostgREST always
sets the claims, so it does not apply to any API caller, and the same is true of
`admin_revenue_metrics`. Direct database access is already privileged.

## No REVOKE, on purpose

Tightening the grant looks like the obvious fix and is not available: a denied
call from `anon` or `authenticated` **segfaults** this Postgres image (US-2403),
which is why `00527_revoke_public_function_execute.sql` is a permanent DO NOT
APPLY — an owner decision, not a hold. A body check raises an ordinary error, so
it arms nothing. See [[service-role-tables]] for the related table-side rule.

## Related

- [[billing-environment-marker]] — the sandbox exclusion 00608 added at six
  revenue sites, carried through 00610 unchanged.
- [[postgres-revoke-from-anon-is-a-noop]] — why the grant this guard assumed
  does not exist.
