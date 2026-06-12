-- Parking lot for verified eBay webhook events that could not yet be linked to a
-- GradeThread account because the connection's account_handle / external_account_id
-- had not hydrated (US-472).
--
-- Identity lookup on connect is best-effort (commerce/identity can 4xx or be
-- briefly unavailable), so a freshly-connected seller's account_handle and
-- external_account_id can both be NULL for a short window. eBay payout/order/return
-- notifications that arrive in that window previously matched nothing and were
-- silently dropped — losing the payout/sale signal with no record.
--
-- Instead we store the verified payload here and re-attempt linkage on a schedule
-- (`/api/jobs/ebay-pending-webhooks`). Once the connection's handle/id hydrates
-- (via the token-refresh backfill or a later identity lookup), the drain resolves
-- the parked event to a user and replays it (payout → dedup ingest, order/return →
-- targeted incremental sync). After max attempts the row is dead-lettered so the
-- table stays bounded and the operator can fall back to a CSV payout import.

CREATE TABLE IF NOT EXISTS public.ebay_pending_webhook_events (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Which dispatch path the event belongs to: 'payout' | 'order' | 'return'.
  bucket          text NOT NULL,
  topic           text NOT NULL,
  -- eBay's notificationId when present — dedupes re-parked re-deliveries.
  notification_id text,
  -- Linkage candidates extracted from the verified payload.
  ebay_username   text,
  ebay_user_id    text,
  -- The verified notification.data payload, replayed when linkage succeeds.
  payload         jsonb NOT NULL,
  attempts        integer NOT NULL DEFAULT 0,
  last_attempt_at timestamptz,
  last_error      text,
  -- Set when the event is finally linked + dispatched OR dead-lettered. A
  -- non-null value removes the row from the drain's work set.
  processed_at    timestamptz,
  -- 'linked' once dispatched, 'dead_letter' once retries are exhausted.
  outcome         text,
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- Dedupe re-deliveries of the same unmatched notification. NULLs stay distinct in
-- a unique index, so id-less events still park (one row each).
CREATE UNIQUE INDEX IF NOT EXISTS idx_ebay_pending_webhook_notif
  ON public.ebay_pending_webhook_events (notification_id)
  WHERE notification_id IS NOT NULL;

-- The drain scans only unprocessed rows; linkage matches on either candidate.
CREATE INDEX IF NOT EXISTS idx_ebay_pending_webhook_unprocessed
  ON public.ebay_pending_webhook_events (created_at)
  WHERE processed_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_ebay_pending_webhook_user_id
  ON public.ebay_pending_webhook_events (ebay_user_id)
  WHERE processed_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_ebay_pending_webhook_username
  ON public.ebay_pending_webhook_events (ebay_username)
  WHERE processed_at IS NULL;

ALTER TABLE public.ebay_pending_webhook_events ENABLE ROW LEVEL SECURITY;
-- No policies: read/written only via the service-role edge client, with linkage
-- resolved against marketplace_connections ownership in code (US-268).
