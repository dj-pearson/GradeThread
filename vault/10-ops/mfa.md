---
title: Admin MFA
type: runbook
status: current
source_of_truth: vault
code_refs: []
reviewed: 2026-07-19
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

## Recovery codes

- Minted by the edge service (`POST /api/account/mfa/recovery-codes`) from an
  **AAL2 (MFA-verified) session**. Only SHA-256 **hashes** are stored in
  `mfa_recovery_codes`; the plaintext is returned once and never again.
- Each code works **once**. Settings shows how many unused codes remain.
- **Regenerate** at any time (Settings → Two-Factor Authentication →
  Regenerate). Regenerating invalidates all previously issued codes.

## Lost-device recovery (the runbook)

If a user loses their authenticator device:

1. They sign in with **email + password** as usual. This yields an AAL1 session
   — enough to reach Settings but not the MFA-gated areas.
2. They call the recovery flow with one of their saved recovery codes:
   `POST /api/account/mfa/recovery-codes/consume` with `{ "code": "XXXX-YYYY" }`.
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
| Owner requirement UI | `src/pages/team.tsx` (`WorkspaceMfaPolicyCard`) |
| Recovery code endpoints | `services/edge-functions/src/routes/account.ts` |
| Recovery code crypto (pure) | `services/edge-functions/src/lib/recovery-codes.ts` |
| Workspace policy endpoints | `services/edge-functions/src/routes/workspace.ts` |
| Member enforcement | `services/edge-functions/src/middleware/workspace.ts` |
| Pure gate + threshold roles | `services/edge-functions/src/lib/workspace-roles.ts` |
| Schema | `supabase/migrations/00141_self_serve_mfa.sql` |

## Related

- [[mfa-ipv6-ip-mismatch]] — the failure this runbook hits under IPv6
- [[incident-response]] — an operator locked out is an incident
- [[moc-ops]]
