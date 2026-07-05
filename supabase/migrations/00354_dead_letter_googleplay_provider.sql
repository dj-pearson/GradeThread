-- US-1650 / C6: Google Play RTDN webhook dead-letters.
--
-- The Google Play Real-time Developer Notifications webhook (routes/
-- google-play-rtdn.ts) mirrors the Stripe + App Store dispatcher: a
-- non-transient (code-bug) failure durably dead-letters the event so it can be
-- replayed from the admin queue instead of vanishing. webhook_dead_letters.
-- provider has a CHECK allow-list (00124 → 'stripe','ebay','appstore'; 00206
-- added 'content'); extend it with 'googleplay' so those drops can be recorded.
--
-- processed_webhook_events.provider has NO CHECK (free text), so the idempotency
-- claim needs no migration — only this dead-letter allow-list does.
--
-- Idempotent: DROP CONSTRAINT IF EXISTS then re-ADD the full allow-list (safe to
-- re-run; mirrors 00206). No data change.

ALTER TABLE public.webhook_dead_letters
  DROP CONSTRAINT IF EXISTS webhook_dead_letters_provider_check;
ALTER TABLE public.webhook_dead_letters
  ADD CONSTRAINT webhook_dead_letters_provider_check
  CHECK (provider IN ('stripe', 'ebay', 'appstore', 'content', 'googleplay'));

-- US-1108: self-record this migration's version so the edge schema-version guard
-- (US-778) stays in sync regardless of apply method.
INSERT INTO public.applied_migrations (version) VALUES ('00354') ON CONFLICT DO NOTHING;
