---
title: Audit-log access control — who can read it, and what reading it records
type: contract
status: current
source_of_truth: code
code_refs:
  - supabase/migrations/00517_audit_log_search_super_admin.sql
  - supabase/migrations/00518_audit_search_self_audit_ordering.sql
  - services/edge-functions/src/routes/admin-audit.ts
  - services/edge-functions/src/tests/audit-rpc-gate_test.ts
  - src/pages/admin/audit-log.tsx
reviewed: 2026-08-03
tags: [admin, security, audit, rpc]
summary: The admin audit log is super_admin-only, enforced in the RPC rather than in the route in front of it; a successful read records itself, a refused one does not.
---

# Audit-log access control

## The rule

**Reading the audit log requires `super_admin`, and the check lives in the
database function — not in the route in front of it.**

Two functions carry it: `admin_audit_log_search` (the rows) and
`admin_audit_log_filter_options` (the admin roster and the action vocabulary).
Both accept the service-role edge client as well, because the forensic export
runs that way behind its own `super_admin` route gate.

## Why the route was not enough

`GET /api/admin/audit/export` restricted itself to `super_admin` and wrote an
`audit_log.export` row for every download. The RPC underneath it was guarded by
`is_admin()` only, granted to `authenticated`, capped at 50,000 rows — and the
console calls it **from the browser**. Any plain admin could open devtools, call
the RPC directly, and take the whole log: every other admin's IP addresses, user
agents and `details` payloads, with no export row behind them.

The general shape, which is the part worth carrying forward:

> **A control in front of a callable thing is not a control.** If a route
> enforces more than the function it wraps, the route is advice.

The grant was deliberately **not** narrowed to `service_role`. That would have
broken the console's own 25-row paginated list and forced it through the edge in
the same change — a much larger diff for the same security outcome. Enforcement
moved into the function body instead, where a caller cannot route around it.

## Two ceilings

| Caller | `p_limit` ceiling | Why |
|---|---|---|
| service-role (the edge export) | 50,000 | a forensic export is the only thing that needs it |
| anything else (the browser console) | 500 | the console pages at 25 |

So a stolen super-admin session still cannot pull the log in one request. Note
that the clamp **truncates silently** — a future client asking for 1,000 gets 500
rows and no error.

## What a read records

A successful non-service-role call writes its own `audit_log.search` row, with
the filters and the effective limit. Service-role calls do not: the edge route
already writes `audit_log.export` with the format and row count, and recording
both would double-count every export and make the log disagree with itself.

**A REFUSED call records nothing, and this is a real gap.** The guard raises,
the exception aborts the statement, and anything written before it rolls back —
reordering does not help and an autonomous transaction is not available in a
`SECURITY DEFINER` function. So the devtools attack above is now *blocked*, but
blocked *silently*. Catching the attempt itself needs it observed somewhere that
does not roll back: the Postgres log, or moving the console read behind the edge.

## The ordering bug, and why it is written here

00517 wrote the self-audit row **before** running the search, in the same
function and so the same statement. Under READ COMMITTED the new row was visible
to the SELECT that followed:

- `total_count` is a window `count(*) over ()`, so it grew by one on every call
  and the console's page count climbed as you browsed;
- the new row sorts first under `created_at desc`, displacing everything by one —
  page 0 returned it plus originals 1–24, and the page-1 call inserted another
  row so `offset 25` returned originals 24–48. **One duplicated row per page
  turn.**

Nothing was lost or mis-recorded; the log itself was always correct. What was
wrong was the reading of it, which on a forensic surface is its own kind of bad —
a list that quietly repeats and skips rows is worse than one that is obviously
broken.

00518 moves the insert after the `RETURN QUERY`. `RETURN QUERY` executes its
query immediately and appends the rows, then execution continues, so the search
sees the state the caller asked about and the audit row still lands. It also
fills `actor_role`, which 00517 left NULL — every other writer sets it, so a
filter on `actor_role` silently skipped these rows and the CSV export showed a
blank column.

This is exactly the case the US-2059 rule exists for (see `vault/CONTRACT.md`): 00517's header is
**immutable and now partly wrong**, because it claims the RPC path "is no longer
the quiet one" without the caveat that refusals still are. A note can be
corrected; an applied migration cannot.

## The fifteen-function trap

Fifteen `SECURITY DEFINER` functions share the shape "granted to
`authenticated`, guarded by `is_admin()`". **Fourteen are not bugs.** Thirteen
are read-only analytics an admin is meant to read, and `is_workspace_member`
must stay callable by `authenticated` or the RLS policies that call it break.

The pattern is a defect **only where a stricter control sits in front of the RPC
that the RPC does not itself enforce.** The right question is not "how many
functions match the pattern" but "for each one, does any route in front of it
enforce more than it does?" — and that needs re-asking whenever a route adds a
restriction, which is an argument for a guard rather than a one-time sweep.

## Related

- [[service-role-tables]] — the other half of the operator-surface story.
- [[mfa]] — the step-up that guards admin *writes*.
