-- FlipDesk AutoLister (US-310): batch generation, draft fields, business policies.
--
-- AutoLister turns a folder of photos into complete eBay drafts in bulk:
--   group photos → generate (AI) → review/edit → publish. This migration adds
--   the persistence the pipeline needs and is the dependency root for
--   US-312/313 (generation + queue), US-319/320 (editors), US-321/322 (publish).
--
--   1. Batch + per-item job tracking so a run of ~100 generations has durable,
--      pollable state (queue page, retry of failed-only).
--   2. New listing columns: the eBay condition/specifics/policy/scheduling
--      fields a generated draft needs to become a publishable offer, plus
--      publish-failure bookkeeping.
--   3. business_policies cache so drafts default to valid fulfillment/payment/
--      return policies without re-fetching eBay on every publish (US-314).
--
-- All new multi-tenant tables get RLS (own-data, or via parent ownership).
-- The edge service uses the service-role client (bypasses RLS) — handlers MUST
-- still tenant-scope every query (CLAUDE.md US-268).

-- ══════════════════════════════════════════════════════════
-- NEW ENUMS
-- ══════════════════════════════════════════════════════════
-- Guarded so re-running the migration doesn't error (CREATE TYPE has no
-- IF NOT EXISTS on PG 15).

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'listing_generation_status') THEN
    CREATE TYPE public.listing_generation_status AS ENUM (
      'pending', 'running', 'completed', 'failed', 'partial'
    );
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'listing_generation_job_status') THEN
    CREATE TYPE public.listing_generation_job_status AS ENUM (
      'pending', 'running', 'success', 'failed'
    );
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'listing_generation_source') THEN
    CREATE TYPE public.listing_generation_source AS ENUM (
      'autolister', 'manual', 'api'
    );
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'business_policy_type') THEN
    CREATE TYPE public.business_policy_type AS ENUM (
      'fulfillment', 'payment', 'return'
    );
  END IF;
END $$;

-- ══════════════════════════════════════════════════════════
-- NEW TABLES
-- ══════════════════════════════════════════════════════════

-- A single bulk generation run. Rolls up per-job counts so the queue page can
-- show progress without scanning every job row.
CREATE TABLE IF NOT EXISTS public.listing_generation_batches (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  status          public.listing_generation_status NOT NULL DEFAULT 'pending',
  source          public.listing_generation_source NOT NULL DEFAULT 'autolister',
  item_count      integer NOT NULL DEFAULT 0,
  succeeded_count integer NOT NULL DEFAULT 0,
  failed_count    integer NOT NULL DEFAULT 0,
  error           text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_listing_generation_batches_user_id
  ON public.listing_generation_batches(user_id);
CREATE INDEX IF NOT EXISTS idx_listing_generation_batches_status
  ON public.listing_generation_batches(status);

DROP TRIGGER IF EXISTS set_listing_generation_batches_updated_at
  ON public.listing_generation_batches;
CREATE TRIGGER set_listing_generation_batches_updated_at
  BEFORE UPDATE ON public.listing_generation_batches
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- One row per item in a batch. status/attempts/error drive retry + progress.
-- listing_id is set once the item's draft is created (success).
CREATE TABLE IF NOT EXISTS public.listing_generation_jobs (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id          uuid NOT NULL REFERENCES public.listing_generation_batches(id) ON DELETE CASCADE,
  inventory_item_id uuid NOT NULL REFERENCES public.inventory_items(id) ON DELETE CASCADE,
  status            public.listing_generation_job_status NOT NULL DEFAULT 'pending',
  error             text,
  attempts          integer NOT NULL DEFAULT 0,
  listing_id        uuid REFERENCES public.listings(id) ON DELETE SET NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_listing_generation_jobs_batch_id
  ON public.listing_generation_jobs(batch_id);
CREATE INDEX IF NOT EXISTS idx_listing_generation_jobs_status
  ON public.listing_generation_jobs(status);
CREATE INDEX IF NOT EXISTS idx_listing_generation_jobs_inventory_item_id
  ON public.listing_generation_jobs(inventory_item_id);

DROP TRIGGER IF EXISTS set_listing_generation_jobs_updated_at
  ON public.listing_generation_jobs;
CREATE TRIGGER set_listing_generation_jobs_updated_at
  BEFORE UPDATE ON public.listing_generation_jobs
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- Cached eBay business policies per user per marketplace. Synced from eBay's
-- Account API; defaults applied to generated drafts so publish doesn't have to
-- resolve policies live every time (US-314). policy_data holds eBay's verbatim
-- policy object for display/debug.
CREATE TABLE IF NOT EXISTS public.business_policies (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  marketplace         public.listing_platform NOT NULL,
  policy_id           text NOT NULL,
  policy_type         public.business_policy_type NOT NULL,
  policy_name         text,
  policy_data         jsonb,
  is_default          boolean NOT NULL DEFAULT false,
  synced_from_ebay_at timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, marketplace, policy_id)
);

CREATE INDEX IF NOT EXISTS idx_business_policies_user_id
  ON public.business_policies(user_id);
-- Fast lookup of the user's default policy per (marketplace, type).
CREATE INDEX IF NOT EXISTS idx_business_policies_default
  ON public.business_policies(user_id, marketplace, policy_type)
  WHERE is_default = true;

DROP TRIGGER IF EXISTS set_business_policies_updated_at
  ON public.business_policies;
CREATE TRIGGER set_business_policies_updated_at
  BEFORE UPDATE ON public.business_policies
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ══════════════════════════════════════════════════════════
-- EXTEND EXISTING TABLES
-- ══════════════════════════════════════════════════════════

-- listings: AutoLister draft + publish fields.
ALTER TABLE public.listings
  ADD COLUMN IF NOT EXISTS batch_id                 uuid REFERENCES public.listing_generation_batches(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS scheduled_publish_at     timestamptz,
  ADD COLUMN IF NOT EXISTS publish_error            text,
  ADD COLUMN IF NOT EXISTS publish_failed_at        timestamptz,
  -- eBay condition enum value (e.g. NEW, USED_EXCELLENT) — distinct from the
  -- internal grade. ebay_condition_description is the seller-facing narrative.
  ADD COLUMN IF NOT EXISTS ebay_condition           text,
  ADD COLUMN IF NOT EXISTS ebay_condition_description text,
  -- Seller-edited item specifics, overriding inventory_items.ebay_aspects.
  ADD COLUMN IF NOT EXISTS item_specifics_override  jsonb,
  ADD COLUMN IF NOT EXISTS return_policy_id         text,
  ADD COLUMN IF NOT EXISTS shipping_policy_id       text,
  ADD COLUMN IF NOT EXISTS payment_policy_id        text,
  ADD COLUMN IF NOT EXISTS quantity                 integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS best_offer_enabled       boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS synced_to_ebay_at        timestamptz,
  -- True when listing_price came from the AI estimate (no eBay comps found),
  -- so the editor can flag the price as unverified (US-312).
  ADD COLUMN IF NOT EXISTS price_is_estimated       boolean NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_listings_batch_id
  ON public.listings(batch_id) WHERE batch_id IS NOT NULL;
-- Drives the scheduled-publish worker (US-322): find due, not-yet-synced rows.
CREATE INDEX IF NOT EXISTS idx_listings_scheduled_publish_at
  ON public.listings(scheduled_publish_at)
  WHERE scheduled_publish_at IS NOT NULL AND synced_to_ebay_at IS NULL;

-- inventory_items: when AutoLister last AI-generated listing fields for this item.
ALTER TABLE public.inventory_items
  ADD COLUMN IF NOT EXISTS ai_generated_aspects_at timestamptz;

-- ══════════════════════════════════════════════════════════
-- ROW LEVEL SECURITY
-- ══════════════════════════════════════════════════════════

ALTER TABLE public.listing_generation_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.listing_generation_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.business_policies ENABLE ROW LEVEL SECURITY;

-- CREATE POLICY has no IF NOT EXISTS in Postgres, so each is preceded by a
-- DROP POLICY IF EXISTS to keep this migration safely re-runnable.

-- Batches: own data only
DROP POLICY IF EXISTS "Users can view own generation batches" ON public.listing_generation_batches;
CREATE POLICY "Users can view own generation batches"
  ON public.listing_generation_batches FOR SELECT USING (auth.uid() = user_id);
DROP POLICY IF EXISTS "Users can create generation batches" ON public.listing_generation_batches;
CREATE POLICY "Users can create generation batches"
  ON public.listing_generation_batches FOR INSERT WITH CHECK (auth.uid() = user_id);
DROP POLICY IF EXISTS "Users can update own generation batches" ON public.listing_generation_batches;
CREATE POLICY "Users can update own generation batches"
  ON public.listing_generation_batches FOR UPDATE USING (auth.uid() = user_id);
DROP POLICY IF EXISTS "Users can delete own generation batches" ON public.listing_generation_batches;
CREATE POLICY "Users can delete own generation batches"
  ON public.listing_generation_batches FOR DELETE USING (auth.uid() = user_id);

-- Jobs: via parent batch ownership
DROP POLICY IF EXISTS "Users can view own generation jobs" ON public.listing_generation_jobs;
CREATE POLICY "Users can view own generation jobs"
  ON public.listing_generation_jobs FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM public.listing_generation_batches b
      WHERE b.id = listing_generation_jobs.batch_id
        AND b.user_id = auth.uid()
    )
  );
