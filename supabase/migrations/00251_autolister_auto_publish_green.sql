-- US-955: optional auto-publish of green drafts on batch completion.
--
-- A high-volume reseller can flag an AutoLister generation batch to auto-publish
-- ONLY its high-confidence (green), pre-flight-clean drafts when generation
-- finishes — a true fire-and-forget path (generate overnight, listings go live).
-- amber/red/blocked/scheduled drafts are never auto-published.
--
-- The generation batch carries the opt-in flag + a once-only claim stamp so the
-- auto-publish trigger fires exactly once even across the durable worker's
-- repeated finalize calls and the reclaim sweeper. The auto-publish reuses the
-- existing durable publish worker (US-559); the resulting publish batch is tagged
-- so its completion sends ONE notification reporting published vs skipped counts
-- (the generation-time skips are stored on the batch).

-- ── Generation batch: opt-in + once-only auto-publish claim ──
ALTER TABLE public.listing_generation_batches
  -- Opt-in: auto-publish the green, clean drafts when this batch completes.
  ADD COLUMN IF NOT EXISTS auto_publish_green boolean NOT NULL DEFAULT false,
  -- Set the moment the auto-publish trigger is claimed; a NOT-NULL value means
  -- it has already fired, so a repeated finalize / reclaim never double-publishes.
  ADD COLUMN IF NOT EXISTS auto_published_at  timestamptz;

-- ── Publish batch: link + breakdown so completion notifies once ──
ALTER TABLE public.listing_publish_batches
  -- Marks a publish batch created by the auto-publish trigger (vs a manual bulk
  -- publish), so its terminalization emits the auto-publish completion notice.
  ADD COLUMN IF NOT EXISTS auto_published      boolean NOT NULL DEFAULT false,
  -- The generation batch that spawned this auto-publish run (audit/back-link).
  ADD COLUMN IF NOT EXISTS generation_batch_id uuid
    REFERENCES public.listing_generation_batches(id) ON DELETE SET NULL,
  -- Generation-time skip breakdown ({ needs_review, blocked, scheduled,
  -- plan_limit }) folded into the completion notification alongside the live
  -- published/failed counts.
  ADD COLUMN IF NOT EXISTS auto_skipped        jsonb,
  -- Once-only guard for the auto-publish completion notification.
  ADD COLUMN IF NOT EXISTS auto_notified_at    timestamptz;
