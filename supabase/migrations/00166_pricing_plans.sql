-- US-587: data-driven plan pricing + limits.
--
-- Before this, FlipDesk plan prices/limits lived in src/lib/constants.ts
-- (FLIPDESK_PLANS) + the edge mirror in lib/plan-gate.ts (PLAN_MATRIX), and the
-- Stripe price IDs were env vars (STRIPE_PRICE_FLIPDESK_*). Any pricing or limit
-- change was a code deploy. This table makes them editable from admin: the edge
-- reads it (with a short cache) for enforcement + checkout, and the SPA reads it
-- (anon SELECT) so pricing surfaces stay in sync without a rebuild.
--
-- Fallback: an empty stripe_price_* still resolves to the matching env var in the
-- edge loader, and a missing row falls back to the hardcoded matrix — so a fresh
-- deploy that hasn't applied this migration keeps working.

create table if not exists public.pricing_plans (
  key                                text primary key
                                       check (key in ('free','starter','pro','business')),
  name                               text not null,
  sort_order                         int  not null default 0,
  -- Display + checkout pricing (cents).
  price_monthly_cents                int  not null default 0,
  price_yearly_cents                 int  not null default 0,
  -- Enforced limits. -1 = unlimited (active listings) / all (marketplaces).
  active_listing_cap                 int  not null,
  ai_actions_per_month               int  not null,
  marketplaces_cap                   int  not null,
  included_standard_grades_per_month int  not null,
  team_seat_cap                      int  not null default 0,
  -- Display feature bullets (string[]) + boolean feature gates (GateFlags shape).
  features                           jsonb not null default '[]'::jsonb,
  gate_flags                         jsonb not null default '{}'::jsonb,
  -- Stripe recurring price IDs. Empty string → edge falls back to env var.
  stripe_price_monthly               text not null default '',
  stripe_price_yearly                text not null default '',
  updated_at                         timestamptz not null default now(),
  updated_by                         uuid references public.users(id) on delete set null
);

comment on table public.pricing_plans is
  'US-587: data-driven FlipDesk plan pricing + limits + Stripe price IDs. Edge reads it for enforcement/checkout (short cache); SPA reads it for display. Empty stripe_price_* → env fallback; missing row → hardcoded matrix fallback.';

-- Seed the four tiers from the launch values (mirrors FLIPDESK_PLANS / PLAN_MATRIX).
-- marketplaces_cap = 1 for every tier: only eBay publishes at launch, so this
-- matches both the display ("eBay") and the effective cap. Operators raise it
-- per-tier here (no deploy) when additional marketplaces ship. ON CONFLICT keeps
-- any operator override if the migration is re-run.
insert into public.pricing_plans
  (key, name, sort_order, price_monthly_cents, price_yearly_cents,
   active_listing_cap, ai_actions_per_month, marketplaces_cap,
   included_standard_grades_per_month, team_seat_cap, features, gate_flags)
values
  ('free', 'Free', 0, 0, 0,
   25, 25, 1, 3, 0,
   '["25 active listings","eBay only","25 AI actions / month","3 free Standard grades / month"]'::jsonb,
   '{"bulkActions":false,"scheduledActions":false,"compPulls":false,"autoRelist":false,"subAccounts":false,"apiAccess":false,"reconciliation":false,"prioritySupport":false,"autolister":false}'::jsonb),
  ('starter', 'Starter', 1, 2900, 29000,
   250, 200, 1, 10, 0,
   '["250 active listings","eBay listings & sync (more marketplaces coming soon)","200 AI actions / month","10 Standard grades included / month","Auto-import payouts"]'::jsonb,
   '{"bulkActions":false,"scheduledActions":false,"compPulls":false,"autoRelist":false,"subAccounts":false,"apiAccess":false,"reconciliation":false,"prioritySupport":false,"autolister":false}'::jsonb),
  ('pro', 'Pro', 2, 5900, 59000,
   1000, 1000, 1, 30, 0,
   '["1,000 active listings","eBay listings & sync (more marketplaces coming soon)","1,000 AI actions / month","30 Standard grades included / month","Bulk actions + scheduled actions","AI AutoLister — bulk photos to eBay listings","AI comp pulls","Auto-relist"]'::jsonb,
   '{"bulkActions":true,"scheduledActions":true,"compPulls":true,"autoRelist":true,"subAccounts":false,"apiAccess":false,"reconciliation":false,"prioritySupport":false,"autolister":true}'::jsonb),
  ('business', 'Business', 3, 9900, 99000,
   -1, 5000, 1, 75, 10,
   '["Unlimited active listings","eBay listings & sync (more marketplaces coming soon)","5,000 AI actions / month","75 Standard grades included / month","AI AutoLister — bulk photos to eBay listings","Sub-accounts (team seats)","Programmatic API access","Payout reconciliation","Priority support"]'::jsonb,
   '{"bulkActions":true,"scheduledActions":true,"compPulls":true,"autoRelist":true,"subAccounts":true,"apiAccess":true,"reconciliation":true,"prioritySupport":true,"autolister":true}'::jsonb)
on conflict (key) do nothing;

create or replace function public.set_pricing_plans_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_pricing_plans_updated_at on public.pricing_plans;
create trigger trg_pricing_plans_updated_at
  before update on public.pricing_plans
  for each row execute function public.set_pricing_plans_updated_at();

-- Pricing is public-facing: anon + authenticated may READ the live config (the
-- SPA renders prices/limits from it). Stripe price IDs are not secret. Writes are
-- service-role only (the audited admin edge route) — clients can never mutate.
alter table public.pricing_plans enable row level security;

drop policy if exists "pricing_plans_public_read" on public.pricing_plans;
create policy "pricing_plans_public_read"
  on public.pricing_plans for select
  to anon, authenticated
  using (true);

revoke insert, update, delete on public.pricing_plans from anon, authenticated;
