---
title: Admin RPC guards and who the caller actually is
aliases: [is_admin service_role, admin RPC guard, SECURITY DEFINER guard]
type: contract
status: current
source_of_truth: code
code_refs:
  - services/edge-functions/src/tests/admin-rpc-service-role-guard_test.ts
  - supabase/migrations/00514_admin_metrics_service_role_guard.sql
reviewed: 2026-08-02
tags: [security, admin, rls, postgres, contract]
summary: is_admin() is ALWAYS false for the edge, because it resolves auth.uid() and a service-role JWT has no sub — so an admin RPC the edge calls must guard with the service_role-tolerant form or it rejects every call.
---

# Admin RPC guards and who the caller actually is

## The fact this exists for

`public.is_admin()` answers *"is the caller an admin?"* like this:

```sql
select exists (
  select 1 from public.users where id = auth.uid() and role in ('admin','super_admin')
)
```

**It is therefore always false for the edge service.** Every route calls Postgres
through `supabaseAdmin`, the service-role client. A service-role JWT carries no
`sub` claim, so `auth.uid()` is NULL, so the `exists` is false — not
"unauthorised", not "unknown", just false, every time.

A `SECURITY DEFINER` function guarded with a bare
`if not public.is_admin() then raise` therefore **rejects 100% of the calls the
edge makes to it**, with `42501`, and the route answers 500.

## Why this is hard to see

The guard reads correctly. The route reads correctly. The bug is only in the
seam between them, and nothing exercises an admin RPC through the role that
actually calls it. `admin_system_metrics()` and `admin_revenue_metrics()` sat
broken from US-1565 — the change that moved the admin System page behind the
edge boundary, i.e. the change that first put a service-role client in front of
an `is_admin()` guard — until US-2393 found them on 2026-08-02.

Note what US-1565's own migration comments say: they describe the guard as
protecting against a *non-admin end user*. That was true when the browser called
these functions directly. Moving the caller invalidated the reasoning without
touching a line of the SQL.

## The contract

**A function called from the edge must use a guard that tolerates a NULL
`auth.uid()`.** Two shapes do, and both are correct:

| Shape | Used by | Reads as |
|---|---|---|
| `auth.role() = 'service_role' or public.is_admin()` | 00207, 00227, 00513, 00514 | admit the service role explicitly |
| `auth.uid() is not null and not public.is_admin()` | `ai_spend`, `ai_budget_status`, `ai_profitability`, `funnel_metrics`, `reconciliation_candidates`, `referral_analytics`, `retention_cohorts`, `revenue_dashboard` | refuse only callers we can identify |

**A function called only from the BROWSER may keep the strict form** — there
`auth.uid()` is populated and strictness is exactly right.
`admin_user_list_stats` and `admin_audit_log_filter_options` are called from
`src/lib/admin-aggregates.ts` by an authenticated admin and are deliberately
left alone.

So the rule is not "relax every admin guard". It is **match the guard to the
caller**, and the caller is decided by which side invokes the RPC.

## Relaxing the guard gives up nothing

The reflex objection is that admitting `service_role` weakens the function. It
does not, because the service role is not a user-reachable credential — it is
the edge's own key, and every route that reaches these RPCs is already behind
the admin middleware (JWT + role + AAL2 + audit + rate limit). That middleware
is the access control; the in-function guard is defence in depth for the
*browser* path, and that path still hits the `is_admin()` half.

## What enforces it

`admin-rpc-service-role-guard_test.ts` derives both sides from source — the RPC
names the edge invokes, and the newest SQL definition of each — and fails on any
edge-called function whose guard cannot admit the service role. It is written as
a scan rather than as two assertions because the failure is a **class**: it
recurs whenever someone adds an admin RPC, guards it the obvious way, and calls
it from a route.

## Related

- [[service-role-tables]] — the table-side counterpart: operator tables, deny-all
  RLS, and the rls-guard discovery rule.
- [[migrations-process]] — the US-1108 triple these migrations follow.
