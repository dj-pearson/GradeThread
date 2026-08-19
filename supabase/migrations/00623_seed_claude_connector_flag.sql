-- US-9127 AC7: a rollback for the Claude connector that does not need a deploy.
--
-- The connector is gated by MCP_ENABLED, an environment variable. Changing one
-- in Coolify means a redeploy, so "turn it off" is minutes long — and during
-- those minutes the surface you are trying to stop is still publishing
-- listings, repricing them and taking them off sale. That is not a rollback
-- plan for this surface.
--
-- lib/feature-flags.ts now declares `claude_connector`, and routes/mcp.ts checks
-- it on every method. This row is what makes it REACHABLE: the admin console
-- lists rows (GET /api/admin/feature-flags orders by key) and the toggle
-- endpoint answers 404 "Unknown feature flag" when there is none, so a declared
-- switch with no row is a switch that exists in the type system and nowhere an
-- operator can press it. That was 00607's whole lesson and this is the same
-- mistake avoided rather than repeated.
--
-- BEHAVIOUR-NEUTRAL. The flag is read fail-open (no defaultEnabled:false at the
-- call site), and a missing row already resolves to enabled, so seeding
-- enabled=true changes nothing at runtime. It only puts the switch somewhere it
-- can be turned off. The connector stays dark in production regardless, because
-- MCP_ENABLED is off and EITHER gate being off closes the endpoint.
--
-- ON CONFLICT DO NOTHING so an operator override survives a re-run, matching
-- 00096 and 00607.

insert into public.feature_flags (key, enabled, description) values
  ('claude_connector', true,
   'The Claude connector / MCP endpoint (US-9103..9131). Runtime kill switch on top of the MCP_ENABLED env var: either being off returns 404 on /mcp. Flip this to stop every replica within the flag cache TTL, with no deploy.')
on conflict (key) do nothing;

insert into public.applied_migrations (version) values ('00623') on conflict do nothing;
