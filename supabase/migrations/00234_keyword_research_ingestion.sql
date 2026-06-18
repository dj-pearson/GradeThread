-- US-1072: keyword-research ingestion → keyword library (metrics layer).
--
-- US-1073 added `keyword_library` as curated keyword THEMES (named clusters the
-- marketer hand-picks to seed ad copy). This story adds the DEMAND-DATA layer
-- beneath it: individual keyword phrases with real metrics (search volume,
-- competition, CPC) pulled from the Google Ads API Keyword Plan idea service,
-- refreshable on a schedule. Ad copy / SEO / ASO can now be grounded in
-- measured demand instead of guesses.
--
-- Two tables, both admin reference data (deny-all RLS, service-role only; the
-- SPA reads/writes them ONLY via the role-gated /api/admin/ads endpoints):
--
--   1. keyword_research_terms — one row per keyword idea + its metrics, upserted
--      on (keyword, source) so a re-run refreshes metrics in place.
--   2. keyword_research_runs — one row per ingestion run (manual or scheduled),
--      for the admin audit trail / "last refreshed" surface.

-- ────────────────────────────────────────────────────────────────────
-- 1. keyword_research_terms — ingested keyword ideas with demand metrics
-- ────────────────────────────────────────────────────────────────────
create table if not exists public.keyword_research_terms (
  id                     uuid primary key default gen_random_uuid(),
  -- The keyword phrase (as returned by the source), e.g. "ebay listing tool".
  keyword                text not null,
  -- Coarse demand bucket the keyword was classified into at ingest time
  -- (grading, reselling, ebay, thrift, authentication, general), so the
  -- operator can browse/filter/group by theme. NULL until classified.
  theme                  text,
  -- Google Keyword Planner "avg monthly searches" over the trailing window.
  avg_monthly_searches   bigint,
  -- Competition bucket as reported by Google: low | medium | high | unspecified.
  competition            text not null default 'unspecified'
                           check (competition in ('low', 'medium', 'high', 'unspecified')),
  -- 0–100 competition index (finer-grained than the bucket above).
  competition_index      integer,
  -- Top-of-page bid range in dollars (derived from Google's *_micros fields).
  cpc_low                numeric(10, 2),
  cpc_high               numeric(10, 2),
  -- Which ingestion source produced the row (future-proofs non-Google sources).
  source                 text not null default 'google_ads',
  -- The seed keyword that surfaced this idea (for provenance / dedup of seeds).
  seed_keyword           text,
  -- Soft archive without deleting (kept for historical attribution).
  is_active              boolean not null default true,
  -- The raw provider payload for this idea (audit / future re-parsing).
  raw                    jsonb,
  first_seen_at          timestamptz not null default now(),
  last_seen_at           timestamptz not null default now(),
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  -- One row per keyword per source; a re-run upserts metrics in place.
  unique (keyword, source)
);

create index if not exists idx_keyword_research_terms_theme
  on public.keyword_research_terms(theme, avg_monthly_searches desc nulls last);
create index if not exists idx_keyword_research_terms_volume
  on public.keyword_research_terms(avg_monthly_searches desc nulls last);
create index if not exists idx_keyword_research_terms_active
  on public.keyword_research_terms(is_active, last_seen_at desc);

create trigger set_keyword_research_terms_updated_at
  before update on public.keyword_research_terms
  for each row execute function public.set_updated_at();

-- RLS enabled, zero policies by design: only the service-role edge client (the
-- role-gated /api/admin/ads endpoints) reads or writes it. Curated marketing
-- reference data, not user-owned. (Classified in rls-guard_test.ts.)
alter table public.keyword_research_terms enable row level security;
revoke all on public.keyword_research_terms from anon, authenticated;

comment on table public.keyword_research_terms is
  'US-1072: ingested keyword ideas + demand metrics (volume, competition, CPC) '
  'from the Google Ads keyword planner. Admin reference data; service-role only, '
  'deny-all RLS.';

-- ────────────────────────────────────────────────────────────────────
-- 2. keyword_research_runs — ingestion audit trail
-- ────────────────────────────────────────────────────────────────────
create table if not exists public.keyword_research_runs (
  id                  uuid primary key default gen_random_uuid(),
  source              text not null default 'google_ads',
  -- 'manual' (operator clicked refresh) or 'scheduled' (cron).
  trigger             text not null default 'manual'
                        check (trigger in ('manual', 'scheduled')),
  status              text not null default 'running'
                        check (status in ('running', 'success', 'error', 'skipped')),
  -- The seed keywords this run expanded from.
  seeds               text[] not null default '{}',
  -- How many keyword ideas the source returned, and how many we upserted.
  keywords_returned   integer not null default 0,
  keywords_ingested   integer not null default 0,
  error               text,
  started_at          timestamptz not null default now(),
  finished_at         timestamptz,
  created_at          timestamptz not null default now()
);

create index if not exists idx_keyword_research_runs_created
  on public.keyword_research_runs(created_at desc);

alter table public.keyword_research_runs enable row level security;
revoke all on public.keyword_research_runs from anon, authenticated;

comment on table public.keyword_research_runs is
  'US-1072: audit trail for keyword-research ingestion runs (manual + scheduled). '
  'Admin reference data; service-role only, deny-all RLS.';
