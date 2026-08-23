---
title: Which Postgres functions the edge may call
aliases: [caller-scoped RPC, identity-dependent function, service-role RPC call]
type: contract
status: current
source_of_truth: code
code_refs:
  - src/test/edge-never-calls-caller-scoped-rpc.test.ts
  - src/test/rpc-identity-semantics.test.ts
reviewed: 2026-08-23
tags: [security, rls, tenant-isolation, postgres, contract]
summary: The edge calls Postgres as service_role, so auth.uid() is NULL and RLS is off; a function that scopes itself by either one returns nothing or returns every tenant's rows, silently and with a 200. Twenty functions are identity-dependent today and the edge calls none of them.
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

## Two traps in detecting this

**Views hide the tenancy.** The analytics RPCs read `items_full`, not
`inventory_items`. A view carries no RLS policy of its own, so a rule that knows
only base tables sees an analytics function touching nothing tenant-shaped and
calls it safe. Six of the twenty are reachable only through a view. Any check
here has to resolve views to their bases.

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
