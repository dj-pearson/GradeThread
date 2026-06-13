-- US-589: bulk admin operations (bulk credit grant, bulk suspend/unsuspend,
-- bulk re-grade). Every admin action was single-record until now; an operator
-- applying a promo or recovering from a prompt regression had to click each row.
--
-- This table is the idempotency + audit ledger for bulk runs. The edge handlers
-- in admin-bulk.ts CLAIM a run by inserting a row keyed on a client-supplied
-- idempotency_key (UNIQUE). A duplicate delivery (double-click, network retry)
-- collides on that key and the handler replays the stored result instead of
-- re-applying the action — which matters most for credit grants, the one
-- non-idempotent primitive (grant_grade_credits is additive). suspend/regrade
-- set a target state and are naturally repeatable, but go through the same gate
-- for a uniform, attributable trail.
--
-- This is in addition to admin_audit_log (one row written per bulk run via
-- writeAuditLog) — admin_audit_log is the forensic log; this table is the
-- dedup/claim record + per-target outcome breakdown.

CREATE TABLE IF NOT EXISTS public.bulk_admin_operations (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Client-supplied key (a UUID per user-initiated bulk submission). UNIQUE so a
  -- retry of the SAME logical operation can't double-apply.
  idempotency_key text NOT NULL UNIQUE,
  admin_user_id   uuid REFERENCES public.users(id) ON DELETE SET NULL,
  action          text NOT NULL CHECK (action IN ('grant_credits', 'suspend', 'unsuspend', 'regrade')),
  target_count    integer NOT NULL DEFAULT 0,
  -- Action params (e.g. {credits, reason} for grant_credits). No secrets.
  params          jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Per-target outcome summary, filled in once the run completes.
  result          jsonb,
  status          text NOT NULL DEFAULT 'processing' CHECK (status IN ('processing', 'completed', 'failed')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  completed_at    timestamptz
);

CREATE INDEX IF NOT EXISTS idx_bulk_admin_ops_admin
  ON public.bulk_admin_operations (admin_user_id, created_at DESC);

-- Service-role only: the edge handlers use the service-role client (bypasses
-- RLS). Enable RLS with NO policies so a leaked anon/authenticated key can never
-- read the operation ledger or forge a row.
ALTER TABLE public.bulk_admin_operations ENABLE ROW LEVEL SECURITY;
