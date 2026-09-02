---
title: REVOKE FROM anon is a no-op — the PUBLIC grant survives it
aliases: [revoke from anon, function grants]
type: contract
status: current
source_of_truth: code
code_refs:
  - scripts/migrations-lint.mjs
  - supabase/migrations/00216_credit_ledger_admin.sql
  - supabase/migrations/00099_snap_quota.sql
  - supabase/migrations/00611_body_checks_for_ineffective_revokes.sql
  - supabase/migrations/00617_remaining_metered_function_guards.sql
  - supabase/migrations/00723_credit_function_authorization_invariant.sql
  - scripts/check-credit-function-guards.mjs
reviewed: 2026-09-02
tags: [postgres, security, migrations, grants]
summary: CREATE FUNCTION grants EXECUTE to PUBLIC and every role belongs to PUBLIC, so revoking a role by name removes a grant it never held alone. Thirteen migrations used that pattern; six secured nothing, for up to three years.
---
# `REVOKE … FROM anon` does not deny anon

`CREATE FUNCTION` grants `EXECUTE` to **PUBLIC**, and every role is implicitly a
member of PUBLIC. So `REVOKE ALL ON FUNCTION f() FROM anon` removes a grant anon
never held individually and leaves the one it actually executes through. The
function stays callable by anyone holding the public anon key.

Proven in a rolled-back transaction rather than argued — three probe functions,
`has_function_privilege('anon', …)`:

| Probe | Result |
|---|---|
| untouched | **true** — the CREATE default |
| `REVOKE … FROM anon` | **true** ← the pattern this repo used |
| `REVOKE … FROM anon, public` | false |

And confirmed against production: an anon POST to
`/rest/v1/rpc/flipdesk_overview_metrics` returns HTTP 200, while
`00594_flipdesk_overview_metrics.sql:214` has revoked that exact signature from
anon since the day it was written.

## Why it is invisible

The SQL is valid. The `REVOKE` succeeds. `psql` prints `REVOKE`. The migration
applies green. There is no error at any point, at any later stage, ever — which
is why the guard has to live at authoring time.

`scripts/migrations-lint.mjs` fails any migration whose revokes, taken together
within one file, never name PUBLIC. Six that already shipped are grandfathered
by `file:function` in `INEFFECTIVE_REVOKE_GRANDFATHERED` (applied migrations are
immutable, so they can only be fixed forward); keying on file **and** function
means a new no-op in one of those same files still fails, and the list may only
shrink.

> [!note] That file now carries a second ratchet, and it interacts with this one
> US-2837 added an idempotency rule to `scripts/migrations-lint.mjs`: a
> `CREATE FUNCTION` must be `CREATE OR REPLACE FUNCTION`. Read alongside this
> note, that pushes migrations in the SAFER grant direction rather than the
> riskier one, which is worth knowing before anyone objects to it.
>
> **`CREATE OR REPLACE` on an existing function PRESERVES its grants.**
> `DROP` then `CREATE` does not: dropping destroys the grants with the
> function, and the fresh create hands `EXECUTE` back to PUBLIC by the default
> this whole note is about. So a migration that re-creates a previously-secured
> function by dropping it silently re-opens it, and every `REVOKE` written
> earlier is undone without a word.
>
> Measured on the local stack rather than asserted, reading
> `has_function_privilege('anon', …, 'EXECUTE')` at each step:
>
> | step | anon EXECUTE |
> |---|---|
> | fresh `CREATE` | `t` — the PUBLIC default |
> | after `REVOKE … FROM PUBLIC, anon, authenticated` | `f` |
> | after `CREATE OR REPLACE` | **`f`** — the revoke survives |
> | after `DROP` + `CREATE` | **`t`** — the revoke is gone |
>
> The last row is the one to remember. It is a silent re-open: the SQL is
> valid, the migration applies green, and nothing reports that a function
> secured three years ago is reachable again.
>
> The `DROP` is still correct when the ARGUMENT LIST changes — see
> [[billing-environment-marker]] for the worked case, where the drop is what
> stops a stale overload staying live. The rule is only that the create
> alongside it says `OR REPLACE`, so the file can be run twice.

## The working form

`00216_credit_ledger_admin.sql:143` is the model:

```sql
REVOKE ALL ON FUNCTION public.admin_adjust_credits(uuid, integer, text, uuid, text, text)
  FROM PUBLIC, anon, authenticated;
```

