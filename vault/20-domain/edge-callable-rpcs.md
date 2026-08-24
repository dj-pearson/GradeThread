---
title: Which Postgres functions the edge may call
aliases: [caller-scoped RPC, identity-dependent function, service-role RPC call]
type: contract
status: current
source_of_truth: code
code_refs:
  - src/test/edge-never-calls-caller-scoped-rpc.test.ts
  - src/test/rpc-identity-semantics.test.ts
  - supabase/migrations/00662_flipdesk_price_gap_for_user.sql
reviewed: 2026-08-23
tags: [security, rls, tenant-isolation, postgres, contract]
summary: The edge calls Postgres as service_role, so auth.uid() is NULL and RLS is off; a function that scopes itself by either one returns nothing or returns every tenant's rows, silently and with a 200. Twenty run as the caller and five more are SECURITY DEFINER but scope their rows by the session; the edge calls none of either, and 00662 shows the p_user_id wrapper that converts one.
---

# Which Postgres functions the edge may call

## The fact this exists for

Every edge route reaches Postgres through `supabaseAdmin`, the **service-role**
client. Two things follow, and both change what a function means:

- `auth.uid()` is **NULL** — a service-role JWT carries no `sub`.
- **RLS does not apply** — service_role bypasses row security entirely.

So a function that decides which rows to return using either mechanism answers a
different question for the edge than for the browser. It does not error. It
returns 200.

| How the function scopes itself | What the edge gets |
|---|---|
| `where user_id = auth.uid()` | **nothing**, for every seller. A feature that looks built and is empty. |
| RLS only (SECURITY INVOKER, no filter) | **every tenant's rows**. This is the US-268 breach. |

The second is the dangerous one, and it is the *less* obvious of the two: the
function's SQL contains no scoping at all, so it reads as though tenancy was
never its job.

## The rule

**An edge-callable function takes the user as an argument.** Identity is a
parameter, never an ambient fact. In practice that means a `SECURITY DEFINER`
wrapper accepting `p_user_id`, which branches on `auth.role() = 'service_role'`
so a logged-in caller can never pass somebody else's id.

`edge-never-calls-caller-scoped-rpc.test.ts` enforces it: the build fails if any
edge production file `.rpc()`s a function that runs as the caller, reads tenant
data, and takes no user argument. **There is no allowlist**, because the count is
zero and the fix is always the wrapper.

## The twenty loaded guns

Twenty functions are identity-dependent today — `flipdesk_source_yield`,
`flipdesk_overview_metrics`, `flipdesk_return_attribution`,
`flipdesk_listing_quality_lift`, `finances_dashboard`, `flipdesk_search` and
others. **None is a bug.** Each is correct as a browser RPC, where the session
is exactly the right scope. They are hazards only because the trigger is one
line in a job or an `/api/v1` handler, and both US-2829 (analytics over the API)
and US-2828 (the weekly digest) have that line as their next step. In the digest
case the result is **emailed**, so the RLS-bypass direction would post one
seller's figures to another.

## The worked example: `flipdesk_price_gap` (00662)

The first function actually converted, and the shape to copy. It scored the
caller's items with `where user_id = auth.uid()` in three places, so the weekly
digest job got an empty result for every seller — silently, with a 200.

```sql
with caller as (
  select case
    when auth.role() = 'service_role' then coalesce(p_user_id, auth.uid())
    else auth.uid()
  end as uid
), ...
where b.user_id = (select uid from caller)
```

**The argument is IGNORED for a non-service_role caller, not refused.** That is
the safety property and it is deliberate: a logged-in seller passing someone
else's id gets their own rows back, so there is no error to probe and the
parameter cannot serve as an oracle either. Proven by execution against the
local stack with two seeded users, not reasoned about:

| caller | `p_user_id` | reads |
|---|---|---|
| service_role | B | B's rows |
| authenticated (A) | B | **A's rows** |
| authenticated (B) | A | **B's own rows** |
| service_role | none | nothing — unchanged from before |

> [!warning] Adding the parameter needs a DROP, and the DROP costs the grants
> A defaulted parameter creates a **second overload** rather than replacing the
> first, and PostgREST then finds two candidates for a one-argument call and
> fails it as ambiguous. So the old signature must be dropped. But dropping a
> function destroys its grants, and the fresh create hands `EXECUTE` back to
> PUBLIC by the CREATE default and nothing else — measured in
> [[postgres-revoke-from-anon-is-a-noop]]. **Re-issue every grant explicitly**,
> and keep `OR REPLACE` on the create so the file survives a second run
> (US-2837). And `NOTIFY pgrst` matters more than usual here: the SIGNATURE
> changed, so a stale schema cache 404s the browser's existing call.

## Three traps in detecting this

**Views hide the tenancy.** The analytics RPCs read `items_full`, not
`inventory_items`. A view carries no RLS policy of its own, so a rule that knows
only base tables sees an analytics function touching nothing tenant-shaped and
calls it safe. Six of the twenty are reachable only through a view. Any check
here has to resolve views to their bases.

**`SECURITY DEFINER` was a blind spot, and it was exactly where the problem
lived (US-2828).** `identityDependent()` skips every DEFINER function, on the
reasonable assumption that a DEFINER function takes its subject as an argument.
`flipdesk_price_gap` disproved it: DEFINER, no user parameter, scoped by
`auth.uid()`. So the guard whose failure message names the `p_user_id` wrapper
as *the* fix could never have fired for the function that needed it.
`definerRowScoped()` covers that shape now — **five** functions today
(`community_benchmarks`, `condition_price_curve`, `flipdesk_defect_cost`,
`measurement_drift`, `seller_scorecard`), **zero** called from the edge.

> [!note] Reading `auth.uid()` is not scoping by it, and a comment is not code
> The first measurement of that blind spot asked "DEFINER + reads `auth.uid()` +
> no user id" and reported **13 functions, 4 already edge-called** — which reads
> as a live breach. It was not. All four use `auth.uid()` for AUTHORIZATION
> (reading the caller's role), and in three of them the matches were inside
> COMMENTS about a guard fixed months ago. The honest question is a scoping
> predicate on an owner column, over the function BODY with comments stripped.
> That answers five, and none reachable. Anyone re-running this scan should
> start from that distinction rather than rediscovering it.

**"Dual-called" is not the same question.** The rule in
`src/test/rpc-identity-semantics.test.ts` —
a function called from the browser *and* the edge must take a user argument or
branch on `service_role` — is real and narrower. It cannot see an **edge-only**
call, where nothing is dual-called, the guard never fires, and the wrong
tenant's rows come back regardless.

## Related

- [[admin-rpc-guards]] — the same "who is the caller" problem for `SECURITY
  DEFINER` admin functions. There the failure is loud: `is_admin()` is always
  false for the edge, so a bare guard rejects **every** edge call with 42501.
  Loud is the easier half; this note is the quiet half.
- [[service-role-tables]] — the table-side counterpart, and how `rls-guard`
  discovers tenant tables.
