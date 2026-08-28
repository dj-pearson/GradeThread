-- US-2969: pipeline reward events.
--
-- The XP catalog had no entry for any FlipDesk pipeline stage, so a seller who
-- listed items for months stayed at level 0. This adds the seven stage events
-- the reward engine scores, plus the two columns the sweep needs.
--
-- Design: docs/superpowers/specs/2026-08-28-pipeline-xp-rewards-design.md

-- ── reputation_events: widen the event-type CHECK ───────────────────────────
-- Postgres names this constraint reputation_events_event_type_check by default;
-- drop + re-add so the newest migration is authoritative and re-runnable. Every
-- value present as of 00555 is preserved.
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
    'integrity_tier_up',
    -- US-2969 pipeline stage types. Fixed XP from the catalog, deduped on
    -- "<item id>:<stage>" so a stage can only ever pay once per item however
    -- many times the sweep runs or the item moves backward and forward.
    'item_cataloged', 'item_measured', 'item_photographed', 'item_comped',
    'item_drafted', 'item_listed', 'item_sold'
  ));

-- ── inventory_items.comped_at ───────────────────────────────────────────────
-- The comp stage leaves no reliable durable mark: repricing_suggestions.listing_id
-- is NOT NULL, so a comp run before the item had a listing wrote no row at all.
-- This column records the FIRST comp run per item so item_comped accrues from
-- here forward. Comps that predate this migration cannot be recovered.
ALTER TABLE public.inventory_items
  ADD COLUMN IF NOT EXISTS comped_at timestamptz;

COMMENT ON COLUMN public.inventory_items.comped_at IS
  'US-2969: when comps were FIRST run for this item. Set-once (never overwritten '
  'by a later comp run) so the earliest comp is the one item_comped scores.';

-- ── user_reward_state.last_pipeline_sweep_at ────────────────────────────────
-- Throttle marker for the on-demand pipeline sweep (US-2972). Written on every
-- sweep ATTEMPT, including one that grants nothing, so a user with no new marks
-- cannot re-sweep on every page load.
ALTER TABLE public.user_reward_state
  ADD COLUMN IF NOT EXISTS last_pipeline_sweep_at timestamptz;

-- ── arrival celebration seen-state (US-2973) ────────────────────────────────
-- Server-side rather than localStorage so a backfill's one arrival moment does
-- not re-fire on the seller's next device.
ALTER TABLE public.user_reward_state
  ADD COLUMN IF NOT EXISTS arrival_seen_level integer;

-- No dedupe index is added here: 00417 already created uq_reputation_event_ref,
-- a UNIQUE index on (user_id, event_type, reference_id). That serves the
-- per-mark dedupe read in grantReward AND makes the sweep's idempotency
-- structural rather than merely careful.

-- US-1108: self-record so the edge schema-version boot guard (US-778) stays
-- truthful regardless of how the SQL was applied.
INSERT INTO public.applied_migrations (version) VALUES ('00679') ON CONFLICT DO NOTHING;
