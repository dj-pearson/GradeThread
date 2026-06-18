-- US-1055: offer & return/dispute notifications across all channels.
--
-- Adds three notification_type enum values for the time-sensitive marketplace
-- events that were previously silent:
--   • offer_responded — a buyer offer was accepted / declined / countered.
--   • return_opened   — a buyer opened a return (Post-Order API).
--   • dispute_opened  — a payment dispute / chargeback was opened (the seller
--                       must respond before eBay's respondByDate).
-- (`offer_received` already exists from US-1056's enum work.)
--
-- ADD VALUE IF NOT EXISTS is idempotent and safe to run outside a using-
-- transaction (we never reference the new values later in this migration).
ALTER TYPE notification_type ADD VALUE IF NOT EXISTS 'offer_responded';
ALTER TYPE notification_type ADD VALUE IF NOT EXISTS 'return_opened';
ALTER TYPE notification_type ADD VALUE IF NOT EXISTS 'dispute_opened';

-- Idempotency ledger for marketplace-event notifications. The poll re-fetches
-- the SAME open offers/returns/disputes from eBay every tick, so a row here
-- proves "already notified for this (user, source, external id, status)" and a
-- unique-violation on insert means skip. The status component lets an offer
-- notify once when first seen (offer_received) and again when its status moves
-- (offer_responded) without re-notifying on every steady-state poll; returns
-- and disputes use a constant 'opened' sentinel so they fire exactly once.
--
-- Service-role-only (deny-all to anon/authenticated): written + read ONLY by the
-- edge service's marketplace-event poll/notify path; the SPA never touches it.
-- Classified in SERVICE_ROLE_ONLY in services/edge-functions/src/tests/rls-guard_test.ts.
create table if not exists public.marketplace_event_notifications (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null references public.users(id) on delete cascade,
  -- 'offer' | 'return' | 'dispute'
  source_kind       text not null,
  -- eBay-side id: bestOfferId / returnId / paymentDisputeId.
  external_id       text not null,
  -- The marketplace status this notification was emitted FOR (raw offer status,
  -- or the 'opened' sentinel for returns/disputes). Part of the dedup key.
  status            text not null,
  -- The notification_type that was emitted (for auditing / backfill).
  notification_type text not null,
  created_at        timestamptz not null default now(),
  unique (user_id, source_kind, external_id, status)
);

create index if not exists marketplace_event_notifications_user_idx
  on public.marketplace_event_notifications (user_id, created_at desc);

alter table public.marketplace_event_notifications enable row level security;
revoke all on public.marketplace_event_notifications from anon, authenticated;
