-- US-1698: Ads Command Center data model.
--
-- Local snapshots of our own Google Ads (and, later, Apple Search Ads) account
-- structure + daily performance, so the admin dashboard (US-1699) and the Claude
-- analysis engine (US-1701) read fast historical rows instead of hammering the
-- Ads API on every view. A nightly + on-demand sync (US-1698 route) upserts these.
--
-- OPERATOR tables: one platform-level Ads account, NOT per-user tenant data.
-- Deny-all RLS (service-role writes only, rls-guard enforced); the owner column
-- is named `owner_user_id` (never `user_id`) so the tenant-isolation guard does
-- not misclassify these as user-owned data. Every table carries a `platform`
-- column ('google_ads' | 'apple_search_ads') so both ad platforms share the model.

-- ── Accounts ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.ads_accounts (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  platform              text NOT NULL,
  owner_user_id         uuid,
  external_customer_id  text NOT NULL,
  descriptive_name      text,
  currency_code         text,
  time_zone             text,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS ads_accounts_key_idx
  ON public.ads_accounts (platform, external_customer_id);

-- ── Campaigns ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.ads_campaigns (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  platform              text NOT NULL,
  owner_user_id         uuid,
  external_id           text NOT NULL,
  name                  text,
  status                text,
  channel_type          text,
  budget_micros         bigint,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS ads_campaigns_key_idx
  ON public.ads_campaigns (platform, external_id);

-- ── Ad groups ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.ads_ad_groups (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  platform              text NOT NULL,
  owner_user_id         uuid,
  external_id           text NOT NULL,
  campaign_external_id  text,
  name                  text,
  status                text,
  type                  text,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS ads_ad_groups_key_idx
  ON public.ads_ad_groups (platform, external_id);

-- ── Ads ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.ads_ads (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  platform              text NOT NULL,
  owner_user_id         uuid,
  external_id           text NOT NULL,
  ad_group_external_id  text,
  ad_type               text,
  status                text,
  final_urls            text[],
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS ads_ads_key_idx
  ON public.ads_ads (platform, external_id);

-- ── Keywords ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.ads_keywords (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  platform              text NOT NULL,
  owner_user_id         uuid,
  external_id           text NOT NULL,
  ad_group_external_id  text,
  text                  text,
  match_type            text,
  status                text,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS ads_keywords_key_idx
  ON public.ads_keywords (platform, external_id);

-- ── Daily metrics (one row per entity per day) ───────────────────────
CREATE TABLE IF NOT EXISTS public.ads_metrics_daily (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  platform              text NOT NULL,
  owner_user_id         uuid,
  -- 'campaign' | 'ad_group' | 'ad' | 'keyword'
  entity_type           text NOT NULL,
  -- the entity's external_id (matches the *_external_id above)
  entity_id             text NOT NULL,
  metric_date           date NOT NULL,
  impressions           bigint NOT NULL DEFAULT 0,
  clicks                bigint NOT NULL DEFAULT 0,
  cost_micros           bigint NOT NULL DEFAULT 0,
  conversions           numeric NOT NULL DEFAULT 0,
  conversion_value      numeric NOT NULL DEFAULT 0,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);
-- Idempotent upsert key: re-running a day overwrites the same row.
CREATE UNIQUE INDEX IF NOT EXISTS ads_metrics_daily_key_idx
  ON public.ads_metrics_daily (platform, entity_type, entity_id, metric_date);

-- ── Sync-run ledger ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.ads_sync_runs (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  platform              text NOT NULL,
  owner_user_id         uuid,
  status                text NOT NULL DEFAULT 'running',
  started_at            timestamptz NOT NULL DEFAULT now(),
  finished_at           timestamptz,
  counts                jsonb NOT NULL DEFAULT '{}'::jsonb,
  error                 text
);
CREATE INDEX IF NOT EXISTS ads_sync_runs_started_idx
  ON public.ads_sync_runs (platform, started_at DESC);

-- ── Deny-all RLS + updated_at triggers ───────────────────────────────
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'ads_accounts','ads_campaigns','ads_ad_groups','ads_ads',
    'ads_keywords','ads_metrics_daily','ads_sync_runs'
  ] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY;', t);
  END LOOP;
END $$;

DROP TRIGGER IF EXISTS set_ads_accounts_updated_at ON public.ads_accounts;
CREATE TRIGGER set_ads_accounts_updated_at BEFORE UPDATE ON public.ads_accounts
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
DROP TRIGGER IF EXISTS set_ads_campaigns_updated_at ON public.ads_campaigns;
CREATE TRIGGER set_ads_campaigns_updated_at BEFORE UPDATE ON public.ads_campaigns
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
DROP TRIGGER IF EXISTS set_ads_ad_groups_updated_at ON public.ads_ad_groups;
CREATE TRIGGER set_ads_ad_groups_updated_at BEFORE UPDATE ON public.ads_ad_groups
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
DROP TRIGGER IF EXISTS set_ads_ads_updated_at ON public.ads_ads;
CREATE TRIGGER set_ads_ads_updated_at BEFORE UPDATE ON public.ads_ads
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
DROP TRIGGER IF EXISTS set_ads_keywords_updated_at ON public.ads_keywords;
CREATE TRIGGER set_ads_keywords_updated_at BEFORE UPDATE ON public.ads_keywords
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
DROP TRIGGER IF EXISTS set_ads_metrics_daily_updated_at ON public.ads_metrics_daily;
CREATE TRIGGER set_ads_metrics_daily_updated_at BEFORE UPDATE ON public.ads_metrics_daily
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- US-1108 self-record footer.
insert into public.applied_migrations (version) values ('00381') on conflict do nothing;
