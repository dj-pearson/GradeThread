-- US-2687: every paid plan is denied the Claude connector, including the two
-- that are sold with it.
--
-- pricing_plans.gate_flags is CANONICAL once the row exists (pricing-config.ts
-- load(): the DB row overwrites the hardcoded fallback). 00166 seeded the four
-- tiers with the nine flags that existed then, and `connectorAccess` was added
-- to the code in US-9124 without a migration. The read is
-- `gateFlags[k] = flags[k] === true`, so an absent key is a hard false.
--
-- Nothing errors. A Business seller calling the connector is told
-- "not included in this plan ... see pricing to upgrade" — an upgrade prompt
-- shown to the customer already on the top tier.
--
-- Values match FALLBACK_MATRIX in services/edge-functions/src/lib/pricing-config.ts:
-- free false, starter false, pro true, business true.
--
-- ONLY WHERE THE KEY IS ABSENT. An operator who has already set it — including
-- deliberately to false on pro — keeps their value, matching the ON CONFLICT DO
-- NOTHING posture of 00166, 00607 and 00623. That also makes this safe to
-- re-run, which apply-prod-migrations.sh does by design.

update public.pricing_plans
   set gate_flags = gate_flags || jsonb_build_object('connectorAccess', false)
 where key in ('free', 'starter')
   and not (gate_flags ? 'connectorAccess');

update public.pricing_plans
   set gate_flags = gate_flags || jsonb_build_object('connectorAccess', true)
 where key in ('pro', 'business')
   and not (gate_flags ? 'connectorAccess');

insert into public.applied_migrations (version) values ('00625') on conflict do nothing;
