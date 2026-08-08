-- 00555_seller_integrity_tier.sql
--
-- US-1912: persist the seller Grade Integrity TIER and the inputs that produced
-- it. The score (00421) was already cached; the tier was computed on the fly and
-- thrown away, so nothing could tell a tier CHANGE from a recompute — which is
-- what AC4 (reward event on tier-up, private notice on tier-down) needs.
--
-- Rules for the ladder, the anti-gaming floor and the never-announce-a-demotion
-- policy live in vault/20-domain/reward-ledger.md, not in this header.

-- ── seller_grade_integrity: tier + its inputs ───────────────────────────────
ALTER TABLE public.seller_grade_integrity
  -- The named tier from sellerIntegrityTier(). 'building' is the pre-floor
  -- state, and it is the DEFAULT so an existing row reads as "no tier yet"
  -- rather than inheriting a rank it never earned.
  ADD COLUMN IF NOT EXISTS tier             text    NOT NULL DEFAULT 'building',
  -- False below the confirmed-outcome floor. Stored rather than re-derived so a
  -- public read never has to know the floor to answer "may I show this".
  ADD COLUMN IF NOT EXISTS tier_displayable boolean NOT NULL DEFAULT false,
  -- The tier inputs, stored so the seller-facing explanation and the tier are
  -- always the same snapshot (recomputing the inputs for the explanation can
  -- disagree with the tier that was stored).
  ADD COLUMN IF NOT EXISTS avg_coverage_pct numeric,   -- NULL = unknown, never gated on
  ADD COLUMN IF NOT EXISTS graded_volume    integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS tenure_days      integer,   -- NULL = unknown, never gated on
  -- Transition bookkeeping. previous_tier + tier_changed_at are what make the
  -- recompute able to fire a one-time side effect idempotently: a recompute that
  -- lands on the same tier changes neither, so nothing re-fires.
  ADD COLUMN IF NOT EXISTS previous_tier    text,
  ADD COLUMN IF NOT EXISTS tier_changed_at  timestamptz;

ALTER TABLE public.seller_grade_integrity
  DROP CONSTRAINT IF EXISTS seller_grade_integrity_tier_check;
ALTER TABLE public.seller_grade_integrity
  ADD CONSTRAINT seller_grade_integrity_tier_check
  CHECK (tier IN ('building', 'verified', 'reliable', 'trusted', 'elite'));

ALTER TABLE public.seller_grade_integrity
  DROP CONSTRAINT IF EXISTS seller_grade_integrity_previous_tier_check;
ALTER TABLE public.seller_grade_integrity
  ADD CONSTRAINT seller_grade_integrity_previous_tier_check
  CHECK (previous_tier IS NULL
         OR previous_tier IN ('building', 'verified', 'reliable', 'trusted', 'elite'));

-- A coverage percentage outside 0–100 means the recompute read something it did
-- not understand; refuse it here rather than letting it decide a public tier.
ALTER TABLE public.seller_grade_integrity
  DROP CONSTRAINT IF EXISTS seller_grade_integrity_coverage_range_check;
ALTER TABLE public.seller_grade_integrity
  ADD CONSTRAINT seller_grade_integrity_coverage_range_check
  CHECK (avg_coverage_pct IS NULL OR (avg_coverage_pct >= 0 AND avg_coverage_pct <= 100));

-- The public cert / verified-profile reads resolve a seller's tier by id, and
-- only a DISPLAYABLE one is ever shown, so index the displayable rows.
CREATE INDEX IF NOT EXISTS idx_seller_grade_integrity_displayable
  ON public.seller_grade_integrity (seller_user_id)
  WHERE tier_displayable;

COMMENT ON COLUMN public.seller_grade_integrity.tier IS
  'US-1912 named Grade Integrity tier. building = below the confirmed-outcome '
  'floor (never displayed publicly, and never rendered as a bad score).';

-- ── reputation_events: the tier-up event type ───────────────────────────────
-- A tier-UP is rewardable and public. A tier-DOWN deliberately has NO event
-- type: the ledger is read by public surfaces, so a demotion event would be a
-- public announcement of a demotion. The seller is told privately instead
-- (notification_type 'integrity_tier_change' below).
--
-- Re-stated in full (the 00443 / 00543 / 00545 precedent) so the allow-list is
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
    'share_milestone',
    -- US-1912: the seller's Grade Integrity tier went UP. Fixed XP from the
    -- catalog; deduped on the tier reached, so re-reaching a tier after a
    -- demotion never pays twice.
    'integrity_tier_up'
  ));

-- ── notification_type: the private tier-change notice ───────────────────────
-- ALTER TYPE ... ADD VALUE is transactional in PG 12+ (see 00548/00549). The new
-- value cannot be USED in the same transaction, which is fine — only the edge
-- writes it, and the boot guard keeps the edge behind this migration.
ALTER TYPE public.notification_type ADD VALUE IF NOT EXISTS 'integrity_tier_change';

-- US-1108: self-record so the edge schema-version guard stays truthful.
INSERT INTO public.applied_migrations (version) VALUES ('00555')
ON CONFLICT (version) DO NOTHING;
