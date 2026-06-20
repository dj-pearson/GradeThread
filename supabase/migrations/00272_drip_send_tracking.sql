-- US-938: Durable per-step drip send — idempotency key + skip ledger.
--
-- The trial-conversion drip engine (routes/drip.ts) now routes every step send
-- through the durable email_deliveries outbox (US-498/US-925) with the open/click
-- tracking rewriter (US-913) and a pre-send QA gate (US-924), and gates each send
-- on consent (US-911), suppression (US-914) and a frequency cap before dispatch.
-- This migration adds the two columns/constraints that make that durable +
-- measurable without a second table:
--
--   • a UNIQUE (enrollment_id, step) index so the engine UPSERTS exactly ONE row
--     per (enrollment, step) — a re-tick / catch-up batch can never double-send
--     or double-record a step (AC4 idempotency).
--   • `skip_reason` — why a send did NOT go out (opted_out, suppressed,
--     frequency_capped, qa_failed). NULL on an actually-sent row, so the funnel
--     separates "skipped with reason" from "delivered" off the existing grain.
--
-- drip_sends stays service-role only (written by the edge engine). The open/click
-- tracking endpoints (routes/drip-tracking.ts) stamp opened_at/clicked_at on a row
-- identified by its unguessable id (the send token) — no client-facing access.

BEGIN;

-- Idempotency grain: one row per (enrollment, step).
create unique index if not exists drip_sends_enrollment_step_uniq
  on public.drip_sends (enrollment_id, step);

-- Why a step was skipped instead of sent (NULL on a delivered row).
alter table public.drip_sends
  add column if not exists skip_reason text;

create index if not exists drip_sends_skip_reason_idx
  on public.drip_sends (campaign, skip_reason)
  where skip_reason is not null;

comment on column public.drip_sends.skip_reason is
  'US-938: why this (enrollment, step) was skipped (opted_out/suppressed/frequency_capped/qa_failed); NULL when delivered.';

COMMIT;

-- self-record (US-1108): keeps the edge schema-version guard (US-778) in sync
-- regardless of how this migration is applied.
INSERT INTO public.applied_migrations (version) VALUES ('00272')
ON CONFLICT (version) DO NOTHING;
