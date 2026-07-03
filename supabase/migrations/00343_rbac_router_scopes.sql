-- US-1560: RBAC router-coverage scopes.
--
-- The granular scope system (00298) shipped with five scopes but enforcement
-- on only 4 of 48 admin routers. This seeds the four scope families that cover
-- the rest (ops / marketplace / support / growth), and grants ALL FOUR to the
-- `admin` role so enforcement lands with ZERO behavior change — an operator
-- then narrows roles or individual admins deliberately via the roles editor.
-- super_admin remains implicit-all (never enumerated in role_scopes).
--
-- The router→scope registry lives in code:
-- services/edge-functions/src/lib/admin-scope-map.ts (drift-guard tested).
--
-- ORDERING GUARANTEE: this migration ships in the same commit as the
-- EXPECTED_SCHEMA_VERSION bump and the requireScope() enforcement, so an edge
-- build that requires the new scopes boot-guards until this seed is applied —
-- admins can never be locked out by a code-before-seed deploy.

INSERT INTO public.permission_scopes (key, label, description, category, sort_order)
VALUES
  ('ops:write',        'Platform operations',    'Edit platform config, feature flags, the settings registry, pricing, saved views; trigger jobs and integrity actions.', 'ops',         60),
  ('marketplace:write','Marketplace operations', 'Manage marketplace connections, listing-pipeline operations, category mappings, and promoted-listings admin actions.',  'marketplace', 70),
  ('support:write',    'Support operations',     'Handle support tickets, send admin messages/notifications, and manage email suppressions.',                             'support',     80),
  ('growth:write',     'Growth & lifecycle',     'Manage growth campaigns, drip/journey lifecycle emails, and the waitlist.',                                             'growth',      90)
ON CONFLICT (key) DO NOTHING;

INSERT INTO public.role_scopes (role, scope_key)
VALUES
  ('admin', 'ops:write'),
  ('admin', 'marketplace:write'),
  ('admin', 'support:write'),
  ('admin', 'growth:write')
ON CONFLICT (role, scope_key) DO NOTHING;

-- US-1108 self-record footer.
INSERT INTO public.applied_migrations (version) VALUES ('00343')
ON CONFLICT (version) DO NOTHING;
