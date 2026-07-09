-- US-1816: buyer Trust Score — event-sourced reputation model + derived score.
--
-- The foundation of the Trust Score epic (US-1815). Two tables:
--
--   • reputation_events — the append-only EVENT LOG. This is the authority; the
--     score is always reconstructable from it (US-1816 AC3). Producers are the
--     rewards/dispute/billing flows (US-1810+): a verified purchase, a confirmed
--     arrival grade, an upheld/overturned dispute, a chargeback, a tenure
--     milestone. Anti-gaming (US-1816 notes): ONLY `verified = true` events
--     score — an unverified event is recorded for audit but contributes 0.
--   • buyer_trust_scores — a DERIVED CACHE (one row per buyer) recomputed from
--     the log by lib/buyer-trust-score.ts. Never the source of truth; safe to
--     drop and rebuild. Recompute is idempotent (upsert on user_id).
--
-- SECURITY: both are OWNER-READ, SERVICE-WRITE (like buyer_notification_log,
-- 00412). A buyer can SEE their own reputation (the score must be explainable,
-- US-1816 AC) but can NEVER fabricate events or set their own score — there is
-- no client write policy, so RLS denies all client writes; only the service-role
-- client (which bypasses RLS and MUST scope by user_id, US-268) writes them.

-- ─── reputation_events (append-only log) ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.reputation_events (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  -- CHECKed text (not an enum) so a future event type needs no enum migration.
  -- Kept in lockstep with ReputationEventType in lib/buyer-trust-score.ts.
  event_type    text NOT NULL CHECK (event_type IN (
    'verified_purchase', 'grade_confirmed', 'dispute_upheld',
    'dispute_overturned', 'chargeback_penalty', 'tenure'
  )),
  -- Anti-gaming: only verified events score (unverified = audit-only, 0 points).
  verified      boolean NOT NULL DEFAULT true,
  -- Optional numeric context (e.g. tenure = months elapsed). The scoring engine
  -- decides how/whether to use it per event type — never trusted as raw points.
  magnitude     numeric,
  -- What produced the event (e.g. 'rewards', 'stripe', 'disputes', 'tenure-cron').
  source        text NOT NULL DEFAULT 'system',
  -- Idempotency handle from the producing domain (a sale id, dispute id, month
  -- key, …). One event per (user, type, reference) — a retried producer is a
  -- no-op, not a double-count. Empty string when a producer has no natural id.
  reference_id  text NOT NULL DEFAULT '',
  metadata      jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at   timestamptz NOT NULL DEFAULT now(),
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- Idempotent emission: the same real-world event maps to one row.
CREATE UNIQUE INDEX IF NOT EXISTS uq_reputation_event_ref
  ON public.reputation_events (user_id, event_type, reference_id);
-- The scorer sweeps a buyer's full log oldest-first.
CREATE INDEX IF NOT EXISTS idx_reputation_events_user
  ON public.reputation_events (user_id, occurred_at);

ALTER TABLE public.reputation_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Users read own reputation events" ON public.reputation_events;
CREATE POLICY "Users read own reputation events"
  ON public.reputation_events FOR SELECT USING (auth.uid() = user_id);

-- ─── buyer_trust_scores (derived cache) ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.buyer_trust_scores (
  user_id       uuid PRIMARY KEY REFERENCES public.users(id) ON DELETE CASCADE,
  -- Non-negative integer score (penalties suppress but never push below 0).
  score         integer NOT NULL DEFAULT 0 CHECK (score >= 0),
  -- Coarse level 0..3 + a stable slug label. Perks/badges are US-1817.
  level         smallint NOT NULL DEFAULT 0 CHECK (level >= 0),
  level_label   text NOT NULL DEFAULT 'new',
  -- How many events the cache was computed from (staleness / debug aid).
  event_count   integer NOT NULL DEFAULT 0 CHECK (event_count >= 0),
  computed_at   timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

DROP TRIGGER IF EXISTS set_buyer_trust_scores_updated_at ON public.buyer_trust_scores;
CREATE TRIGGER set_buyer_trust_scores_updated_at
  BEFORE UPDATE ON public.buyer_trust_scores
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.buyer_trust_scores ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Users read own trust score" ON public.buyer_trust_scores;
CREATE POLICY "Users read own trust score"
  ON public.buyer_trust_scores FOR SELECT USING (auth.uid() = user_id);

-- US-1108: self-record so the edge schema-version guard stays truthful.
INSERT INTO public.applied_migrations (version) VALUES ('00417')
ON CONFLICT (version) DO NOTHING;
