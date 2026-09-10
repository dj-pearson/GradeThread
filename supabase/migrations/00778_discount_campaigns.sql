-- 00778_discount_campaigns.sql
--
-- US-3299: operator-scheduled, time-boxed discounts across every package.
--
-- One row = one sale. Status is DERIVED from starts_at/ends_at/enabled and is
-- never stored, so a window opens and closes on its own with no cron job and
-- nothing to forget to switch off. Sequential windows (20% through Oct 31, then
-- 15% from Nov 1) are just two rows.
--
-- The full contract - target shapes, the precedence chain against the three
-- existing per-user coupons, and the Stripe coupon lifecycle - is in
-- docs/superpowers/specs/2026-09-09-discount-campaigns-design.md.

create table if not exists public.discount_campaigns (
  id                uuid primary key default gen_random_uuid(),
  name              text        not null,
  description       text,
  discount_type     text        not null check (discount_type in ('percent', 'amount')),
  percent_off       numeric(5,2) check (percent_off > 0 and percent_off <= 100),
  amount_off_cents  integer      check (amount_off_cents > 0),
  starts_at         timestamptz not null,
  ends_at           timestamptz not null,
  enabled           boolean     not null default true,
  targets           jsonb       not null default '[]'::jsonb,
  applies_to_all    boolean     not null default false,
  stripe_coupon_id  text,
  stripe_sync_error text,
  revision          integer     not null default 0,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  created_by        uuid references auth.users(id) on delete set null,
  updated_by        uuid references auth.users(id) on delete set null,

  constraint discount_campaigns_window_ck check (ends_at > starts_at),

  -- Exactly one of the two value columns is populated, matching discount_type.
  -- Without this a row can carry percent_off = 20 AND amount_off_cents = 500,
  -- and which one Stripe honours depends on which branch of the mint code runs.
  constraint discount_campaigns_value_ck check (
    (discount_type = 'percent' and percent_off is not null and amount_off_cents is null)
    or
    (discount_type = 'amount' and amount_off_cents is not null and percent_off is null)
  ),

  constraint discount_campaigns_targets_ck check (jsonb_typeof(targets) = 'array')
);

comment on table public.discount_campaigns is
  'US-3299: time-boxed sale campaigns. Live/scheduled/expired is derived from starts_at, ends_at and enabled - never stored. See docs/superpowers/specs/2026-09-09-discount-campaigns-design.md.';

comment on column public.discount_campaigns.targets is
  'Array of {kind, key, interval?}. kind in (flipdesk_plan, buyer_plan, grade_tier, credit_pack, action_pack). interval (monthly|yearly) applies to subscription kinds only; absent means both. Ignored when applies_to_all is true.';

comment on column public.discount_campaigns.stripe_coupon_id is
  'The minted Stripe coupon. NULL means the sync failed - such a row is invisible to the public read policy and is never applied at checkout, because a discount shown on a card and refused at checkout is worse than no sale.';

comment on column public.discount_campaigns.revision is
  'Bumped on every money-affecting edit. Feeds the Stripe idempotency key, so a retried save reuses the coupon while a real edit mints a fresh one (Stripe coupons are immutable except name and metadata).';

-- The hot query is "every campaign live right now", run by every pricing
-- surface including logged-out ones.
create index if not exists discount_campaigns_window_idx
  on public.discount_campaigns (starts_at, ends_at)
  where enabled;

create index if not exists discount_campaigns_ends_at_idx
  on public.discount_campaigns (ends_at desc);

-- ── updated_at ────────────────────────────────────────────────────────────
drop trigger if exists set_discount_campaigns_updated_at on public.discount_campaigns;
create trigger set_discount_campaigns_updated_at
  before update on public.discount_campaigns
  for each row execute function public.set_updated_at();

-- ── RLS ───────────────────────────────────────────────────────────────────
--
-- Public READ, matching pricing_plans (00166): the pricing page has to price
-- correctly for a logged-out visitor, and the row carries no user data.
--
-- The policy narrows to campaigns that are LIVE RIGHT NOW and successfully
-- synced to Stripe, rather than exposing the table. Two reasons. A scheduled
-- campaign is a commercial decision that has not been announced - a visitor who
-- could read next month's sale out of the network tab would simply wait. And a
-- row with a null stripe_coupon_id would price a card at a discount that
-- checkout then refuses.
alter table public.discount_campaigns enable row level security;

drop policy if exists "discount_campaigns_public_read" on public.discount_campaigns;
create policy "discount_campaigns_public_read"
  on public.discount_campaigns for select
  to anon, authenticated
  using (
    enabled
    and stripe_coupon_id is not null
    and starts_at <= now()
    and ends_at > now()
  );

-- Writes are service-role only, through /api/admin/discounts (super_admin plus a
-- fresh MFA step-up, like the plan editor). This mirrors 00166 exactly.
--
-- NOTE this is a revoke on a TABLE, not on a function. The standing rule against
-- REVOKE in a new migration is about REVOKE ... ON FUNCTION: on this Postgres
-- image supautils appends a GRANT hint to a permission error and a denied
-- FUNCTION call from anon segfaults the backend (US-2403, and why 00527 is
-- parked). This file defines no functions. pricing_plans has carried the same
-- table revoke since 00166.
revoke insert, update, delete on public.discount_campaigns from anon, authenticated;

insert into public.applied_migrations (version) values ('00778') on conflict do nothing;
