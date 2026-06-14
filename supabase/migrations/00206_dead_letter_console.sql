-- US-882: unified dead-letter console (cross-provider DLQ).
--
-- Surfaces failed webhook deliveries (webhook_dead_letters) and dead-lettered
-- transactional email (email_deliveries) in one operator console with retry +
-- discard. Three small extensions to the existing stores so the console doesn't
-- need a redundant table:
--
--   1. webhook_dead_letters: allow a 'content' provider so terminal content
--      webhook failures (US-487) land in the SAME queue instead of a separate
--      surface (AC#6); allow a 'discarded' status; track manual replays.
--   2. email_deliveries: allow a 'discarded' status + capture who/why/when so a
--      dead-lettered email can be permanently abandoned with an audited reason.
--
-- Idempotent (IF EXISTS / IF NOT EXISTS) so re-applying on a fresh schema is a
-- no-op the second time.

-- ── webhook_dead_letters ─────────────────────────────────────────
-- Add 'content' to the provider allow-list (US-487 content webhooks now
-- dead-letter here). The inline column CHECK was auto-named
-- webhook_dead_letters_provider_check.
ALTER TABLE public.webhook_dead_letters
  DROP CONSTRAINT IF EXISTS webhook_dead_letters_provider_check;
ALTER TABLE public.webhook_dead_letters
  ADD CONSTRAINT webhook_dead_letters_provider_check
  CHECK (provider IN ('stripe', 'ebay', 'appstore', 'content'));

-- Add 'discarded' as a terminal status (permanently abandoned by an operator,
-- distinct from 'resolved' which means successfully replayed).
ALTER TABLE public.webhook_dead_letters
  DROP CONSTRAINT IF EXISTS webhook_dead_letters_status_check;
ALTER TABLE public.webhook_dead_letters
  ADD CONSTRAINT webhook_dead_letters_status_check
  CHECK (status IN ('unresolved', 'resolved', 'discarded'));

-- Manual-replay bookkeeping (the original drop is recorded once; this counts
-- operator-triggered retries and stamps the last one).
ALTER TABLE public.webhook_dead_letters
  ADD COLUMN IF NOT EXISTS replay_attempts int NOT NULL DEFAULT 0;
ALTER TABLE public.webhook_dead_letters
  ADD COLUMN IF NOT EXISTS last_replay_at timestamptz;

-- ── email_deliveries ─────────────────────────────────────────────
-- Allow a 'discarded' status so a dead-lettered email can be permanently
-- abandoned (vs. re-queued to 'pending') from the console.
ALTER TABLE public.email_deliveries
  DROP CONSTRAINT IF EXISTS email_deliveries_status_check;
ALTER TABLE public.email_deliveries
  ADD CONSTRAINT email_deliveries_status_check
  CHECK (status IN ('pending', 'sent', 'dead_letter', 'discarded'));

-- Audited-discard provenance (reason is required at the API layer; super_admin
-- + step-up gated there).
ALTER TABLE public.email_deliveries
  ADD COLUMN IF NOT EXISTS discard_reason text;
ALTER TABLE public.email_deliveries
  ADD COLUMN IF NOT EXISTS discarded_at timestamptz;
ALTER TABLE public.email_deliveries
  ADD COLUMN IF NOT EXISTS discarded_by uuid REFERENCES public.users(id);

-- The console lists email by (status, created_at) — the existing
-- email_deliveries_status_idx covers it. webhook_dead_letters lists by
-- (status, created_at DESC) — covered by idx_webhook_dead_letters_status.
-- Both tables stay service-role-only (RLS already enabled with no client
-- policies); the admin endpoints are role-gated.
