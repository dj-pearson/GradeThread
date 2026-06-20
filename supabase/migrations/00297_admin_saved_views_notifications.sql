-- US-909: Admin saved views, bulk-safe filters & notification center.
--
-- Two new operator-owned tables, both additive + idempotent:
--
--  1. admin_saved_views — per-admin named filter sets for the admin list pages
--     (users / signals / tickets / reconciliation). `surface` namespaces a view
--     to one list page; `filter` is the serialized filter blob the page reloads.
--     Private to the owning admin (scoped by admin_user_id in the edge route).
--
--  2. admin_notifications — the admin notification center feed (assigned ticket,
--     critical ops event, job failure). Fed by emitOpsEvent() (the SINGLE event
--     pipeline) + ticket assignment, never a parallel notifier. `ops_event_id`
--     links a notification back to the ops_events row that produced it.
--
-- Both are operator surfaces, NOT user-owned tenant data: the owner column is
-- admin_user_id (deliberately not the literal `user_id`, so the rls-guard
-- tenant-table auto-discovery treats them as operator tables). RLS is enabled
-- with zero policies = deny-all to anon/authenticated; all access is via the
-- service-role edge client through the role-gated /api/admin/* endpoints. Listed
-- in rls-guard SERVICE_ROLE_ONLY.

BEGIN;

-- ── 1. Per-admin saved views ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.admin_saved_views (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  surface       text NOT NULL,
  name          text NOT NULL,
  filter        jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS admin_saved_views_owner_surface_idx
  ON public.admin_saved_views (admin_user_id, surface, created_at DESC);

DROP TRIGGER IF EXISTS set_admin_saved_views_updated_at ON public.admin_saved_views;
CREATE TRIGGER set_admin_saved_views_updated_at
  BEFORE UPDATE ON public.admin_saved_views
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

COMMENT ON TABLE public.admin_saved_views IS
  'US-909: per-admin named filter sets for the admin list pages. Private to the '
  'owning admin (scoped by admin_user_id in the edge route). Service-role only '
  '(deny-all RLS).';

-- Deny-all RLS: only the service-role client (which bypasses RLS) reads/writes.
ALTER TABLE public.admin_saved_views ENABLE ROW LEVEL SECURITY;

-- ── 2. Admin notification center feed ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.admin_notifications (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  type          text NOT NULL,
  body          text NOT NULL,
  link          text,
  ops_event_id  uuid,
  is_read       boolean NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- Unread-first feed read pattern: WHERE admin_user_id = $1 [AND is_read = false]
-- ORDER BY created_at DESC.
CREATE INDEX IF NOT EXISTS admin_notifications_owner_unread_idx
  ON public.admin_notifications (admin_user_id, is_read, created_at DESC);

DROP TRIGGER IF EXISTS set_admin_notifications_updated_at ON public.admin_notifications;
CREATE TRIGGER set_admin_notifications_updated_at
  BEFORE UPDATE ON public.admin_notifications
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

COMMENT ON TABLE public.admin_notifications IS
  'US-909: admin notification center feed (assigned ticket / critical ops event '
  '/ job failure). Fed by emitOpsEvent() + ticket assignment; ops_event_id links '
  'back to the ops_events row. Service-role only (deny-all RLS).';

-- Deny-all RLS: only the service-role client (which bypasses RLS) reads/writes.
ALTER TABLE public.admin_notifications ENABLE ROW LEVEL SECURITY;

COMMIT;

-- US-1108: self-record this migration's version so the edge schema-version
-- guard (US-778) stays in sync regardless of apply method.
INSERT INTO public.applied_migrations (version) VALUES ('00297')
ON CONFLICT (version) DO NOTHING;
