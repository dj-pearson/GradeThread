-- Webhook idempotency / replay protection (US-277).
--
-- One row per successfully-claimed inbound webhook event. The (provider,
-- event_id) primary key lets the edge handlers insert-on-conflict to dedupe:
-- a duplicate delivery (Stripe retry, eBay re-send, or a replayed capture)
-- hits the unique constraint and is skipped BEFORE any side effects run.

CREATE TABLE IF NOT EXISTS public.processed_webhook_events (
  provider      text NOT NULL,                 -- 'stripe' | 'ebay'
  event_id      text NOT NULL,                 -- Stripe event.id / eBay notificationId
  event_type    text,                          -- for debugging/auditing only
  processed_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (provider, event_id)
);

-- Supports a periodic cleanup job that prunes old rows.
CREATE INDEX IF NOT EXISTS idx_processed_webhook_events_processed_at
  ON public.processed_webhook_events(processed_at);

-- Service-role only — webhook handlers use the service-role client. No client
-- access, so RLS is enabled with no policies (deny-all for anon/auth roles).
ALTER TABLE public.processed_webhook_events ENABLE ROW LEVEL SECURITY;
