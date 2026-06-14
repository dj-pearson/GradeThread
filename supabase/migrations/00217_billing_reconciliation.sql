-- US-893: Stripe reconciliation & dunning console.
--
-- Gives operators a durable surface for revenue leaks: past-due/paused accounts,
-- recent failed invoices, and rows where our cached subscription_status diverges
-- from the latest recorded Stripe event (a sign a webhook was missed or its DB
-- write lost a race). Two pieces:
--
--   1. billing_reconciliation_flags — a precomputed list of divergences written
--      by a SCHEDULED job (not recomputed on every page load). Operator-only
--      data: RLS-enabled with NO policy (deny-all; service-role writes only).
--      Keyed by subject_user_id (NOT a literal user_id column) so the rls-guard
--      treats it as operator data — it is classified in SERVICE_ROLE_ONLY.
--   2. reconciliation_candidates() — one SECURITY DEFINER read that returns the
--      latest subscription event per user joined to the user's current cached
--      state, so the job can detect divergences in TS (single source of truth in
--      lib/billing-reconciliation.ts) without an N+1 scan.
--
-- The "re-sync from Stripe" and "mark resolved" write paths live in the edge
-- service (admin-billing.ts); re-sync pulls live Stripe state and applies it
-- idempotently WITHOUT touching processed_webhook_events, so a real future
-- webhook (a new event.id) is never blocked.

-- ── (1) billing_reconciliation_flags ─────────────────────────────
CREATE TABLE IF NOT EXISTS public.billing_reconciliation_flags (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- The account the divergence concerns. Deliberately NOT named user_id so the
  -- rls-guard discovery does not require a tenant policy — this is operator data.
  subject_user_id    uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  kind               text NOT NULL,                 -- status_divergence | plan_divergence
  db_status          text,                          -- cached subscription_status at detection
  expected_status    text,                          -- status implied by the latest event
  db_plan            text,                          -- cached flipdesk_plan at detection
  expected_plan      text,                          -- plan implied by the latest event
  latest_event_id    uuid,                          -- flipdesk_subscription_events.id
  latest_event_type  text,
  detail             jsonb NOT NULL DEFAULT '{}'::jsonb,
  status             text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
  resolution         text,                          -- resynced | manual | auto
  detected_at        timestamptz NOT NULL DEFAULT now(),
  last_seen_at       timestamptz NOT NULL DEFAULT now(),
  resolved_at        timestamptz,
  resolved_by        uuid REFERENCES public.users(id) ON DELETE SET NULL
);

-- At most one OPEN flag per account: the job upserts (ON CONFLICT) on re-detect
-- instead of piling up duplicates. Resolved rows are kept as history.
CREATE UNIQUE INDEX IF NOT EXISTS billing_reconciliation_flags_open_subject_key
  ON public.billing_reconciliation_flags (subject_user_id)
  WHERE status = 'open';

CREATE INDEX IF NOT EXISTS idx_billing_reconciliation_flags_status_detected
  ON public.billing_reconciliation_flags (status, detected_at DESC);

ALTER TABLE public.billing_reconciliation_flags ENABLE ROW LEVEL SECURITY;
-- No policy: deny-all for anon/authenticated. Operators read/write via the
-- service-role edge only (admin JWT + AAL2 enforced in the edge middleware).

COMMENT ON TABLE public.billing_reconciliation_flags IS
  'US-893: precomputed Stripe-vs-DB subscription divergences for the admin '
  'reconciliation console. Written by the scheduled billing-reconciliation job; '
  'operator-only (deny-all RLS, service-role writes). subject_user_id is the '
  'affected account.';

-- ── (2) reconciliation_candidates: latest event per user + cached state ─
--
-- DISTINCT ON collapses to the newest event per user; joined to users so the job
-- can compare the cached subscription_status / flipdesk_plan against what the
-- latest event implies. SECURITY DEFINER (cross-tenant); admin or service-role
-- only. p_limit bounds the scan.
CREATE OR REPLACE FUNCTION public.reconciliation_candidates(
  p_limit integer DEFAULT 2000
)
RETURNS TABLE (
  subject_user_id   uuid,
  email             text,
  db_status         text,
  db_plan           text,
  past_due_since    timestamptz,
  stripe_customer_id text,
  subscription_id   text,
  latest_event_id   uuid,
  latest_event_type text,
  event_to_plan     text,
  event_raw_status  text,
  event_at          timestamptz
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
begin
  -- Authenticated end-users must be admins; the service-role job (auth.uid()
  -- null) passes. anon can't reach this — execute is not granted to it.
  if auth.uid() is not null and not public.is_admin() then
    raise exception 'reconciliation_candidates: admin role required'
      using errcode = '42501';
  end if;

  return query
  select
    latest.user_id,
    u.email,
    u.subscription_status::text,
    u.flipdesk_plan::text,
    u.past_due_since,
    u.stripe_customer_id,
    u.flipdesk_subscription_id,
    latest.id,
    latest.event_type,
    latest.to_plan::text,
    latest.raw_payload->>'status',
    latest.created_at
  from (
    select distinct on (e.user_id)
      e.user_id, e.id, e.event_type, e.to_plan, e.raw_payload, e.created_at
    from public.flipdesk_subscription_events e
    order by e.user_id, e.created_at desc
  ) latest
  join public.users u on u.id = latest.user_id
  order by latest.created_at desc
  limit greatest(1, least(coalesce(p_limit, 2000), 10000));
end;
$$;

COMMENT ON FUNCTION public.reconciliation_candidates(integer) IS
  'US-893: latest subscription event per user joined to the cached '
  'subscription_status/flipdesk_plan, for the scheduled reconciliation job to '
  'detect divergences. SECURITY DEFINER (cross-tenant); admin or service-role only.';

-- Execute: authenticated (in-function is_admin guard) + service_role (the job).
-- Deliberately NOT granted to anon.
GRANT EXECUTE ON FUNCTION public.reconciliation_candidates(integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.reconciliation_candidates(integer) TO service_role;
