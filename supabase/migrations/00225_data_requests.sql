-- US-903: Data subject request (export / delete) workflow.
--
-- A GDPR/CCPA-style operator queue for honoring data-portability and
-- right-to-erasure requests defensibly. Builds ON the existing
-- account_deletion_log (00064): that table stays the durable, non-PII proof of
-- an erasure; THIS table is the operational queue that tracks each request from
-- intake through completion (or rejection), records the export archive location,
-- and links the actor who handled it.
--
-- Tenancy / RLS: `data_requests` carries the subject user_id but is an OPERATOR
-- surface, not user-owned tenant data the SPA reads directly. RLS is enabled and
-- writes are revoked from anon/authenticated; the only policy is an admin SELECT
-- (mirroring account_deletion_log). Every read + mutation flows through the
-- service-role edge client behind /api/admin/compliance/* (admin JWT + AAL2) and
-- the self-serve intake endpoint (/api/account/data-requests). No client write
-- path exists.

CREATE TYPE public.data_request_type AS ENUM ('export', 'delete');
CREATE TYPE public.data_request_status AS ENUM (
  'received',
  'processing',
  'completed',
  'rejected'
);

CREATE TABLE IF NOT EXISTS public.data_requests (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- The subject of the request (whose data is exported/erased). FK cascades so a
  -- hard self-serve deletion doesn't leave a dangling queue row; the durable
  -- compliance proof lives in account_deletion_log, not here.
  user_id       uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  type          public.data_request_type NOT NULL,
  status        public.data_request_status NOT NULL DEFAULT 'received',
  requested_at  timestamptz NOT NULL DEFAULT now(),
  completed_at  timestamptz,
  -- Storage path (in the private `compliance-exports` bucket) of the assembled
  -- export archive. Delivered to the operator via a short-TTL signed URL.
  file_path     text,
  -- Who initiated the request: the subject themselves (self-serve) or an admin
  -- acting on their behalf. No FK — an admin actor may later be removed.
  requested_by  uuid,
  -- 'self_serve' | 'admin' — coarse provenance for the audit trail.
  source        text NOT NULL DEFAULT 'self_serve',
  -- Operator notes / rejection reason / processing summary.
  notes         text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_data_requests_status_requested_at
  ON public.data_requests(status, requested_at DESC);
CREATE INDEX IF NOT EXISTS idx_data_requests_user_id
  ON public.data_requests(user_id);
CREATE INDEX IF NOT EXISTS idx_data_requests_type
  ON public.data_requests(type);

-- Auto-manage updated_at via the shared trigger (00001).
CREATE TRIGGER set_data_requests_updated_at
  BEFORE UPDATE ON public.data_requests
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- RLS: operator-managed. No INSERT/UPDATE/DELETE policy => those are denied for
-- anon/authenticated; only the service-role edge client (which bypasses RLS)
-- writes. Admins may read the queue.
ALTER TABLE public.data_requests ENABLE ROW LEVEL SECURITY;
REVOKE INSERT, UPDATE, DELETE ON public.data_requests FROM anon, authenticated;

CREATE POLICY "data_requests_admin_select"
  ON public.data_requests
  FOR SELECT
  USING (public.is_admin());

-- Private bucket for assembled export archives. No storage policies => deny-all
-- to anon/authenticated; only the service-role edge client reads/writes it (and
-- hands out short-TTL signed URLs). NOT public — these archives contain a user's
-- full data export.
INSERT INTO storage.buckets (id, name, public)
VALUES ('compliance-exports', 'compliance-exports', false)
ON CONFLICT (id) DO NOTHING;
