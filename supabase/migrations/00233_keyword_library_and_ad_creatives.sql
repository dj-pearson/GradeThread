-- US-1073: AI ad-copy generation & refinement from the keyword library.
--
-- Acquisition/Ads epic. Two new operator-curated tables back the admin Ad Copy
-- Studio:
--
--   1. keyword_library — the curated set of keyword THEMES (a named cluster of
--      buyer-intent phrases tied to an SEO pillar) the marketer selects from when
--      drafting Google Ads RSA copy / Apple Search Ads keyword sets. Admin
--      reference data, not tenant-owned: deny-all RLS, service-role only; the SPA
--      reads/writes it ONLY via the role-gated /api/admin/ads endpoints.
--
--   2. ad_creatives — saved generations (RSA headlines/descriptions or ASA
--      keyword/creative sets). Each row records the source theme ids + the flat
--      list of source keywords so a later campaign can attribute performance back
--      to the keyword themes that seeded the copy. Operator surface: deny-all RLS,
--      service-role only.
--
-- Cost for every generation is recorded to ai_usage_events with feature='ads'
-- (the limiter captures it automatically inside enterAiFeature("ads", …)).

-- ────────────────────────────────────────────────────────────────────
-- 1. keyword_library — curated keyword themes (admin reference data)
-- ────────────────────────────────────────────────────────────────────
create table if not exists public.keyword_library (
  id          uuid primary key default gen_random_uuid(),
  -- Human-readable theme name, e.g. "Condition grading for resellers".
  theme       text not null,
  -- Which ad platform(s) this theme is intended to seed copy for.
  platform    text not null default 'both'
                check (platform in ('google_ads', 'apple_search_ads', 'both')),
  -- The buyer-intent keyword phrases that make up this theme. The generator
  -- folds these into the prompt as the demand signal to ground copy in.
  keywords    text[] not null default '{}',
  -- Optional link to the canonical SEO pillar (content_knowledge 'seo.pillars').
  pillar      text,
  -- Free-form notes / angle guidance for the marketer.
  notes       text,
  -- Soft archive without deleting (themes feed historical attribution).
  is_active   boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists idx_keyword_library_active
  on public.keyword_library(is_active, created_at desc);

create trigger set_keyword_library_updated_at
  before update on public.keyword_library
  for each row execute function public.set_updated_at();

-- RLS enabled with ZERO policies by design: anon/authenticated get nothing; only
-- the service-role edge client (the role-gated /api/admin/ads endpoints) reads or
-- writes it. Curated marketing reference data, not user-owned. (Classified in
-- rls-guard_test.ts SERVICE_ROLE_ONLY.)
alter table public.keyword_library enable row level security;
revoke all on public.keyword_library from anon, authenticated;

comment on table public.keyword_library is
  'US-1073: curated keyword THEMES (named clusters of buyer-intent phrases) the '
  'marketer selects from when drafting ad copy. Admin reference data; '
  'service-role only, deny-all RLS.';

-- ────────────────────────────────────────────────────────────────────
-- 2. ad_creatives — saved ad-copy generations (operator surface)
-- ────────────────────────────────────────────────────────────────────
create table if not exists public.ad_creatives (
  id                uuid primary key default gen_random_uuid(),
  platform          text not null
                      check (platform in ('google_ads', 'apple_search_ads')),
  -- Optional label for the saved set.
  name              text,
  -- The keyword_library themes this generation was seeded from.
  source_theme_ids  uuid[] not null default '{}',
  -- The flat list of source keywords (denormalized from the themes at save time)
  -- so performance can be attributed back even if a theme is later edited.
  source_keywords   text[] not null default '{}',
  -- The generated variants. Shape depends on platform:
  --   google_ads      → { headlines: [{text,chars}], descriptions: [{text,chars}] }
  --   apple_search_ads→ { keywords: {exact:[],broad:[]}, creative: [{text,chars}] }
  payload           jsonb not null default '{}'::jsonb,
  -- The model that produced this set (for audit / cost reconciliation).
  model             text,
  -- The admin who saved it (operator attribution, NOT a tenant key).
  created_by        uuid references public.users(id) on delete set null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create index if not exists idx_ad_creatives_platform_created
  on public.ad_creatives(platform, created_at desc);

create trigger set_ad_creatives_updated_at
  before update on public.ad_creatives
  for each row execute function public.set_updated_at();

-- RLS enabled, zero policies by design (service-role only, deny-all). Saved by
-- and read ONLY via the role-gated /api/admin/ads endpoints; the SPA never reads
-- it directly. (Classified in rls-guard_test.ts SERVICE_ROLE_ONLY.)
alter table public.ad_creatives enable row level security;
revoke all on public.ad_creatives from anon, authenticated;

comment on table public.ad_creatives is
  'US-1073: saved AI ad-copy generations (Google Ads RSA / Apple Search Ads), '
  'tagged with source keyword themes for performance attribution. Operator '
  'surface; service-role only, deny-all RLS.';

-- ────────────────────────────────────────────────────────────────────
-- 3. Seed a starter set of keyword themes so the studio is usable on day one.
-- ────────────────────────────────────────────────────────────────────
insert into public.keyword_library (theme, platform, keywords, pillar, notes)
values
  (
    'Condition grading for resellers',
    'both',
    array[
      'clothing condition grading',
      'used clothing grade',
      'garment condition report',
      'resale condition score',
      'pre-owned clothing grading'
    ],
    'condition-vocabulary',
    'Core value prop: standardized, AI-backed condition grades for pre-owned apparel.'
  ),
  (
    'eBay seller workflow tools',
    'google_ads',
    array[
      'ebay listing tool',
      'reseller inventory software',
      'ebay lister app',
      'thrift flipping software',
      'cross list to ebay'
    ],
    'category-grading',
    'FlipDesk angle: source → grade → list → sell pipeline for eBay resellers.'
  ),
  (
    'Shareable grading certificates',
    'apple_search_ads',
    array[
      'clothing authentication certificate',
      'condition certificate',
      'verified seller badge',
      'garment grade report'
    ],
    'defect-taxonomy',
    'Trust angle: public certificate + verified-seller proof to lift sell-through.'
  )
on conflict do nothing;
