-- US-374: Self-serve MFA (TOTP) for all users + workspace enforcement
--
-- Today MFA is admin-only (the client AdminMfaGate + the AAL2 requirement in
-- adminAuthMiddleware). This migration adds the two pieces of data needed to
-- offer TOTP to EVERY user and let workspace owners require it of their members:
--
--   1. `mfa_recovery_codes` — single-use backup codes so a user who loses their
--      authenticator device can recover (consume a code → we unenroll their
--      stale TOTP factor → they sign in with password and re-enroll). Only
--      SHA-256 HASHES are stored; the plaintext is shown once at generation.
--
--   2. `users.workspace_mfa_required_role` — an OWNER-scoped policy. When set,
--      every workspace member whose role is >= that threshold must have an AAL2
--      (MFA-satisfied) session to act inside the owner's workspace. NULL = no
--      enforcement (the default). The owner themselves is never forced by their
--      own policy — the threshold targets members.

-- ── 1. Workspace MFA-enforcement threshold (owner-scoped) ──────────────────
ALTER TABLE public.users
  ADD COLUMN workspace_mfa_required_role public.workspace_role;

COMMENT ON COLUMN public.users.workspace_mfa_required_role IS
  'US-374: when set, workspace members at or above this role must use MFA '
  '(AAL2) to act in this owner''s workspace. NULL = no enforcement.';

-- ── 2. Single-use recovery codes ──────────────────────────────────────────
CREATE TABLE public.mfa_recovery_codes (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  code_hash  text NOT NULL,               -- SHA-256 hex of the normalized code
  used_at    timestamptz,                 -- NULL until consumed
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_mfa_recovery_codes_user_id ON public.mfa_recovery_codes(user_id);
-- One row per (user, hash) so a regenerate that happens to collide can't
-- create duplicates; the lookup at consume-time is exact-hash anyway.
CREATE UNIQUE INDEX uniq_mfa_recovery_codes_user_hash
  ON public.mfa_recovery_codes(user_id, code_hash);

ALTER TABLE public.mfa_recovery_codes ENABLE ROW LEVEL SECURITY;

-- A user can SELECT their own rows (so the UI can show how many codes remain).
-- Hashes are useless to an attacker, and codes are generated/consumed only by
-- the edge service-role client (which bypasses RLS) — so there are deliberately
-- no INSERT/UPDATE/DELETE policies for end users.
CREATE POLICY "Users can view their own recovery codes"
  ON public.mfa_recovery_codes FOR SELECT
  USING (user_id = auth.uid());
