-- US-1706: search-terms report snapshot.
--
-- The daily ads sync pulls the Google Ads search-terms report (the actual
-- queries that triggered our ads) into this table so the analysis can mine
-- wasted spend (irrelevant queries → negative keywords) and opportunities
-- (converting queries with no exact keyword → new keywords). Operator table:
-- written by the sync (service role), read by the mining pass; deny-all RLS,
-- rls-guard registered. owner_user_id (operator naming) is who ran the sync.

CREATE TABLE IF NOT EXISTS public.ads_search_terms (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  platform              text NOT NULL,
  owner_user_id         uuid,
  search_term           text NOT NULL,
  matched_keyword       text,
  match_type            text,
  campaign_external_id  text,
  ad_group_external_id  text,
  impressions           bigint NOT NULL DEFAULT 0,
  clicks                bigint NOT NULL DEFAULT 0,
  cost_micros           bigint NOT NULL DEFAULT 0,
  conversions           numeric NOT NULL DEFAULT 0,
  conversion_value      numeric NOT NULL DEFAULT 0,
  window_start          date,
  window_end            date,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);

-- Idempotent upsert key: one aggregated row per query per ad group.
CREATE UNIQUE INDEX IF NOT EXISTS ads_search_terms_key_idx
  ON public.ads_search_terms (platform, ad_group_external_id, search_term);
CREATE INDEX IF NOT EXISTS ads_search_terms_cost_idx
  ON public.ads_search_terms (platform, cost_micros DESC);

ALTER TABLE public.ads_search_terms ENABLE ROW LEVEL SECURITY;

DROP TRIGGER IF EXISTS set_ads_search_terms_updated_at ON public.ads_search_terms;
CREATE TRIGGER set_ads_search_terms_updated_at
  BEFORE UPDATE ON public.ads_search_terms
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- US-1108 self-record footer.
insert into public.applied_migrations (version) values ('00386') on conflict do nothing;
