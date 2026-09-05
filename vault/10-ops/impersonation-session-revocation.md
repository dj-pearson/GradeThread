---
title: Ending an impersonation — what actually revokes, and what cannot
aliases: [revokeUserSessions, GoTrue admin logout, impersonation stop]
type: contract
status: current
source_of_truth: code
code_refs:
  - services/edge-functions/src/lib/impersonation-session.ts
  - services/edge-functions/src/routes/admin-impersonation.ts
  - supabase/migrations/00612_admin_revoke_user_sessions.sql
  - scripts/check-session-revocation.mjs
  - src/lib/impersonation.ts
reviewed: 2026-09-05
tags: [security, auth, impersonation, contract]
summary: Stopping an impersonation falls back to deleting the target's auth.sessions rows through an RPC we own, because GoTrue's admin logout route does not exist on the version this project runs — and even a working revocation cannot kill an access token already issued.
---
# Ending an impersonation

## The route it relied on does not exist

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

**Production runs v2.174.0**, read from
`GET https://api.gradethread.com/auth/v1/health` — which needs the anon key,
despite what the story that filed this said: Kong 401s the call without one.

**The route exists in NEITHER version, and that is read from the source rather
than inferred (2026-09-05).** This section used to argue it: "routes are added
over time, not removed and re-added, so the control was dead in production too."
Reasonable, and unnecessary. supabase/auth's own route table
(`internal/api/api.go`) at both tags registers no route under `/admin` whose
path contains `logout` or `sessions`; the only logout route in either is
`r.With(api.requireAuthentication).Post("/logout", ...)`, which wants the user's
own token.

The read has a control, which is what makes it worth more than the inference it
replaces: it also predicts "absent" for v2.195.0, and that is the version where
the 404 in the table above was measured against a running container. A source
read that reproduces a known measurement can be trusted on the version nobody
probed.

## What replaces it

`public.admin_revoke_user_sessions(uuid)` (00612) deletes the user's
`auth.refresh_tokens` and `auth.sessions` rows and returns the session count.
Measured end to end: refresh with a live session → 200; delete the rows; same
token → 400 `refresh_token_not_found`.

`revokeUserSessions` **tries GoTrue first and falls back to the RPC**, rather
than dropping the upstream call. Both are injectable (`RevokeDeps`), and it only
reports an incident when BOTH fail — so the day upstream ADDS the admin route,
the supported path starts being used with no code change. Note "adds", not
"restores": it has never existed, so this is a bet on a future release rather
than on an upgrade undoing a removal. The cost of the bet is one fast 404 per
stop; the thing it must never become is what anyone believes is doing the work.

**It has to be a function, not a delete from the edge.** PostgREST only exposes
the schemas in its config — `public` and `storage` (`supabase/config.toml`). So
`supabaseAdmin.schema("auth").from("sessions").delete()` type-checks, passes
`deno lint`, and answers **406** at runtime. Nothing in the type system knows
which schemas PostgREST serves.

Note `auth.refresh_tokens.user_id` is `varchar`, not `uuid`; the cast is
required. The guard is a body check, not a `REVOKE` — see
[[postgres-revoke-from-anon-is-a-noop]] for why the grant route is unavailable.

## ⚠ The access token survives, and always would have

Revocation stops the holder **refreshing**. It does not invalidate an access
token already issued: a Supabase access token is a JWT verified by signature with
nothing to look up, so it stays good until `jwt_expiry`, an hour. The GoTrue
route would have had exactly the same limit — this is a property of stateless
tokens, not a shortcoming of the replacement.

What bounds the gap is the rest of US-2351: the 30-minute cap and the
server-side impersonation marker, both enforced by every reader. If that window
ever needs closing, the answer is a password reset, not a better revocation call.

## The test that could never have caught this

The guard on "stopping revokes the target's sessions" asserted that the route's
**source** contained `await revokeUserSessions(session.target_id)`. That was true
for the entire life of the feature while the feature did nothing. The code was
correct; the endpoint was not; nothing exercised the pair.

Two things guard it now, and they answer different questions:

- `impersonation-revoke_test.ts` drives the fallback through injected seams —
  neither half can be stubbed from outside, because `supabaseAdmin` is a Proxy
  whose `get` trap always resolves to the real client and the client captures
  `fetch` at construction. It proves the **decision logic**.
- `scripts/check-session-revocation.mjs` seeds a user, two sessions and a refresh
  token in a rolled-back transaction, calls the function, and fails if the rows
  survive. It proves the **SQL**, which no amount of stubbing can. It runs in the
  `db` verify lane and in `db-migrations.yml`, and was checked by sabotage — a
  body returning 0 without deleting, and a body with the guard removed, both turn
  it red.

## The admin finds out

`POST /stop` returns `revoked`. The banner hard-reloads on exit, so a toast
raised at the moment of failure would be destroyed before it rendered; the notice
is parked in `sessionStorage` (`REVOKE_WARNING_KEY`) and read once by the admin
page it reloads into. Before this, a failed revocation reached only Sentry.

## Related

- [[postgres-revoke-from-anon-is-a-noop]] — why a REVOKE is not the fix
- [[security-definer-caller-allowlist]] — the guard every such function carries
- [[impersonation]] — the four rules this is rule 3 of
- [[session-expiry-and-refresh]] — what refresh tokens do in normal operation
