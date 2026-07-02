-- 00336: Right-size the Pro / Business monthly AI-action caps.
--
-- Unit-economics review (docs/SUBSCRIPTION_UNIT_ECONOMICS.md): at MAX cap
-- utilization the 1,000 (Pro) and 5,000 (Business) AI-action allowances let a
-- power user's AI COGS exceed the 40% gross-margin floor — Business could even go
-- negative. Realistic usage is ~10-15% of cap, so this trims the theoretical tail
-- without touching price or any real seller: the new caps are still ~3× the
-- heaviest realistic seller.
--
--   Pro       1,000 -> 750
--   Business  5,000 -> 2,000
--   (Free 25 / Starter 200 unchanged — already margin-safe.)
--
-- pricing_plans is the live runtime source (US-587); the compiled fallbacks
-- (FLIPDESK_PLANS in src/lib/constants.ts, FALLBACK_MATRIX in pricing-config.ts)
-- and the AI_ACTION_LIMITS table are updated in the same commit. The `features`
-- display bullet is corrected in lockstep so the plan card can't advertise a
-- number the gate no longer honors.
--
-- Idempotent: re-running sets the same int and the string replace is a no-op.

update public.pricing_plans
set
  ai_actions_per_month = 750,
  features = replace(features::text, '1,000 AI actions / month', '750 AI actions / month')::jsonb
where key = 'pro';

update public.pricing_plans
set
  ai_actions_per_month = 2000,
  features = replace(features::text, '5,000 AI actions / month', '2,000 AI actions / month')::jsonb
where key = 'business';

-- US-1108 self-record footer.
insert into public.applied_migrations (version) values ('00336') on conflict do nothing;
