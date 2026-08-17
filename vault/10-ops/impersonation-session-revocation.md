---
title: Ending an impersonation — what actually revokes, and what cannot
aliases: [revokeUserSessions, GoTrue admin logout, impersonation stop]
type: contract
status: current
source_of_truth: code
code_refs:
  - services/edge-functions/src/lib/impersonation-session.ts
  - services/edge-functions/src/routes/admin-impersonation.ts
  - supabase/migrations/00614_revoke_user_sessions.sql
  - scripts/check-session-revocation.mjs
  - src/lib/impersonation.ts
reviewed: 2026-08-17
tags: [security, auth, impersonation, contract]
summary: Stopping an impersonation deletes the target's auth.sessions rows through an RPC we own, because GoTrue's admin logout route does not exist on the version this project runs — and even a working revocation cannot kill an access token already issued.
---
# Ending an impersonation

## The route it used to call does not exist

`revokeUserSessions` posted to `{SUPABASE_URL}/auth/v1/admin/users/{id}/logout`
with `scope: global`. The comment was right about what that would do. The
endpoint is absent, so it never did it.

Measured on GoTrue v2.195.0, with the controls that make the result mean
something:

| Call | Result |
|---|---|
| `GET /auth/v1/admin/users/{id}` | 200 — auth, routing and id are all fine |
| `POST /auth/v1/admin/users/{id}/logout` | **404** |
| `DELETE /auth/v1/admin/users/{id}/sessions` | 404 |
| `POST /auth/v1/logout` (own-token route) | 403, not 404 |

`auth.sessions` stayed at 2 rows across the attempt, and the same 404 comes back
from the container directly on `:9999` with a service-role bearer, so it is not
the gateway. That last row is how you tell "absent" from "unauthorised".

**Production runs v2.174.0** — older still, read from
`GET https://api.gradethread.com/auth/v1/health`, which is unauthenticated.
Routes are added over time, not removed and re-added, so the control was dead in
production too. Stated as inference: proving it outright means calling the route
on prod with a service-role key, and if it *did* exist that call would revoke a
real user's sessions.

## What replaces it

`public.revoke_user_sessions(uuid)` (00614) deletes the user's `auth.sessions`
rows and returns the count. Refresh tokens go with them:
`refresh_tokens_session_id_fkey` is `ON DELETE CASCADE`, read from
`pg_constraint`, which is why the function does not touch `auth.refresh_tokens`
itself. Measured end to end: refresh with a live session → 200; delete the rows;
same token → 400 `refresh_token_not_found`.

**It has to be a function, not a delete from the edge.** PostgREST only exposes
the schemas in its config — `public` and `storage` (`supabase/config.toml`). So
`supabaseAdmin.schema("auth").from("sessions").delete()` type-checks, passes
`deno lint`, and answers **406** at runtime. Nothing in the type system knows
which schemas PostgREST serves.

The guard is the service-role allowlist required of every SECURITY DEFINER
function here — see [[security-definer-caller-allowlist]].

## ⚠ The access token survives, and always would have

Revocation stops the holder **refreshing**. It does not invalidate an access
token already issued: a Supabase access token is a JWT verified by signature with
nothing to look up, so it stays good until `jwt_expiry`, an hour. The GoTrue
route would have had exactly the same limit — this is a property of stateless
tokens, not a shortcoming of the replacement.

What bounds the gap is the rest of US-2351: the 30-minute cap and the
server-side impersonation marker, both enforced by every reader. An admin holding
a copied token past a stop can still read as the target until it expires. If that
window ever needs closing, the answer is a password reset (which is why the
admin-facing warning says so), not a better revocation call.

## The test that could never have caught this

The guard on "stopping revokes the target's sessions" asserted that the route's
**source** contained `await revokeUserSessions(session.target_id)`. That was true
for the entire life of the feature while the feature did nothing. The code was
correct; the endpoint was not; nothing exercised the pair.

`scripts/check-session-revocation.mjs` is the assertion that means something now:
it seeds a session and a refresh token, calls the function, and fails if the rows
are still there. It runs in the `db` verify lane and in `db-migrations.yml`, and
it was checked by sabotage — a body returning 0 without deleting, and a body with
the guard removed, both turn it red. What remains in
`impersonation-bounds_test.ts` is labelled wiring, so it is not mistaken for
proof a second time.

## The admin finds out

`POST /stop` returns `revoked`, `sessions_revoked` and `revoke_error`. The banner
hard-reloads on exit, so a toast raised at the moment of failure would be
destroyed before it rendered; the notice is parked in `sessionStorage` and shown
by `RootLayout` on the next boot. Before this, a failed revocation reached only
Sentry, and went unread for every stop ever made.

## Related

- [[security-definer-caller-allowlist]] — the guard every such function carries
- [[mfa]] — the step-up that gates starting an impersonation
- [[session-expiry-and-refresh]] — what refresh tokens do in normal operation
