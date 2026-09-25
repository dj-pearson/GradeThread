---
title: Admin MFA
type: runbook
status: current
source_of_truth: vault
code_refs: []
reviewed: 2026-09-25
tags: [ops, security, mfa]
summary: How admin step-up auth works and how to recover an operator.
---
# Multi-Factor Authentication (MFA / 2FA)

GradeThread supports time-based one-time-password (TOTP) two-factor
authentication for **every** user, plus an optional per-workspace requirement
(US-374). This builds on the admin-only MFA gate (US-270): the admin area still
enforces AAL2 server-side via `adminAuthMiddleware`; this document covers the
self-serve, all-users surface.

## Enabling 2FA (any user)

1. **Settings → Two-Factor Authentication → Set up two-factor authentication.**
2. Scan the QR code (or type the secret) into an authenticator app — Google
   Authenticator, 1Password, Authy, etc.
3. Enter the current 6-digit code to verify and enable.
4. A set of **10 single-use recovery codes** is generated immediately. Save
   them (Copy / Download) — they are shown only once.

Enrollment talks directly to Supabase/GoTrue (`supabase.auth.mfa.*`); it never
goes through workspace-scoped edge routes, so a workspace MFA requirement can
never lock a member out of *enrolling*.

## Web sign-in asks for the code (US-3497)

A user with a verified TOTP factor who signs in on the website with a password
gets an AAL1 session. `ProtectedRoute` wraps every signed-in route in
`MfaSignInGate` (`src/components/auth/mfa-sign-in-gate.tsx`), which reads
`getAuthenticatorAssuranceLevel()` and holds the session on a code screen while
`currentLevel` is `aal1` and `nextLevel` is `aal2`. The URL is not changed, so a
deep link (`?next=`) is still where the user lands once the code is accepted.
A user with no factor passes through with no extra screen; the level read is
local to the session, so it costs no request. An unreadable level fails
closed, with retry and sign-out.

The same screen takes a recovery code (the lost-device path below), and
sign-out is always on it.

> [!warning] This is the SPA half only
> The edge does not refuse an AAL1 token from a user who has a factor, except
> in the admin area (`adminAuthMiddleware`) and inside a workspace whose owner
> requires 2FA. Someone holding a stolen password can still mint an AAL1 token
> against GoTrue and call ordinary edge routes directly. Closing that needs an
> edge-side check and is not part of US-3497.

## Recovery codes

- Minted by the edge service (`POST /api/account/mfa/recovery-codes`) from an
  **AAL2 (MFA-verified) session**. Only SHA-256 **hashes** are stored in
  `mfa_recovery_codes`; the plaintext is returned once and never again.
- Each code works **once**. Settings shows how many unused codes remain.
- **Regenerate** at any time (Settings → Two-Factor Authentication →
  Regenerate). Regenerating invalidates all previously issued codes.

## Lost-device recovery (the runbook)

If a user loses their authenticator device:

1. They sign in with **email + password** as usual. This yields an AAL1 session,
   and on the web the code screen holds it there.
2. On that screen they pick **Lost your device? Use a recovery code** and enter
   one of their saved codes. The SPA calls
   `POST /api/account/mfa/recovery-codes/consume` with `{ "code": "XXXX-YYYY" }`
   and then refreshes the session so it stops listing the removed factor.
   - A valid, unused code is **burned** (marked used) and **all** of the user's
     TOTP factors are unenrolled server-side (`auth.admin.mfa.deleteFactor`).
3. With the stale factor removed, the user is back to password-only and can
   **re-enroll** a new device under Settings (which mints a fresh recovery set).

### No device *and* no recovery codes

If the user has neither the device nor any unused recovery code, an
operator/super-admin must reset MFA for them manually:

- In the self-hosted Supabase Studio (or via the service-role Admin API), list
  the user's factors and delete them:
  `auth.admin.mfa.listFactors({ userId })` → `auth.admin.mfa.deleteFactor({ id, userId })`.
