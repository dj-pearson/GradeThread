-- US-1854: the share-to-earn loop. A shared find that a real person follows back
-- pays the seller, and the payout escalates with verified reach.
--
-- Three pieces:
--   1. `share_events` — the TRACKED SHARE (someone pressed a share button). It
--      pays nothing on its own; it is the record the click ledger is measured
--      against, and it carries the sharer's salted network fingerprint so that a
--      later click carrying the SAME fingerprint is recognisable as a self-click.
--   2. `badge_click_events.visitor_hash` / `.self_click` — the click side of the
--      same fingerprint. This is what makes "unique verified click" countable
--      without ever storing an IP address or any other buyer PII.
--   3. the `share_milestone` reward event type — the escalating award.
--
-- The reward sits on the CLICK, never on the press. Rationale, the ladder, and
-- the anti-farming contract: vault/20-domain/reward-ledger.md.

-- ── The share_milestone event type ──────────────────────────────────────────
-- Re-stated in full (the 00443 / 00543 precedent) so the allow-list is
-- authoritative and the statement re-runnable.
ALTER TABLE public.reputation_events
  DROP CONSTRAINT IF EXISTS reputation_events_event_type_check;
ALTER TABLE public.reputation_events
  ADD CONSTRAINT reputation_events_event_type_check CHECK (event_type IN (
    -- US-1816 buyer Trust Score types:
    'verified_purchase', 'grade_confirmed', 'dispute_upheld',
    'dispute_overturned', 'chargeback_penalty', 'tenure',
    -- US-1849 reward-only types:
    'coverage_completed', 'badge_embedded', 'aspects_filled',
    'marketplace_connected', 'verified_share',
    -- US-1852: quest completion. VARIABLE XP (metadata.quest_xp).
    'quest_completed',
    -- US-1854: a shared find crossed a verified-reach milestone. VARIABLE XP
    -- (metadata.award_xp), clamped by the edge to the same ceiling as a quest.
    'share_milestone'
  ));

-- ── 1. Tracked shares ───────────────────────────────────────────────────────
-- Operator table: deny-all RLS, service-role only. The sharer is resolved from
-- their JWT and their ownership of the certificate is verified server-side
-- before a row is written, so a row can never claim someone else's find.
CREATE TABLE IF NOT EXISTS public.share_events (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- The seller who pressed share (operator-table naming convention).
  owner_user_id  uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  -- What was shared: 'cert' today (a certificate).
  target_type    text NOT NULL,
  -- The certificate_id the share pointed at.
  target_id      text NOT NULL,
  -- Which share sheet / network the press came from ('native', 'x', 'email'…).
  channel        text NOT NULL,
  -- Salted, truncated hash of the sharer's network fingerprint at share time.
  -- NOT an IP and not reversible to one: it exists ONLY so that a click
  -- carrying the same hash can be discarded as the sharer clicking their own
  -- link. Nullable — a share we cannot fingerprint is still a tracked share.
  sharer_hash    text,
  created_at     timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.share_events
  DROP CONSTRAINT IF EXISTS share_events_target_type_check;
ALTER TABLE public.share_events
  ADD CONSTRAINT share_events_target_type_check
  CHECK (target_type IN ('cert'));

-- Deny-all: RLS on, ZERO policies. Same posture as badge_click_events — the
-- service-role edge writes and reads it; the SPA never queries it directly.
ALTER TABLE public.share_events ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.share_events FROM anon, authenticated;

CREATE INDEX IF NOT EXISTS idx_share_events_owner
  ON public.share_events (owner_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_share_events_target
  ON public.share_events (owner_user_id, target_type, target_id);

COMMENT ON TABLE public.share_events IS
  'US-1854: tracked shares of a graded find (deny-all, service-role only). No buyer PII; sharer_hash is a salted fingerprint used only for self-click detection.';

-- ── 2. The click side of the fingerprint ────────────────────────────────────
-- badge_click_events (00404) already records "someone followed a badge back to
-- this seller". Counting UNIQUE clicks, and refusing to pay for the seller's
-- own, needs a per-visitor handle that is not an identity — hence a salted
-- hash, and a boolean the funnel can exclude on.
ALTER TABLE public.badge_click_events
  ADD COLUMN IF NOT EXISTS visitor_hash text;
ALTER TABLE public.badge_click_events
  ADD COLUMN IF NOT EXISTS self_click boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.badge_click_events.visitor_hash IS
  'US-1854: salted, truncated fingerprint hash. Distinct-count key for verified clicks; never an IP and not reversible to one.';
COMMENT ON COLUMN public.badge_click_events.self_click IS
  'US-1854: true when the click fingerprint matched the sharer''s own at share time. Recorded for the funnel, never rewarded.';

-- The milestone evaluator counts DISTINCT visitor_hash per shared target.
CREATE INDEX IF NOT EXISTS idx_badge_click_events_target_visitor
  ON public.badge_click_events (owner_user_id, target_type, target_id, visitor_hash);

-- US-1108: self-record this migration's version so the edge schema-version
-- guard (US-778) stays in sync regardless of apply method.
INSERT INTO public.applied_migrations (version) VALUES ('00545')
ON CONFLICT (version) DO NOTHING;
