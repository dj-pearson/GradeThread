-- US-3206: say who may execute pooled_sold_comps, because right now nobody has.
--
-- 00762 created it SECURITY DEFINER and granted nothing, so it carries
-- Postgres's default EXECUTE to PUBLIC and is callable with the anon key from a
-- browser. The US-2282 guard (src/test/security-definer-grants.test.ts) has been
-- red on it since, and the guard is right: a SECURITY DEFINER function runs as
-- its owner with RLS bypassed, so one that never states who may call it has
-- inherited an answer rather than made one.
--
-- WHAT THIS IS AND IS NOT. It is a GRANT to the role that actually calls the
-- function. It is NOT a revoke, and the difference matters more here than the
-- grant does.
--
-- ⚠ DELIBERATELY NO REVOKE, and that is not an oversight.
--
-- On this Postgres image a DENIED function call from anon or authenticated
-- SEGFAULTS the backend and restarts the database, because supautils appends a
-- GRANT hint to the error (US-2403). That is why 00527, the bulk revoke across
-- the schema, is parked and marked DO NOT APPLY. Adding a revoke here would
-- build exactly that crash surface, on a function reachable with the public
-- anon key, in exchange for closing a hole that is already bounded elsewhere.
-- The permission question belongs to US-2282/US-2403 and lands with them.
--
-- WHY THE EXPOSURE IS TOLERABLE MEANWHILE, stated so the next reader does not
-- have to re-derive it. pooled_sold_comps returns aggregates only, and returns
-- NO ROW at all below both k-anonymity floors -- at least 5 sales from at least
-- 3 distinct sellers. Those floors live inside the function, not in a caller,
-- so they hold for every caller including an anonymous one. What an anon caller
-- gains is a rate-limited view of medians that are already shown in the product;
-- what they cannot get is an individual sale, a seller, or a below-floor group.
--
-- The one caller today is the edge service, through supabaseAdmin.rpc in
-- services/edge-functions/src/lib/sold-comps.ts, which authenticates as
-- service_role. Naming it here makes the intent explicit and survives the day
-- the revoke finally becomes safe: at that point this line is the record of
-- which grant to keep.

GRANT EXECUTE ON FUNCTION public.pooled_sold_comps(text, text, int) TO service_role;

insert into public.applied_migrations (version) values ('00774') on conflict do nothing;
