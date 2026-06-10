-- US-772: dead-letter store for permanently-dropped webhook events.
--
-- webhooks.ts distinguishes a TRANSIENT handler failure (release the idempotency
-- claim, 500, Stripe retries) from a NON-TRANSIENT code bug (keep the claim, log,
-- return 200 — a retry can't fix a bug). The 200 path previously left only a
-- console line + a PostHog event as evidence: a paid checkout whose handler threw
-- a code bug could vanish with no durable record and nothing for an operator to
-- act on. This table captures every such drop so it can be surfaced, alerted, and
-- manually replayed.

CREATE TABLE IF NOT EXISTS public.webhook_dead_letters (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Which provider's webhook dispatcher dropped the event.
  provider      text NOT NULL CHECK (provider IN ('stripe', 'ebay', 'appstore')),
  -- The provider's event id (Stripe evt_…, etc.) so an operator can find + replay it.
  event_id      text NOT NULL,
  event_type    text,
  -- The event payload, PII/secret-redacted at capture time (lib/log-redact.ts).
  -- Enough context to understand + manually reprocess without re-pulling from Stripe.
  payload       jsonb,
  -- The non-transient handler error that caused the drop.
  error_message text,
  status        text NOT NULL DEFAULT 'unresolved'
                  CHECK (status IN ('unresolved', 'resolved')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  resolved_at   timestamptz,
  resolved_by   uuid REFERENCES public.users(id),
  resolution_note text
);

-- One row per dropped (provider, event_id). The authoritative idempotency claim
-- (processed_webhook_events) already dedupes deliveries before the handler runs,
-- so a given event reaches the drop path at most once; this guard is belt-and-
-- suspenders so a re-drop updates nothing rather than piling up duplicates.
CREATE UNIQUE INDEX IF NOT EXISTS idx_webhook_dead_letters_event
  ON public.webhook_dead_letters(provider, event_id);
CREATE INDEX IF NOT EXISTS idx_webhook_dead_letters_status
  ON public.webhook_dead_letters(status, created_at DESC);

-- Admin-only resource. RLS on with NO client policies → deny-all for
-- anon/authenticated; the edge service writes via the service-role key (bypasses
-- RLS) and the admin endpoints that read it are themselves role-gated.
ALTER TABLE public.webhook_dead_letters ENABLE ROW LEVEL SECURITY;