DROP POLICY IF EXISTS "Users can create generation jobs" ON public.listing_generation_jobs;
CREATE POLICY "Users can create generation jobs"
  ON public.listing_generation_jobs FOR INSERT WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.listing_generation_batches b
      WHERE b.id = listing_generation_jobs.batch_id
        AND b.user_id = auth.uid()
    )
  );
DROP POLICY IF EXISTS "Users can update own generation jobs" ON public.listing_generation_jobs;
CREATE POLICY "Users can update own generation jobs"
  ON public.listing_generation_jobs FOR UPDATE USING (
    EXISTS (
      SELECT 1 FROM public.listing_generation_batches b
      WHERE b.id = listing_generation_jobs.batch_id
        AND b.user_id = auth.uid()
    )
  );
DROP POLICY IF EXISTS "Users can delete own generation jobs" ON public.listing_generation_jobs;
CREATE POLICY "Users can delete own generation jobs"
  ON public.listing_generation_jobs FOR DELETE USING (
    EXISTS (
      SELECT 1 FROM public.listing_generation_batches b
      WHERE b.id = listing_generation_jobs.batch_id
        AND b.user_id = auth.uid()
    )
  );

-- Business policies: own data only
DROP POLICY IF EXISTS "Users can view own business policies" ON public.business_policies;
CREATE POLICY "Users can view own business policies"
  ON public.business_policies FOR SELECT USING (auth.uid() = user_id);
DROP POLICY IF EXISTS "Users can create business policies" ON public.business_policies;
CREATE POLICY "Users can create business policies"
  ON public.business_policies FOR INSERT WITH CHECK (auth.uid() = user_id);
DROP POLICY IF EXISTS "Users can update own business policies" ON public.business_policies;
CREATE POLICY "Users can update own business policies"
  ON public.business_policies FOR UPDATE USING (auth.uid() = user_id);
DROP POLICY IF EXISTS "Users can delete own business policies" ON public.business_policies;
CREATE POLICY "Users can delete own business policies"
  ON public.business_policies FOR DELETE USING (auth.uid() = user_id);
