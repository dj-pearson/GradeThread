---
title: Session expiry, token refresh and the idle logout
aliases: [session expired, logged out after an hour, refresh token]
type: runbook
status: current
source_of_truth: code
code_refs:
  - src/lib/auth-token.ts
  - src/lib/idle-logout.ts
  - src/lib/edge-fetch.ts
reviewed: 2026-08-01
tags: [auth, session, gotrue, ops]
summary: "Session expired" about an hour in is a refresh that failed to recover, not an expiry policy — and the durable fixes are prod GoTrue env vars this repo cannot reach.
---

# Session expiry, token refresh and the idle logout

## Read the interval before anything else

**About an hour in** is the access-token lifetime (`GOTRUE_JWT_EXP=3600`). That
is not a session cap being hit; it is **the refresh failing to recover the
session at the token boundary**. Chasing session-timeout settings for this
symptom looks productive and finds nothing.

**Daily, on iOS specifically** is a different bug with a different cause — the
Apple-credential foreground check, not refresh. Do not merge the two.

## Why the refresh does not always run

supabase-js auto-refresh is a **timer**, and the timer is suspended while the tab
or app is backgrounded. Come back after an idle period and `getSession()` can
hand back an already-expired token; the edge validates every request through
`supabaseAdmin.auth.getUser(token)`, so GoTrue rejects it and the user sees
"session expired".

The client hardening that closes this:

- `getFreshAccessToken()` (`src/lib/auth-token.ts`) refreshes when the token is
  within **60 seconds** of expiry rather than trusting the timer;
  `forceRefreshAccessToken()` is the explicit form. `edgeFetch`,
  `edgeAuthHeaders` and the eBay hook's auth header all route through it.
- `edgeFetch` additionally does a **one-shot refresh-and-retry on 401**, which is
  the pattern iOS `EdgeAPI` already used.
- iOS raised its shared bounded `URLSession` request timeout 20s → 30s: that
  session also bounds token refreshes, and 20s could time out a refresh against a
  cold or loaded self-hosted GoTrue. It stays under the 60s App Store 2.1(b) hang
  threshold.

## The idle logout is client-side, and deliberately so

GoTrue's session policy is **global** — it cannot differ per platform. But a
browser is more often a shared or switched-user device than a phone is. So iOS
stays long-lived server-side and **web is shortened on the client**:
`src/lib/idle-logout.ts` signs out after **12 hours** with no interaction,
started from `use-auth.ts`.

> It calls `signOut({ scope: "local" })`. The default is `global`, which would
> revoke the user's iOS and other-device sessions too. Changing that scope turns
> a browser idle-timeout into a sign-out everywhere.

Last activity is persisted to `localStorage` so reopening after an idle period
also logs out, rather than only counting time the tab was open.

## The durable fixes are prod GoTrue env vars

These live on the self-hosted stack. **`supabase/config.toml` does not reach
them** — it configures only the throwaway local verify stack. See
[[env-reference]] for where prod values are set.

| Variable | Why it matters |
|---|---|
| `GOTRUE_SESSIONS_TIMEBOX` | absolute session cap; a short value forces logouts regardless of activity |
| `GOTRUE_SESSIONS_INACTIVITY_TIMEOUT` | idle cap, same risk |
| `GOTRUE_SECURITY_REFRESH_TOKEN_REUSE_INTERVAL` | too small + concurrent refreshes ⇒ reuse detection **revokes the whole token chain**. Local mirrors 10s; consider 30–60s |
| `GOTRUE_SECURITY_REFRESH_TOKEN_ROTATION_ENABLED` | rotation on is what makes the reuse interval load-bearing |
| `GOTRUE_RATE_LIMIT_TOKEN_REFRESH` | hitting the refresh rate limit also returns 401, which looks identical to an expired session |

For a **~1h** symptom, suspect the refresh path (the last three rows) before the
session caps.

## Related

- [[mfa-ipv6-ip-mismatch]] — the other auth failure whose real cause is upstream of our code
- [[env-reference]] — where prod env values live
- [[incident-response]] — if this is affecting many users at once
- [[moc-ops]]
