---
title: SECURITY DEFINER exposure, measured against production
type: learning
status: current
source_of_truth: vault
code_refs:
  - supabase/migrations/00615_credit_functions_service_role_only.sql
  - services/edge-functions/src/tests/admin-rpc-service-role-guard_test.ts
reviewed: 2026-08-21
tags: [security, postgres, rls, rpc, us-2282, measurement]
summary: 96 SECURITY DEFINER functions in prod, 55 reachable by anon, 15 with no body guard - and three analytics RPCs were confirmed returning real data to the public anon key.
---

# SECURITY DEFINER exposure, measured against production

Measured 2026-08-21 from `pg_proc` on the production database, for US-2282.
Supersedes every estimate: this is what is actually there.

## Read the ACL correctly or the whole answer is wrong

`proacl` looks like this:

```
{=X/supabase_admin,supabase_admin=X/...,postgres=X/...,anon=X/...,authenticated=X/...,service_role=X/...}
```

The load-bearing entry is the first one. **An empty grantee before the `=` means
PUBLIC.** So `=X/supabase_admin` is "PUBLIC has EXECUTE". Every role is
implicitly a member of PUBLIC, so that single entry makes a function
world-callable no matter what the rest of the list says — and the rest of the
list is what the eye goes to.

A function can also be anon-reachable through an explicit `anon=X` with no
PUBLIC entry. Both count. The distinction only matters when choosing the fix.

## The numbers

| | count |
|---|---|
| SECURITY DEFINER functions in `public` | 96 |
| reachable by anon | 55 |
| &nbsp;&nbsp;via a PUBLIC (`=X/`) grant | 50 |
| &nbsp;&nbsp;via an explicit `anon=X` grant only | 5 |
| locked to named non-anon roles | 20 |
| excluded: trigger functions (not callable as RPC) | 15 |
| excluded: RLS predicates (answer about the caller, return boolean) | 6 |
| **reachable, callable, and body-guarded** | **40** |
| **reachable, callable, NO body guard** | **15** |

The 40 are the work of 00514 and 00611-00617 and they hold up. The gap is 15.

## Closed 2026-08-21

Migration 00640 applied to production. Measured after, not assumed:

| | before | after |
|---|---|---|
| `channel_attribution` as anon | 200, real UTM campaign names | 401 `service_role required` |
| `buyer_growth_metrics` as anon | 200 | 401 `service_role required` |
| `community_benchmarks` as anon | 200 | 401 `authenticated required` |
| `increment_grades_used` as anon | 204, UPDATE ran | PGRST202, function gone |

**The story's own AC asked for the wrong measurement**, which is worth keeping.
It wanted `pg_proc.proacl` before and after. This fix deliberately does not touch
the ACL -- a REVOKE is the thing that segfaults the database -- so the two
snapshots are IDENTICAL and an operator diffing them would conclude nothing
happened. The anon call result is the before/after that means something.

Still unverified: a guarded function exercised through the edge's own
service-role client in production. The local matrix and the shared shape with
00615 make it near-certain, but near-certain is inference.

## The anon key being public is correct, and it is not what this is about

Worth stating plainly, because it is the first and most reasonable objection:
**the anon key is designed to be published.** It ships in the frontend bundle by
design, and RLS is the security boundary. That is the Supabase model and it is
right.

`SECURITY DEFINER` is the documented exception to it. Such a function runs as its
OWNER, not as the caller, which is the entire reason it exists — it is how
`handle_new_user` writes a profile row the new user could not write themselves.
The consequence is that **RLS is never in the path.** The only thing standing
between `anon` and the function's body is the EXECUTE grant, and PUBLIC holds it.

This is not a new class of problem for this codebase; 00615 already established
the fix. It is that 15 functions did not get it. The A/B, same anon key, same
minute, against production:

```
POST /rest/v1/rpc/increment_grades_used   {"user_id_param": "000...000"}
  -> HTTP 204

POST /rest/v1/rpc/grant_grade_credits     {"p_user_id": "000...000", ...}
  -> HTTP 401  {"code":"42501","message":"grant_grade_credits: service role required"}
```

