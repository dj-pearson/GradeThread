---
title: Impersonation — what "view as" may and may not do
type: contract
status: current
source_of_truth: code
code_refs:
  - services/edge-functions/src/routes/auth-hooks.ts
  - services/edge-functions/src/routes/admin-impersonation.ts
  - services/edge-functions/src/lib/impersonation-session.ts
  - services/edge-functions/src/lib/destructive-guard.ts
  - supabase/migrations/00521_impersonation_sessions.sql
  - services/edge-functions/src/tests/impersonation-bounds_test.ts
reviewed: 2026-09-05
tags: [admin, security, impersonation, audit]
summary: Impersonation is capped at 30 minutes, recorded server-side, revoked on stop, and refused by every destructive route while it is live.
---

# Impersonation

## What it is for

"View as" exists so a super_admin can **see** what a user sees while working a
support ticket. Nothing about that requires the power to act irreversibly on
their behalf — and an admin who genuinely needs to act has admin endpoints that
record *them* as the actor.

## The entry was never the problem

Starting an impersonation has always required `super_admin`, the `users:role`
scope, a **fresh** MFA step-up, a non-privileged target, and writes an audit row.
That part was right from the start.

Everything **after** the token was minted was open, and the holes compounded:

| Hole | Consequence |
|---|---|
| no clock | the minted magic link yields an ordinary session — access token *and* long-lived refresh token — with no cap anywhere |
| no revocation | `/stop` redeemed the admin's resume token and never signed the target out, so a refresh token copied mid-session outlived the "stop" |
| no marker | nothing server-side said "this is an impersonation", so every action was indistinguishable from the real user's |
| client-controlled stop | the stop audit row read `target_id` straight from the request body |

Together: a super_admin could impersonate a disputing customer, cancel their
subscription and delete their account, and every downstream record — the Stripe
event, the deletion log, the marketplace disconnect — would show **the customer**
doing it. The admin's trail said only "impersonation started".

## The four rules now

1. **Thirty minutes, hard.** `IMPERSONATION_MAX_SECONDS`. Enforced by every
   *reader* of the session row, not by a scheduled sweep — the window between a
   cap passing and a job noticing is exactly when a forgotten session is most
   dangerous.
2. **A server-side row, or no impersonation.** `startImpersonation` opens it
   before the token leaves the handler, and a failed insert **refuses the start**.
   The row is the marker, the clock and the revocation handle; a session without
   one is the old unbounded session exactly.
3. **Stop revokes the target's sessions.** By deleting their `auth.sessions`
   rows through `admin_revoke_user_sessions` (00612), after trying GoTrue first.
   The result is **reported**, and now surfaced to the admin rather than only to
   Sentry: an un-revoked stop means the target's tokens are still live.

   ⚠ **This rule was FALSE from the day it was written until 2026-08-17.** It
   said "via GoTrue's admin logout with `scope: global`", and that route does not
   exist on the GoTrue this project runs — every stop 404'd and revoked nothing.
   It also cannot kill an access token already issued, which no version of this
   rule ever could. Both are in
   [[impersonation-session-revocation]], which owns the mechanism.
4. **Destructive routes refuse while it is live.** Account delete, subscription
   cancel, billing portal, and every marketplace disconnect.

The marker is a database row rather than a token claim on purpose. A claim would
be equally invisible to any route that does not parse it, and — worse — could not
be revoked once minted.

### The guard fails closed

`isImpersonated` returns **true** when its lookup errors. A database blip refuses
the destructive action rather than permitting it: being wrong that way costs a
real user one retry, being wrong the other way is unrecoverable.

### Enumerated, not blanket — and what that cost

`refuseWhileImpersonating` is called at each destructive site and the sites are
listed in a test. A blanket middleware would have to enumerate what is
destructive anyway and would silently permit anything it did not know about —
the same failure shape US-2354 removed from the scope guard.

**The list then did the thing the list was chosen to prevent.** Found 2026-08-08
while re-reading this note: Whatnot's `/disconnect` had no guard. It landed in
US-1661 *after* the enumeration was written, so nothing was wrong at the time and
nothing announced it afterwards — an argument from a fixed set cannot fail when
the set grows. Five marketplaces were guarded, one was not, and this page said
"every marketplace disconnect" throughout. The exposure was bounded only by
`WHATNOT_ENABLED` being off in prod, which is timing, not a control.

