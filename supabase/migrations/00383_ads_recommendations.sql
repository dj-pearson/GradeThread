-- US-1701: Claude Ads analysis — recommendation store.
--
-- The report-only analysis pass (services/edge-functions/src/lib/ads-analysis.ts)
-- reads the synced ads_* snapshots + conversion signals, asks Claude for
-- prioritized optimization recommendations, and writes them here. NOTHING is
-- applied automatically — a recommendation stays 'proposed' until the guarded
-- apply flow (US-1703) acts on its machine-applyable payload.
--
-- OPERATOR table: written by the analysis pass (service role), read by the
-- Command Center. Deny-all RLS, rls-guard registered. owner_user_id (operator
-- naming, nullable) is who triggered the run — NOT a tenant key.

CREATE TABLE IF NOT EXISTS public.ads_recommendations (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  platform         text NOT NULL,
  owner_user_id    uuid,
  -- 'account' | 'campaign' | 'ad_group' | 'ad' | 'keyword'
  target_type      text NOT NULL,
  -- the entity's external id / resource name (may be '' for account-level)
  target_resource  text NOT NULL DEFAULT '',
  target_name      text,
  -- one of the fixed change_type enum (see ads-analysis.ts CHANGE_TYPES)
  change_type      text NOT NULL,
  rationale        text NOT NULL,
  -- 0..1
  confidence       numeric,
  -- e.g. { "spend_saved": 42.5, "conv_delta": 3 }
  projected_impact jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- machine-applyable payload for the US-1703 guarded apply
  payload          jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- 'low' | 'medium' | 'high' — for Command Center grouping
  severity         text,
  -- 'proposed' | 'applied' | 'dismissed'
  status           text NOT NULL DEFAULT 'proposed',
  generated_at     timestamptz NOT NULL DEFAULT now(),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ads_recommendations_status_idx
  ON public.ads_recommendations (platform, status, generated_at DESC);

ALTER TABLE public.ads_recommendations ENABLE ROW LEVEL SECURITY;

DROP TRIGGER IF EXISTS set_ads_recommendations_updated_at ON public.ads_recommendations;
CREATE TRIGGER set_ads_recommendations_updated_at
  BEFORE UPDATE ON public.ads_recommendations
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- US-1108 self-record footer.
insert into public.applied_migrations (version) values ('00383') on conflict do nothing;
