-- US-3011: switch the shippingLabels gate flag on for Pro and Business.
--
-- pricing_plans.gate_flags is CANONICAL once the row exists (pricing-config.ts
-- load(): the DB row overwrites the hardcoded FALLBACK_MATRIX). The read is
-- `gateFlags[k] = flags[k] === true`, so a key that is absent from the row is a
-- hard false. Adding `shippingLabels` to the code without this migration would
-- ship label buying switched OFF on every plan, including the two that are sold
-- with it, and nothing would error. That is exactly what happened to
-- `connectorAccess` (US-2687 / 00625), and this file is its shape.
--
-- Values match FALLBACK_MATRIX in services/edge-functions/src/lib/pricing-config.ts
-- and FLIPDESK_PLANS in src/lib/constants.ts: free false, starter false,
-- pro true, business true.
--
-- ONLY WHERE THE KEY IS ABSENT, so an operator who has already set it keeps
-- their value and the file is safe to re-run.

update public.pricing_plans
   set gate_flags = gate_flags || jsonb_build_object('shippingLabels', false)
 where key in ('free', 'starter')
   and not (gate_flags ? 'shippingLabels');

update public.pricing_plans
   set gate_flags = gate_flags || jsonb_build_object('shippingLabels', true)
 where key in ('pro', 'business')
   and not (gate_flags ? 'shippingLabels');

insert into public.applied_migrations (version) values ('00696') on conflict do nothing;
