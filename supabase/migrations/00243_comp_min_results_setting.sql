-- US-1060: configurable minimum-results threshold for the comp broadening ladder.
--
-- The zero-result fallback ladder (services/edge-functions/src/lib/comps-ladder.ts)
-- broadens a comp search — drop size → drop trailing title tokens → brand+category
-- → category — and stops at the first rung that returns at least this many active
-- comps. Seeding it into the settings registry (system_settings, 00207/00208) lets
-- an operator retune the bar deploy-free via the admin settings editor.
--
-- The key matches COMP_MIN_RESULTS_SETTING_KEY in comps-ladder.ts; the value
-- matches DEFAULT_MIN_COMP_RESULTS. `on conflict do nothing` so a manual override
-- applied before a re-run is never clobbered.
insert into public.system_settings (key, value, value_type, default_value, category, description)
values (
  'comps_min_results',
  to_jsonb(5),
  'number',
  to_jsonb(5),
  'comps',
  'US-1060: minimum active comps a broadening rung must return before the comp ladder stops broadening (drop size → drop title tokens → brand+category → category). Lower = stays narrow/precise; higher = broadens more aggressively to fill the panel.'
) on conflict (key) do nothing;