Of the 13 functions carrying a revoke-from-anon, the 7 that are genuinely denied
all name PUBLIC. The 6 that do not are: `data_integrity_scan` (00097),
`reserve_snap` and `refund_snap` (00099 — both **mutate** a user's Snap quota),
`north_star_weekly_counts` and `north_star_lifetime_counts` (00170), and
`flipdesk_overview_metrics` (00594).

## ⚠ Two reasons not to reach for a revoke anyway

> [!danger] Revoking is the road not taken here
> **It can take production down.** A DENIED call from `anon` or `authenticated`
> segfaults this Postgres image and restarts the database (US-2403). Revoking
> anything reachable with the public anon key therefore hands out a restart
> button. This is why `00527_revoke_public_function_execute.sql` is a permanent
> DO NOT APPLY — an owner decision, not a hold.
>
> **It strips `service_role` too.** Most functions here hold EXECUTE *only*
> through the PUBLIC default — `pg_proc.proacl` reads `=X/postgres` and nothing
> else — so `REVOKE … FROM PUBLIC` removes the edge's access along with the
> attacker's. Proven on `reserve_snap`, which runs the Snap grading path:
> `service_role` goes true → false → true across revoke-then-grant. A revoke
> that is not paired with an explicit `GRANT … TO service_role` is an outage.

The settled remedy is an authorization check in the function **body**, the way
`admin_revenue_metrics` does it. It revokes nothing, so it arms neither problem —
and that function is anon-*executable* and still safe, which is the proof it
works. See [[revenue-dashboard-cohorts-and-access]] for the first application of
it, where the missing guard was being masked by an unrelated bug.

## What the six got

`00611_body_checks_for_ineffective_revokes.sql` applies that remedy to all six,
with no `REVOKE` anywhere in the file. Every caller was traced to a call site
first, and none is anon:

| Function | Caller | Guard |
|---|---|---|
| `reserve_snap` | `routes/grade.ts:1570` (supabaseAdmin) | service_role |
| `refund_snap` | `lib/grade-refund.ts:204` (supabaseAdmin) | service_role |
| `data_integrity_scan` | `lib/integrity-scan.ts:19` (supabaseAdmin) | service_role |
| `north_star_weekly_counts` | `routes/jobs-north-star.ts:74` (cron) | service_role |
| `north_star_lifetime_counts` | `routes/jobs-north-star.ts:140` (cron) | service_role |
| `flipdesk_overview_metrics` | `src/hooks/use-flipdesk-overview.ts:121` (browser) | service_role or authenticated |

Two details that will bite the next person writing one of these:

- **SQL cannot raise**, so four of the six had to move from `language sql` to
  `language plpgsql`. Add `#variable_conflict use_column` when the function is
  `RETURNS TABLE`, or its output names (`user_id`, `count`, `total`) start
  resolving as OUT variables inside the query.
- **A NULL `auth.role()` is passed through on purpose.** That is an in-database
  caller (psql, pg_cron), never a PostgREST request: the anon key and a signed-in
  session both carry a role claim. Denying NULL would lock operators and any
  future `pg_cron` job out of their own diagnostics.


## A high anon-EXECUTE count is the healthy state, not a backlog

Reading `pg_proc` for the first time produces a number that looks like an
emergency: on 2026-09-02, 100 of prod's 120 `SECURITY DEFINER` functions were
executable by `anon`. US-3094 was filed on exactly that reading, plus the
inference that the local stack must be different because US-2282's closing note
recorded `anon` being refused `42501`.

Both halves were wrong, and the catalog settles it. **The local stack agrees
with prod** — 237 / 119 / 101 the same day, and the eight credit functions carry
`anon=X` in *both*. Nothing was re-granted, because no `REVOKE` was ever written
for them anywhere: US-2282 shipped `00615`, which put the check in the body. The
`42501` in its note is that body raising, not an `EXECUTE` denial. The two error
paths are indistinguishable from a client, which is what made the wrong reading
so easy.

So the number to watch is not `definer_anon_can_run`. It is the pair
`anon_can_run = true AND body_guard = false`, which must be zero.
`scripts/prod-diagnostics.sql` §29 reports both, `00723` asserts the pair at
apply time for the ten credit functions, and
`scripts/check-credit-function-guards.mjs` runs the same catalog query in
`verify` and CI. A *sudden drop* in `definer_anon_can_run` is the alarm — it
means a revoke shipped, and every function it touched is now an unauthenticated
database restart away.

## Related

- [[revenue-dashboard-cohorts-and-access]] — a guard that assumed this grant.
- [[service-role-tables]] — the table-side rule for deny-all operator tables.
