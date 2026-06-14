-- US-885: DB-driven grading-tier prices + credit-pack prices (pricing_config).
--
-- Plan entitlements (per-plan included grades / AI-action caps / feature gates /
-- Stripe price IDs) are ALREADY data-driven via the pricing_plans table
-- (migration 00166, US-587) — read by the edge plan-gate + grade-billing and by
-- the SPA pricing surfaces. US-885's "plan_config" requirement is therefore
-- satisfied by pricing_plans; we deliberately do NOT add a second, redundant
-- plan_config table (it would desync from the table everything already reads).
--
-- What was still hardcoded — and is what this migration moves into the DB — is
-- the per-grading-tier pricing (TIER_PRICE_CENTS / TIER_CREDIT_COST + SLA in
-- grade-pricing.ts) and the credit-pack prices (CREDIT_PACKS in
-- src/lib/constants.ts). pricing_config makes those editable from admin without a
-- code deploy; the edge reads it (short cache) for charge/credit math, and the
-- SPA can read it for display.
--
-- Stripe is the source of truth for the ACTUAL charge amount: stripe_price_ref
-- holds only the NAME of the env var that carries the live Stripe price id (e.g.
-- 'STRIPE_PRICE_GRADE_STANDARD'). We never store or overwrite the Stripe price id
-- itself here — editing a row updates what we DISPLAY + the included/credit math,
-- not what Stripe charges.
--
-- Fallback: a missing row falls back to the hardcoded constants in the edge
-- loader, so a fresh deploy that hasn't applied this migration keeps working.

create table if not exists public.pricing_config (
  -- Stable composite id, e.g. 'grade_tier:standard' or 'credit_pack:10'.
  id              text primary key,
  kind            text not null check (kind in ('grade_tier', 'credit_pack')),
  sort_order      int  not null default 0,
  label           text not null,
  -- Display / charge-hint price in cents (>= 0). For a grade tier this is the
  -- single-grade price; for a credit pack it is the pack price.
  price_cents     int  not null check (price_cents >= 0),
  -- Grade-tier-only columns (null for credit packs):
  --   tier_key    — 'standard' | 'premium' | 'express'
  --   credit_cost — credits one purchase at this tier consumes
  --   sla_hours   — turnaround SLA
  tier_key        text check (tier_key in ('standard', 'premium', 'express')),
  credit_cost     int  check (credit_cost is null or credit_cost >= 0),
  sla_hours       int  check (sla_hours is null or sla_hours >= 0),
  -- Credit-pack-only column (null for grade tiers): how many credits the pack
  -- grants.
  credits         int  check (credits is null or credits > 0),
  -- The NAME of the env var holding the live Stripe price id (documentation only;
  -- never the secret). Display-only — not editable from the admin API.
  stripe_price_ref text not null default '',
  updated_at      timestamptz not null default now(),
  updated_by      uuid references public.users(id) on delete set null
);

comment on table public.pricing_config is
  'US-885: data-driven per-grading-tier + per-credit-pack pricing. Edge reads it (short cache) for grade charge/credit math; missing row → hardcoded constant fallback. stripe_price_ref names the env var with the live Stripe price id — Stripe stays the source of truth for the actual charge amount.';

-- Seed exactly matching today's constants:
--   GRADETHREAD_TIERS (src/lib/constants.ts) + TIER_PRICE_CENTS / TIER_CREDIT_COST
--   (services/edge-functions/src/lib/grade-pricing.ts)
--   CREDIT_PACKS (src/lib/constants.ts)
-- A parity test (pricing-config_test.ts) asserts these seeded values equal the
-- legacy constants so nothing changes on launch. ON CONFLICT keeps operator
-- overrides if the migration is re-run.
insert into public.pricing_config
  (id, kind, sort_order, label, price_cents, tier_key, credit_cost, sla_hours, credits, stripe_price_ref)
values
  ('grade_tier:standard', 'grade_tier', 0, 'Standard',  299, 'standard', 1, 48, null, 'STRIPE_PRICE_GRADE_STANDARD'),
  ('grade_tier:premium',  'grade_tier', 1, 'Premium',   799, 'premium',  3, 12, null, 'STRIPE_PRICE_GRADE_PREMIUM'),
  ('grade_tier:express',  'grade_tier', 2, 'Express',  1299, 'express',  5,  1, null, 'STRIPE_PRICE_GRADE_EXPRESS'),
  ('credit_pack:10',  'credit_pack', 0, '10 credits',   2499, null, null, null,  10, 'STRIPE_PRICE_CREDITS_10'),
  ('credit_pack:25',  'credit_pack', 1, '25 credits',   5999, null, null, null,  25, 'STRIPE_PRICE_CREDITS_25'),
  ('credit_pack:50',  'credit_pack', 2, '50 credits',  10999, null, null, null,  50, 'STRIPE_PRICE_CREDITS_50'),
  ('credit_pack:100', 'credit_pack', 3, '100 credits', 19999, null, null, null, 100, 'STRIPE_PRICE_CREDITS_100')
on conflict (id) do nothing;

create or replace function public.set_pricing_config_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_pricing_config_updated_at on public.pricing_config;
create trigger trg_pricing_config_updated_at
  before update on public.pricing_config
  for each row execute function public.set_pricing_config_updated_at();

-- Pricing is public-facing (the SPA can render grade-tier + credit-pack prices
-- from it). Stripe price IDs are NOT stored here, so nothing secret is exposed.
-- Writes are service-role only (the audited admin edge route).
alter table public.pricing_config enable row level security;

drop policy if exists "pricing_config_public_read" on public.pricing_config;
create policy "pricing_config_public_read"
  on public.pricing_config for select
  to anon, authenticated
  using (true);

revoke insert, update, delete on public.pricing_config from anon, authenticated;

-- US-885 (AC#5): snapshot the per-period included-grade allowance on the user the
-- moment a billing period resets, so an admin lowering/raising a plan's included
-- grade count mid-cycle takes effect on the NEXT period reset — never
-- retroactively granting or revoking included grades already accounted for in the
-- current period. Nullable: a null (legacy / not-yet-reset row) falls back to the
-- live cap in the edge resolver, so behavior is unchanged until the first reset.
alter table public.users
  add column if not exists included_grades_this_period int;

comment on column public.users.included_grades_this_period is
  'US-885: included-grade cap snapshotted at the start of the current billing period. Resolver uses this during the period and the live pricing_plans cap on the next reset, so config changes are not retroactive. Null → fall back to the live cap.';
