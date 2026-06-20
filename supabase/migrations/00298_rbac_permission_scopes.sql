-- US-908: Granular RBAC permission scopes + scoped admin roles.
--
-- The four fixed platform roles (user / reviewer / admin / super_admin) are
-- coarse: an `admin` can do everything except grant roles, with no way to give a
-- support agent grading + moderation access WITHOUT the full admin surface. This
-- adds a scope layer ON TOP OF the roles — purely additive, seeded so the
-- existing roles map to EXACTLY their current effective permissions (no behavior
-- change at launch; see the parity test rbac-scopes_test.ts).
--
-- Three operator-owned tables, all additive + idempotent:
--
--  1. permission_scopes — the catalog of assignable scopes (billing:write,
--     grading:review, moderation:write, content:publish, users:role). Pure
--     reference data; no ownership column.
--
--  2. role_scopes — which scopes each NON-super_admin role holds. super_admin is
--     implicit-all in code (never rows here), so this maps admin / reviewer
--     (user holds none). Seeded to match today's role checks.
--
--  3. admin_scope_grants — OPTIONAL per-admin additive grants beyond the role
--     (e.g. give one `admin` the users:role scope without making them
--     super_admin). admin_user_id is the operator the grant targets (deliberately
--     NOT the literal `user_id`, so the rls-guard tenant-table auto-discovery
--     treats it as an operator table, like admin_saved_views in 00297).
--
-- All three are operator surfaces, NOT user-owned tenant data. RLS is enabled
-- with zero policies = deny-all to anon/authenticated; all access is via the
-- service-role edge client through the role-gated /api/admin/scopes endpoints.
-- admin_scope_grants is listed in rls-guard SERVICE_ROLE_ONLY.

BEGIN;

-- ── 1. Scope catalog ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.permission_scopes (
  key         text PRIMARY KEY,
  label       text NOT NULL,
  description text NOT NULL DEFAULT '',
  category    text NOT NULL DEFAULT 'general',
  sort_order  integer NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.permission_scopes IS
  'US-908: catalog of assignable RBAC permission scopes. Reference data, '
  'service-role only (deny-all RLS); edited only via /api/admin/scopes.';

ALTER TABLE public.permission_scopes ENABLE ROW LEVEL SECURITY;

-- ── 2. Role → scopes mapping (non-super_admin roles) ─────────────────────────
CREATE TABLE IF NOT EXISTS public.role_scopes (
  role       public.user_role NOT NULL,
  scope_key  text NOT NULL REFERENCES public.permission_scopes(key) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (role, scope_key)
);

COMMENT ON TABLE public.role_scopes IS
  'US-908: which permission scopes each non-super_admin role holds. super_admin '
  'is implicit-all in code (never rows here). Service-role only (deny-all RLS).';

ALTER TABLE public.role_scopes ENABLE ROW LEVEL SECURITY;

-- ── 3. Per-admin additive scope grants (optional) ────────────────────────────
CREATE TABLE IF NOT EXISTS public.admin_scope_grants (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  scope_key     text NOT NULL REFERENCES public.permission_scopes(key) ON DELETE CASCADE,
  granted_by    uuid REFERENCES public.users(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (admin_user_id, scope_key)
);

CREATE INDEX IF NOT EXISTS admin_scope_grants_admin_idx
  ON public.admin_scope_grants (admin_user_id);

COMMENT ON TABLE public.admin_scope_grants IS
  'US-908: optional per-admin additive scope grants beyond the role (grant one '
  'admin a scope without changing their role). admin_user_id is the targeted '
  'operator. Service-role only (deny-all RLS).';

ALTER TABLE public.admin_scope_grants ENABLE ROW LEVEL SECURITY;

-- ── Seed the catalog ─────────────────────────────────────────────────────────
INSERT INTO public.permission_scopes (key, label, description, category, sort_order)
VALUES
  ('billing:write',    'Billing operations',           'Change plans, grant/adjust credits, issue refunds, and manage coupons.',          'billing',    10),
  ('grading:review',   'Grading review',               'Review and override AI grade outcomes in the human-review queue.',                'grading',    20),
  ('moderation:write', 'Content moderation',           'Approve or reject flagged submissions and take down listings/photos.',            'moderation', 30),
  ('content:publish',  'Content publishing',           'Create and publish blog posts, changelog entries, and newsletter issues.',        'content',    40),
  ('users:role',       'Role & permission management', 'Grant or revoke admin roles and edit which scopes a role or admin holds.',        'users',      50)
ON CONFLICT (key) DO NOTHING;

-- ── Seed role → scopes so existing roles map to TODAY's effective permissions ──
-- super_admin: implicit-all in code (no rows). admin: everything except role
-- management (role grants were always super_admin-only). reviewer: grading
-- review only (is_reviewer_or_admin). user: no admin scopes.
INSERT INTO public.role_scopes (role, scope_key)
VALUES
  ('admin',    'billing:write'),
  ('admin',    'grading:review'),
  ('admin',    'moderation:write'),
  ('admin',    'content:publish'),
  ('reviewer', 'grading:review')
ON CONFLICT (role, scope_key) DO NOTHING;

COMMIT;

-- US-1108: self-record this migration's version so the edge schema-version
-- guard (US-778) stays in sync regardless of apply method.
INSERT INTO public.applied_migrations (version) VALUES ('00298')
ON CONFLICT (version) DO NOTHING;