Both are fixed: the route calls the guard, and a second test now **derives** the
expected set by scanning `routes/flipdesk-*.ts` for a `/disconnect` handler
rather than restating it, so a seventh marketplace is covered the day its file
exists. It also fails if the derivation finds fewer than six routes, because a
guard that silently checks nothing is the failure mode it exists to replace.

The generalisable form, and the reason this is written down rather than just
fixed: **enumeration is safe against removal and blind to addition.** Prefer it
where the set is closed by definition, derive it where the set grows — and when
you keep a hand-written list, say what would make it incomplete.

## Who cannot be impersonated

`PRIVILEGED_ROLES` = **reviewer, admin, super_admin**.

`reviewer` was added by US-2351, and it is a decision rather than tidying. The
set means "roles whose account carries authority a super_admin should not be able
to borrow", not "roles above a line in the ladder". A reviewer holds
`grading:review` — they adjust issued grades, which are the product, and RLS
grants them `human_reviews` through `is_reviewer_or_admin()`. Impersonating one
produces a grade adjustment audited to the reviewer rather than to the admin who
made it: the same non-repudiation loss the admin exclusion exists to prevent.

## Account deletion needs the password, server-side

The re-authentication used to be a `signInWithPassword()` call in the browser
before the POST — a UX courtesy. The endpoint's only real control was the confirm
string, so anything holding a session could delete the account by calling the API
directly, **including an impersonating admin**, for whom the dialog never appears.

It now runs in the edge, against GoTrue's password grant, and **fails closed**: an
unreachable auth service means the password cannot be proved, and "cannot prove"
must not read as "proved" on the one endpoint that permanently destroys an
account. OAuth accounts have no password and are exempt — demanding one that does
not exist is not a control.

Admins cannot self-delete at all; see [[audit-log-access-control]].

## The ledger

`admin_impersonation_sessions` is deny-all in **both** directions, and both
matter. Readable, it would show a user their own impersonation history and leak
operator activity. Writable, it would let the person being impersonated end the
*record* while the session continued — worse than no record, because the row
would say it stopped.

Rows survive deletion of either party (SET NULL plus denormalized emails), for
the same reason audit rows do: the record of an impersonation is not the
impersonator's to erase.

## The second clock, and how to read it

**The GoTrue OTP TTL sets the real lifetime of the impersonation and resume
tokens** (US-2351 AC7), so it is a second clock running alongside the 30-minute
cap. The cap bounds what the *server* will honour; the TTL bounds how long the
minted link is redeemable. The shorter of the two is what actually stops an
abandoned session.

It is ONE setting for every token type, which is worth knowing before anyone
goes looking for an impersonation-specific one. Read from supabase/auth
`internal/api/verify.go` at v2.174.0 (the version production runs): signup,
invite, recovery and magiclink all resolve through a single
`isOtpExpired(..., config.Mailer.OtpExp)` call. Impersonation mints a magiclink
via `adminGenerateLink`, so it inherits that same number.

**Read it from `/health/ready` → `checks.features.gotrueOtpExpiry`**, not from
an operator lookup. GoTrue puts `otp_expiry` in the payload of every send-email
hook call; that value was arriving on every password reset and being used only
to write "expires in N minutes" into the email copy. It is now recorded to
`system_settings` under `ops.gotrue_otp_expiry_seconds` and reported, with the
line naming which of the two limits binds.

> [!warning] `never observed` has two causes and the line cannot tell them apart
> Either no auth email has reached the hook since this shipped, or GoTrue is not
> calling the send-email hook at all. The neighbouring `auth_email_hook` check
> cannot distinguish them either — it only proves `AUTH_EMAIL_HOOK_SECRET` is
> set on our side. So a `never observed` reading is a prompt to trigger one
> password reset, not evidence about the TTL.

The recorded value is an **observation, not a tunable**. It sits in the
[[system-settings]] registry because that is where the watchdog heartbeat sits
and the shape is identical, but editing it in the admin settings editor changes
nothing in GoTrue and makes the readiness line lie. The row's own `description`
says so.

## Related

- [[impersonation-session-revocation]] — what stopping actually revokes, and what it cannot.
- [[audit-log-access-control]] — who can read the trail this writes to.
- [[service-role-tables]] — the deny-all posture this table shares.
