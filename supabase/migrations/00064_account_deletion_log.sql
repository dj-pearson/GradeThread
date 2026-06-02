-- GDPR/CCPA deletion compliance record (US-275).
--
-- AC: "a minimal non-PII record of the deletion request is retained for
-- compliance." When a user erases their account we destroy every row keyed to
-- their auth.users id (ON DELETE CASCADE), so the proof-of-deletion record must
-- live in a table that is NOT cascade-linked to auth.users — hence a plain
-- uuid column with NO foreign key. Once the user row is gone the stored id is
-- an opaque, no-longer-resolvable identifier (it cannot be joined back to any
-- PII), which is exactly what a compliance trail needs: evidence that a given
-- account id was erased, on a given date, without retaining anything about the
-- person.

CREATE TABLE IF NOT EXISTS public.account_deletion_log (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- The erased account's id. Deliberately NOT a foreign key so it survives the
  -- auth.users cascade. Opaque + non-PII after deletion.
  deleted_user_id  uuid NOT NULL,
  requested_at     timestamptz NOT NULL DEFAULT now(),
  -- Coarse, non-PII context for audits. No email, name, or address ever.
  source           text NOT NULL DEFAULT 'self_serve',   -- 'self_serve' | 'admin' | 'support'
  had_stripe_customer boolean NOT NULL DEFAULT false,
  -- Best-effort outcome flags so an auditor can see external teardown ran.
  stripe_deleted   boolean NOT NULL DEFAULT false,
  storage_purged   boolean NOT NULL DEFAULT false
);

CREATE INDEX IF NOT EXISTS idx_account_deletion_log_requested_at
  ON public.account_deletion_log(requested_at);

-- Append-only compliance record. The edge endpoint writes via the service-role
-- client (bypasses RLS). Admins may read the trail; nobody may UPDATE or DELETE
-- through the API. RLS enabled with SELECT-for-admins only — no INSERT/UPDATE/
-- DELETE policies means those are denied for anon/auth roles.
ALTER TABLE public.account_deletion_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "account_deletion_log_admin_select"
  ON public.account_deletion_log
  FOR SELECT
  USING (public.is_admin());