Both are SECURITY DEFINER. Both write to `public.users`. RLS protected neither.
The body check 00615 added protected one of them. `increment_grades_used` ran its
`UPDATE public.users SET grades_used_this_month = grades_used_this_month + 1
WHERE id = $1` and returned 204; it changed nothing only because the nil UUID
matches no row. With a real user id it burns that user's monthly allowance.

(That particular function has **no callers anywhere in the codebase**, so
dropping it is a legitimate alternative to guarding it.)

## It is not theoretical

Three of the unguarded reads were called against production with nothing but the
**public anon key**, the one that ships inside the frontend bundle:

```
buyer_growth_metrics   HTTP 200   {"plans": [], "funnel": {...}, ...}
channel_attribution    HTTP 200   [{"utm_source":"blog","utm_medium":"organic",
                                    "utm_campaign":"how-to-start-reselling-...",
                                    "users":1}, ...]
community_benchmarks   HTTP 200   {"you": {...}, ...}
```

`channel_attribution` returned real campaign names and user counts. Anyone who
has visited gradethread.com holds the key that does this.

## The 15, and what each one needs

Decided by who actually calls them, which is the only thing that can decide it.
An RPC the edge calls through `supabaseAdmin` can be service-role-only; one the
browser calls cannot.

**Service-role only — edge is the sole caller (11):**
`claim_grade_lease`, `increment_ai_actions`, `increment_grades_used` (no caller
at all), `record_style_code_name`, `record_style_code_submission`,
`reserve_ai_action`, `reserve_buyer_meter`, `increment_certificate_view`,
`style_code_sweep_candidates`, `buyer_growth_metrics`, `channel_attribution`.

**Authenticated — the browser genuinely calls these (3):**
`get_or_create_source` (bulk-intake, intake), `merge_inventory_items`
(use-sku-merge), `community_benchmarks` (community-benchmarks.ts). These need
`auth.uid() is not null` plus tenant scoping, not a service-role guard.

**Stays anon, by design (1):**
`peek_workspace_invitation`. Accept-invite reads it BEFORE the invitee has
signed in. That is the feature. Documented here so the next audit does not
"fix" it.

## Why the fix is a body check and never a REVOKE

A revoke makes the call permission-denied, and a denied call
[[postgres-revoke-from-anon-is-a-noop|segfaults this Postgres image]] and
restarts the database (US-2403). 00527 is parked `.BLOCKED` permanently for
exactly that reason. A body check raises an ordinary `42501` instead.

The two accepted guard shapes are in
`admin-rpc-service-role-guard_test.ts`, which also explains why
`auth.role() = 'service_role' or public.is_admin()` is required rather than a
bare `is_admin()` — a service-role JWT carries no `sub`, so `auth.uid()` is NULL
and a bare `is_admin()` refuses the edge itself.

## Rewriting them is 1056 lines of body

The guard has to go INSIDE each function, so each one must be re-emitted whole:
8 are `plpgsql` (guard after `BEGIN`), 6 are `language sql` and need a wrapper
whose shape depends on the return type — `returns table` takes
`select * from (<original>) t where <guard>`, a scalar takes
`select case when <guard> then (<original>) end`, and `returns void` is DML that
has to become plpgsql. `community_benchmarks` alone is 486 lines.

**Generate it from the existing bodies; do not transcribe them.** The risk in
this migration is a typo in a body nobody re-reads, and generation removes that
category entirely.

## A method note that cost an hour

The first pass of the cross-reference reported **73 of 76 unguarded**, which
would have been a five-alarm finding. It was wrong. The body extractor cut each
function at `/language (plpgsql|sql)/`, and in this codebase's house style that
keyword sits in the HEADER, before `as $$`. So it scanned signatures and found
no guards anywhere — including in `grant_grade_credits`, whose guard is on the
second line of its body in the very file the tool named beside it.

The tool now self-checks against three functions whose guards were read by eye
first, and refuses to report if it cannot see them. **A detector that cannot see
what it detects returns a clean sweep and looks like a discovery.**
