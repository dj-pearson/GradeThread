-- US-898: eBay sync & conflict-resolution console (Platform Admin Command Center).
--
-- The admin sync-runs console flags a flipdesk_sync_runs row that's been stuck in
-- 'running' longer than a configurable threshold. That threshold lives in the
-- settings registry (system_settings) so an operator can retune it WITHOUT a
-- deploy — mirroring the SYNC_STUCK_THRESHOLD_MIN env default (15 min) the cron
-- reaper uses (services/edge-functions/src/lib/sync-run-lock.ts), but
-- config-driven for the console (AC3).
insert into public.system_settings (key, value, value_type, default_value, category, description)
values (
  'marketplace_sync_stuck_threshold_min',
  to_jsonb(15),
  'number',
  to_jsonb(15),
  'marketplace',
  'US-898: minutes a flipdesk_sync_runs row may stay in ''running'' before the admin sync console flags it as STUCK. Mirrors the SYNC_STUCK_THRESHOLD_MIN env default used by the cron reaper, but config-driven (deploy-free).'
) on conflict (key) do nothing;
