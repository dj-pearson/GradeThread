-- US-1841: buyer-requested walk-around video grades.
--
-- The clip path (00532) was reachable only through a paid FlipDesk plan, while
-- both paid BUYER tiers already advertised video-grade credits. This adds the
-- three things the buyer binding needs, and nothing else:
--
--   1. a payment_status the buyer pocket can be recorded under,
--   2. the columns saying WHICH pocket paid (so a refund goes back to it),
--   3. the closet link, so the result lands in the buyer's portfolio.
--
-- Contract + rationale: vault/20-domain/buyer-platform.md.

-- 1. A fourth way a submission can be paid for: one video-grade credit from the
--    buyer's plan allowance or reward balance (00413 / buyer-metering.ts). Kept
--    DISTINCT from 'credits' (which means the seller's grade_credit_balance was
--    debited) so billing analytics and refund_grade can tell them apart.
--    PG12+ allows this inside a transaction; the value is not USED in this file.
ALTER TYPE public.submission_payment_status ADD VALUE IF NOT EXISTS 'buyer_credits';

ALTER TABLE public.submissions
  -- 2. Marks the clip grade as buyer-funded, and records which pocket paid so a
  --    refund returns to the SAME one (the US-1800 precedence rule).
  ADD COLUMN IF NOT EXISTS buyer_video_grade boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS buyer_credit_source text
    CHECK (buyer_credit_source IS NULL OR buyer_credit_source IN ('allowance', 'reward')),
  -- 3. The buyer's closet item this grade was requested for (US-1825). Nullable:
  --    a seller grade has no closet item, and a deleted closet item must not take
  --    the submission with it.
  ADD COLUMN IF NOT EXISTS closet_item_id uuid
    REFERENCES public.closet_items(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.submissions.buyer_video_grade IS
  'US-1841: this clip grade was funded by a buyer video-grade credit, not by the '
  'seller grade precedence. buyer_credit_source says which pocket paid.';
COMMENT ON COLUMN public.submissions.closet_item_id IS
  'US-1841: the buyer closet item (00420) this grade was requested for; the '
  'finished grade is written back onto it.';

-- Backs the portfolio read "the grades for my closet items" and the write-back.
CREATE INDEX IF NOT EXISTS idx_submissions_closet_item
  ON public.submissions(closet_item_id)
  WHERE closet_item_id IS NOT NULL;

-- refund_grade: identical to 00093 plus a branch that reverses a buyer-funded
-- clip grade into the pocket that paid for it.
--
-- Without the branch a buyer-funded submission that never graded falls into the
-- final ELSE and returns 'no_refund_buyer_credits' — the buyer silently loses the
-- credit for work that never happened. The comparison is on ::text deliberately:
-- casting the literal to the enum needs the value added above, which cannot be
-- USED in the same transaction that added it.
CREATE OR REPLACE FUNCTION public.refund_grade(p_submission_id uuid)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_user_id         uuid;
  v_payment_status  public.submission_payment_status;
  v_already         boolean;
  v_credits         integer;
  v_balance         integer;
  v_buyer_source    text;
BEGIN
  -- Claim under a row lock so concurrent callers can't double-refund.
  SELECT user_id, payment_status, (refunded_at IS NOT NULL), buyer_credit_source
    INTO v_user_id, v_payment_status, v_already, v_buyer_source
    FROM public.submissions
    WHERE id = p_submission_id
    FOR UPDATE;

  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'SUBMISSION_NOT_FOUND: %', p_submission_id;
  END IF;

  IF v_already THEN
    RETURN 'already_refunded';
  END IF;

  IF v_payment_status = 'included' THEN
    -- Return the grade to the monthly bundle.
    UPDATE public.users
      SET grades_used_this_month = GREATEST(grades_used_this_month - 1, 0),
          updated_at = now()
      WHERE id = v_user_id;

    -- US-398: zero-delta audit row → balance_after NULL (balance unchanged;
    -- never snapshot a non-atomic read).
    INSERT INTO public.grade_credit_transactions
      (user_id, delta, reason, balance_after, submission_id, notes)
      VALUES (v_user_id, 0, 'refund', NULL, p_submission_id,
              'Included grade returned to monthly bundle (grading failed)');

  ELSIF v_payment_status = 'credits' THEN
    -- Refund exactly what was debited for this submission.
    SELECT -delta INTO v_credits
      FROM public.grade_credit_transactions
      WHERE submission_id = p_submission_id AND reason = 'grade_debit'
      ORDER BY created_at DESC
      LIMIT 1;

    IF v_credits IS NOT NULL AND v_credits > 0 THEN
      SELECT grade_credit_balance INTO v_balance
        FROM public.users WHERE id = v_user_id FOR UPDATE;

      v_balance := v_balance + v_credits;

      UPDATE public.users
        SET grade_credit_balance = v_balance, updated_at = now()
        WHERE id = v_user_id;

      INSERT INTO public.grade_credit_transactions
        (user_id, delta, reason, balance_after, submission_id, notes)
        VALUES (v_user_id, v_credits, 'refund', v_balance, p_submission_id,
                v_credits || ' credit(s) refunded (grading failed)');
    END IF;

  ELSIF v_payment_status::text = 'buyer_credits' THEN
    -- US-1841/US-1800: back to the SAME pocket the precedence spent. Defaulting
    -- an unrecorded source to the monthly allowance matches the precedence order
    -- (allowance is tried first), so the common case is right and the worst case
    -- credits the buyer a unit rather than eating one.
    IF v_buyer_source = 'reward' THEN
      PERFORM public.refund_buyer_reward_credit(v_user_id, 'video_grades');
    ELSE
      PERFORM public.refund_buyer_meter(v_user_id, 'video_grades');
    END IF;

  ELSE
    -- 'unpaid' (nothing charged) or 'paid_stripe' (real money — must be
    -- refunded through Stripe, not by minting credits). Caller logs the
    -- paid_stripe case so an admin can issue the Stripe refund manually.
    RETURN 'no_refund_' || v_payment_status::text;
  END IF;

  UPDATE public.submissions
    SET refunded_at = now()
    WHERE id = p_submission_id;

  RETURN 'refunded_' || v_payment_status::text;
END;
$$;

REVOKE ALL ON FUNCTION public.refund_grade(uuid) FROM PUBLIC, anon, authenticated;

-- US-1108: self-record this migration's version so the edge schema-version
-- guard stays truthful regardless of apply method.
INSERT INTO public.applied_migrations (version) VALUES ('00536')
ON CONFLICT (version) DO NOTHING;
