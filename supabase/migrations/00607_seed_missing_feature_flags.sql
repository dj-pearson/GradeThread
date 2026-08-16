-- US-2653: four declared kill-switches had no row, so they could not be flipped.
--
-- `FeatureKey` in lib/feature-flags.ts declares 15 switches. Only 11 of them had
-- a row in public.feature_flags. The admin console lists ROWS (GET /admin/
-- feature-flags orders by key), and the toggle endpoint answers 404 "Unknown
-- feature flag" when there is none — so for the four below the switch existed in
-- the type system and nowhere an operator could reach.
--
-- Three of them promise operator control in their own comments:
--   forensic_grade        "disabled platform-wide without a redeploy"
--   passport_forecast     "an ops kill-switch"
--   trial_conversion_drip "the admin builder's kill flips it off so every
--                          replica hard-stops within the flag cache TTL"
--
-- BEHAVIOUR-NEUTRAL ON PURPOSE. All four are read fail-open today (no call site
-- passes defaultEnabled:false), and a missing row already resolves to enabled.
-- Seeding enabled=true therefore changes nothing at runtime; it only makes the
-- switch exist somewhere it can be turned off. Anything else would be a product
-- change smuggled in as plumbing.
--
-- ON CONFLICT DO NOTHING so an operator override survives a re-run, matching
-- 00096's seed.

insert into public.feature_flags (key, enabled, description) values
  ('forensic_grade', true,
   'Forensic Grade add-on: paid high-resolution defect-zoom re-analysis (US-1296). Kill-switch on top of the tier/opt-in/retention gate.'),
  ('passport_forecast', true,
   'Garment Passport resale-value and depreciation forecast (US-1104). Ops kill-switch on top of the compPulls plan gate.'),
  ('trial_conversion_drip', true,
   'Autonomous trial-conversion drip engine (US-943). /api/drip/tick gates on this; off hard-stops every replica within the flag cache TTL.'),
  ('inventory_equity', true,
   'Inventory equity snapshots and the equity surface (flipdesk-equity + jobs-equity-snapshot).')
on conflict (key) do nothing;

insert into public.applied_migrations (version) values ('00607') on conflict do nothing;
