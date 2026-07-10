-- US-1812: buyer grade confirm/dispute engine + grading feedback loop.
--
-- A buyer who linked a purchase (US-1811) and uploaded arrival photos now tells
-- us whether the item MATCHED its grade. That post-sale ground truth is the
-- two-sided moat: the same confirm/dispute event
--   (a) feeds the grading accuracy pipeline (grade_outcomes + per-prompt_version
--       signal + routes material disputes into the human-review queue),
--   (b) feeds the buyer's Trust Score (grade_confirmed reputation event, US-1817),
--   (c) feeds the SELLER's Grade Integrity aggregate (seller_grade_integrity —
--       the substrate US-1912 tiers/surfaces), and
--   (d) marks material mismatches guarantee-eligible so the US-1821 claim intake
--       can pick them up.
--
-- Buyer outcomes ride on the EXISTING grade_outcomes table (US-132/00036) with a
-- distinct `source = 'buyer_arrival'` so the seller-sale feedback readers can
-- keep excluding them. All writes are service-role (the edge verifies purchase
-- ownership, US-268); the buyer reads only their own rows.

-- ── grade_outcomes: buyer-confirmation columns (additive, nullable) ──────────
ALTER TABLE public.grade_outcomes
  ADD COLUMN IF NOT EXISTS buyer_user_id      uuid REFERENCES public.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS buyer_purchase_id  uuid REFERENCES public.buyer_purchases(id) ON DELETE CASCADE,
  -- Denormalized so the seller-integrity recompute is a single indexed scan and
  -- doesn't have to re-join grade_reports → submissions on every buyer outcome.
  ADD COLUMN IF NOT EXISTS seller_user_id     uuid REFERENCES public.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS match_status       text CHECK (match_status IS NULL OR match_status IN ('confirmed', 'disputed')),
  -- Per-factor buyer-reported over-grade points (same shape as claim_accuracy_signals).
  ADD COLUMN IF NOT EXISTS factor_deltas      jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS overall_delta      numeric,
  ADD COLUMN IF NOT EXISTS dispute_reason     text,
  ADD COLUMN IF NOT EXISTS dispute_severity   text CHECK (dispute_severity IS NULL OR dispute_severity IN ('cosmetic', 'material')),
  -- Snapshot the grading prompt version so the accuracy signal can be sliced per
  -- era (the grade_report row may later be superseded/re-graded).
  ADD COLUMN IF NOT EXISTS prompt_version     text,
  -- A material mismatch inside an eligible coverage window: the US-1821 claim
  -- intake reads this to know a purchase already has qualifying ground truth.
  ADD COLUMN IF NOT EXISTS guarantee_eligible boolean NOT NULL DEFAULT false,
  -- True once a dispute flipped the grade_report into the human-review queue.
  ADD COLUMN IF NOT EXISTS human_review_flagged boolean NOT NULL DEFAULT false;

-- One buyer outcome per purchase — re-submitting a verdict UPSERTs (never dupes).
CREATE UNIQUE INDEX IF NOT EXISTS idx_grade_outcomes_buyer_purchase
  ON public.grade_outcomes (buyer_purchase_id)
  WHERE buyer_purchase_id IS NOT NULL;

-- Seller-integrity recompute reads all buyer outcomes for one seller.
CREATE INDEX IF NOT EXISTS idx_grade_outcomes_seller_buyer
  ON public.grade_outcomes (seller_user_id)
  WHERE source = 'buyer_arrival';

-- The buyer reads back their own confirm/dispute rows (the seller/admin read
-- policies from 00036 stay in force for the seller-facing view).
DROP POLICY IF EXISTS "Buyers read their own grade outcomes" ON public.grade_outcomes;
CREATE POLICY "Buyers read their own grade outcomes"
  ON public.grade_outcomes FOR SELECT
  USING (auth.uid() = buyer_user_id);

-- ── seller_grade_integrity: per-seller aggregate (US-1912 substrate) ─────────
-- One row per seller who has graded an item a buyer later confirmed/disputed.
-- Recomputed idempotently from the buyer_arrival grade_outcomes rows on every
-- outcome — reconstructable, no drift. US-1912 layers tiers/badges on top.
CREATE TABLE IF NOT EXISTS public.seller_grade_integrity (
  seller_user_id         uuid PRIMARY KEY REFERENCES public.users(id) ON DELETE CASCADE,
  confirmed_count        integer NOT NULL DEFAULT 0,
  disputed_count         integer NOT NULL DEFAULT 0,
  material_dispute_count integer NOT NULL DEFAULT 0,
  total_outcomes         integer NOT NULL DEFAULT 0,
  -- 0–100; smoothed so a single early dispute can't tank a new seller.
  integrity_score        numeric NOT NULL DEFAULT 100,
  updated_at             timestamptz NOT NULL DEFAULT now()
);

DROP TRIGGER IF EXISTS set_seller_grade_integrity_updated_at ON public.seller_grade_integrity;
CREATE TRIGGER set_seller_grade_integrity_updated_at
  BEFORE UPDATE ON public.seller_grade_integrity
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.seller_grade_integrity ENABLE ROW LEVEL SECURITY;

-- The seller reads their own integrity row; admins read all. Writes are
-- service-role only (recompute runs on the edge) — no write policy.
DROP POLICY IF EXISTS "Sellers read their own grade integrity" ON public.seller_grade_integrity;
CREATE POLICY "Sellers read their own grade integrity"
  ON public.seller_grade_integrity FOR SELECT
  USING (auth.uid() = seller_user_id);

DROP POLICY IF EXISTS "Admins read all grade integrity" ON public.seller_grade_integrity;
CREATE POLICY "Admins read all grade integrity"
  ON public.seller_grade_integrity FOR SELECT
  USING (public.is_admin());

-- US-1108: self-record so the edge schema-version guard stays truthful.
INSERT INTO public.applied_migrations (version) VALUES ('00421')
ON CONFLICT (version) DO NOTHING;
