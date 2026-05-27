-- Pending downgrade tracking (US-217).
--
-- When a user clicks "Downgrade to <X>" we create a Stripe Subscription
-- Schedule with two phases: (1) current plan through period_end, (2) new
-- plan starting at period_end. Until phase 2 activates, we need to
-- display "Downgrades to Starter on <date>" on the billing page — that
-- requires knowing the target plan without re-querying Stripe.
--
-- This is also what powers the "Undo downgrade" button on the billing
-- page: clear the schedule via Stripe, clear these columns via webhook.
--
-- Cleared by the customer.subscription.updated webhook when the
-- transition actually fires (the new price replaces the old one in
-- subscription.items[0]).
--
-- Idempotent.

ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS pending_flipdesk_plan public.flipdesk_plan,
  ADD COLUMN IF NOT EXISTS pending_flipdesk_interval text
    CHECK (pending_flipdesk_interval IS NULL OR pending_flipdesk_interval IN ('monthly', 'yearly')),
  ADD COLUMN IF NOT EXISTS pending_schedule_id text,
  ADD COLUMN IF NOT EXISTS pending_effective_at timestamptz;

COMMENT ON COLUMN public.users.pending_flipdesk_plan IS
  'Target plan for a scheduled downgrade (US-217). Takes effect at '
  'pending_effective_at; cleared by webhook when the transition fires.';

COMMENT ON COLUMN public.users.pending_schedule_id IS
  'Stripe Subscription Schedule ID — used to undo the downgrade by '
  'releasing the schedule.';
