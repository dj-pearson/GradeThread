-- Closed-loop sale-outcome feedback (US-132).
--
-- When a FlipDesk user opts in (`users.share_sale_outcomes = true`), every
-- sale of an inventory item that was graded by GradeThread writes a row to
-- `grade_outcomes`. The dataset feeds back into the grade-to-price
-- correlation analysis (per PRD 6.4) so the AI model can self-refine over
-- time.
--
-- Privacy: opt-IN only. The trigger silently no-ops when the user hasn't
-- enabled sharing. No buyer-identifiable fields are captured — only the
-- grade report id, listing-side price metadata, and a coarse outcome flag.

-- ── User toggle ────────────────────────────────────────────────────
ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS share_sale_outcomes boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.users.share_sale_outcomes IS
  'Opt-in: when true, sales of graded items emit anonymized rows to grade_outcomes for AI model refinement.';

-- ── grade_outcomes ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.grade_outcomes (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  grade_report_id    uuid NOT NULL REFERENCES public.grade_reports(id) ON DELETE CASCADE,
  -- Snapshot inputs so the dataset stays useful even if the source
  -- inventory_item / sale rows are later edited or deleted.
  inventory_item_id  uuid REFERENCES public.inventory_items(id) ON DELETE SET NULL,
  sale_id            uuid REFERENCES public.sales(id) ON DELETE SET NULL,
  listing_price      decimal,
  sold_price         decimal,
  sold_at            timestamptz,
  dispute_reported   boolean NOT NULL DEFAULT false,
  source             text NOT NULL DEFAULT 'flipdesk',
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

-- Idempotency key: one outcome row per (grade_report, sale) pair. Upserts
-- on sale update don't multiply the dataset.
CREATE UNIQUE INDEX IF NOT EXISTS idx_grade_outcomes_report_sale
  ON public.grade_outcomes(grade_report_id, sale_id)
  WHERE sale_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_grade_outcomes_report
  ON public.grade_outcomes(grade_report_id);
CREATE INDEX IF NOT EXISTS idx_grade_outcomes_sold_at
  ON public.grade_outcomes(sold_at);

CREATE TRIGGER set_grade_outcomes_updated_at
  BEFORE UPDATE ON public.grade_outcomes
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ── RLS ────────────────────────────────────────────────────────────
-- Read access for the user that owns the underlying grade_report (so they
-- can see what's in their feedback bucket). No insert/update/delete policy
-- — writes happen via the SECURITY DEFINER trigger only.
ALTER TABLE public.grade_outcomes ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users read their own grade outcomes"
  ON public.grade_outcomes FOR SELECT
  USING (
    EXISTS (
      SELECT 1
      FROM public.grade_reports gr
      JOIN public.submissions s ON s.id = gr.submission_id
      WHERE gr.id = grade_outcomes.grade_report_id
        AND s.user_id = auth.uid()
    )
  );

CREATE POLICY "Admins read all grade outcomes"
  ON public.grade_outcomes FOR SELECT
  USING (public.is_admin());

-- ── Sales-side trigger ─────────────────────────────────────────────
-- Fires after every sales insert/update. Resolves the linked grade_report
-- via inventory_items, checks the user's opt-in, and upserts the outcome.
CREATE OR REPLACE FUNCTION public.sync_grade_outcome_from_sale()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_grade_report_id uuid;
  v_user_id uuid;
  v_share_outcomes boolean;
  v_listing_price decimal;
BEGIN
  SELECT ii.grade_report_id, ii.user_id
    INTO v_grade_report_id, v_user_id
  FROM public.inventory_items ii
  WHERE ii.id = NEW.inventory_item_id;

  IF v_grade_report_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT share_sale_outcomes INTO v_share_outcomes
  FROM public.users
  WHERE id = v_user_id;

  IF v_share_outcomes IS DISTINCT FROM true THEN
    RETURN NEW;
  END IF;

  -- Pull the listing price from the most recently linked listing (if any).
  -- Falls through to NULL — sold-price-only rows are still useful signal.
  IF NEW.listing_id IS NOT NULL THEN
    SELECT listing_price INTO v_listing_price
    FROM public.listings
    WHERE id = NEW.listing_id;
  ELSE
    SELECT listing_price INTO v_listing_price
    FROM public.listings
    WHERE inventory_item_id = NEW.inventory_item_id
    ORDER BY created_at DESC
    LIMIT 1;
  END IF;

  INSERT INTO public.grade_outcomes (
    grade_report_id, inventory_item_id, sale_id,
    listing_price, sold_price, sold_at, source
  )
  VALUES (
    v_grade_report_id, NEW.inventory_item_id, NEW.id,
    v_listing_price, NEW.sale_price, NEW.sale_date, 'flipdesk'
  )
  ON CONFLICT (grade_report_id, sale_id) WHERE sale_id IS NOT NULL
  DO UPDATE SET
    listing_price = EXCLUDED.listing_price,
    sold_price    = EXCLUDED.sold_price,
    sold_at       = EXCLUDED.sold_at,
    updated_at    = now();

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_sales_sync_grade_outcome
  AFTER INSERT OR UPDATE OF sale_price, sale_date, listing_id
  ON public.sales
  FOR EACH ROW
  EXECUTE FUNCTION public.sync_grade_outcome_from_sale();

-- ── Dispute-side trigger ───────────────────────────────────────────
-- When a dispute is filed against a submission whose grade we already
-- have a sale-outcome for, flip dispute_reported=true so the dataset
-- carries the soft negative signal forward.
CREATE OR REPLACE FUNCTION public.flag_grade_outcome_on_dispute()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE public.grade_outcomes
  SET dispute_reported = true, updated_at = now()
  WHERE grade_report_id = NEW.grade_report_id;

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_disputes_flag_grade_outcome
  AFTER INSERT ON public.disputes
  FOR EACH ROW
  EXECUTE FUNCTION public.flag_grade_outcome_on_dispute();
