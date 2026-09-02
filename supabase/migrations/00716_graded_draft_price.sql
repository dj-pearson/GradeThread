-- US-9205: the graded price is the draft price, not a suggestion.
--
-- A new draft opens with its price already set from the grade and the
-- condition-matched sold comps. That makes provenance a fact worth keeping:
--   listings.price_set_by       - who set the current price: graded (grade +
--                                 comps), comp_median (no grade yet), seller
--                                 (typed over the prefill), rule (a repricing
--                                 rule moved it).
--   listings.graded_price_cents - the graded price at the time it was offered,
--                                 kept even when the seller overrides it, so a
--                                 later analysis can compare graded price vs
--                                 seller price vs sale price.
--   listings.graded_price_why   - the one-line reason shown with the prefill.
--   repricing_rules.override_manual - a rule may move a seller-set price only
--                                 when it says so. Default off.
-- A seller override is also written as a repricing_actions row with reason
-- 'seller_override' (old = graded, new = seller), which is what the policy
-- below allows the browser to insert.

ALTER TABLE public.listings
  ADD COLUMN IF NOT EXISTS price_set_by text,
  ADD COLUMN IF NOT EXISTS graded_price_cents integer,
  ADD COLUMN IF NOT EXISTS graded_price_why text;

ALTER TABLE public.listings DROP CONSTRAINT IF EXISTS listings_price_set_by_check;
ALTER TABLE public.listings
  ADD CONSTRAINT listings_price_set_by_check
  CHECK (price_set_by IS NULL OR price_set_by IN ('graded', 'comp_median', 'seller', 'rule'));

COMMENT ON COLUMN public.listings.price_set_by IS
  'US-9205: who set the current price. graded = grade + sold comps, comp_median = no grade yet, seller = typed over the prefill, rule = a repricing rule. NULL for rows saved before the column existed.';
COMMENT ON COLUMN public.listings.graded_price_cents IS
  'US-9205: the graded price offered for this listing, kept when the seller overrides it.';

ALTER TABLE public.repricing_rules
  ADD COLUMN IF NOT EXISTS override_manual boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.repricing_rules.override_manual IS
  'US-9205: when false (default) the rule skips listings whose price the seller set by hand (price_set_by = seller).';

DROP POLICY IF EXISTS "Users can record own price overrides" ON public.repricing_actions;
CREATE POLICY "Users can record own price overrides"
  ON public.repricing_actions FOR INSERT
  -- US-1927 AC1: (select auth.uid()) so the planner hoists it to one InitPlan
  -- instead of re-evaluating per row. Identical membership; auth.uid() is STABLE.
  WITH CHECK ((select auth.uid()) = user_id AND reason = 'seller_override');

insert into public.applied_migrations (version) values ('00716') on conflict do nothing;