- Verify the requester's identity out-of-band first (this bypasses the second
  factor entirely). After reset, instruct the user to re-enroll and save new
  recovery codes.

## Requiring 2FA for a workspace (owners)

A workspace **owner** can require 2FA for members at or above a role threshold:

- **Team → Require two-factor authentication.** Pick the threshold:
  - *Not required* (default), *Admins*, *Managers and above*, *Staff and above*,
    or *Everyone*.
- Stored as `users.workspace_mfa_required_role` on the owner's row (NULL = off).
- Enforced in `workspaceMiddleware`: a member whose role meets/exceeds the
  threshold but whose session is **not AAL2** is rejected with HTTP 403 and
  `error_code: "workspace_mfa_required"`. The web client turns that into a toast
  pointing the member at Settings → Two-Factor Authentication.
- The owner is **never** forced by their own policy (the threshold targets
  members). Owners who want their own second factor enable it the same way as
  any user, in Settings.

### Implications

- A member who hasn't enabled 2FA keeps full read/write access to their *own*
  personal workspace; the requirement only applies when acting **inside the
  enforcing owner's workspace**.
- After enabling 2FA, the member must **sign in again** (or complete an MFA
  challenge) so their session is minted at AAL2.

## Where the code lives

| Concern | Location |
|---|---|
| Self-serve enroll + recovery UI | `src/components/settings/mfa-card.tsx` |
| Web sign-in code screen | `src/components/auth/mfa-sign-in-gate.tsx` (in `protected-route.tsx`) |
| Owner requirement UI | `src/pages/team.tsx` (`WorkspaceMfaPolicyCard`) |
| Recovery code endpoints | `services/edge-functions/src/routes/account.ts` |
| Recovery code crypto (pure) | `services/edge-functions/src/lib/recovery-codes.ts` |
| Workspace policy endpoints | `services/edge-functions/src/routes/workspace.ts` |
| Member enforcement | `services/edge-functions/src/middleware/workspace.ts` |
| Pure gate + threshold roles | `services/edge-functions/src/lib/workspace-roles.ts` |
| Admin step-up gate | `services/edge-functions/src/middleware/admin-auth.ts` + `lib/step-up.ts` |
| Step-up knobs | `ADMIN_MFA_ENFORCED` (default true, asserted at startup), `STEP_UP_MAX_AGE_SEC` |
| Schema | `supabase/migrations/00141_self_serve_mfa.sql` |

Only **write** routes call `requireStepUp`. That is why a broken step-up shows up
as admin POSTs returning 403 while every admin GET still returns 200 — see
[[mfa-ipv6-ip-mismatch]] for reading that asymmetry.

## Never handle STEP_UP_REQUIRED at a call site

A destructive admin endpoint answers `403 { code: "STEP_UP_REQUIRED" }`. That
used to be handled per call site, and roughly **30 admin surfaces never added the
handler** — so those actions simply failed on repeat with no way to re-verify.
The report reads as *"admin keeps asking for 2FA and won't let me re-auth"*.

It is now central: `edgeFetch` detects the code, calls `requestStepUp()` (a small
broker that dedupes concurrent prompts), and retries once with the re-verified
token. A single `MfaStepUpDialog` is mounted by `<StepUpHost />` inside
`AdminMfaGate`. Outside admin no host is registered, so the 403 passes through
untouched.

> **Use `edgeFetch` and add no branch.** A surface calling bare `fetch()` bypasses
> the whole mechanism and reproduces the original bug. Known bare-`fetch` admin
> surfaces as of 2026-07-22: `disputes.tsx`, `grading-calibration-panel`,
> `grading-eval-candidates-panel`, `grading-monitor-panel`,
> `listing-prompt-performance-panel`.

The window is `ADMIN_STEP_UP_MAX_AGE_SEC` (default raised from 8h to **24h**),
measured off the session's `amr` timestamp — so signing out always ends it,
regardless of the number.

## Related

- [[mfa-ipv6-ip-mismatch]] — the failure this runbook hits under IPv6
- [[incident-response]] — an operator locked out is an incident
- [[moc-ops]]
