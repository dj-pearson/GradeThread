-- US-1446: persist eBay Finances payouts (the lump-sum bank deposits) keyed by
-- payoutId, so resellers reconcile against the actual deposit — payout ->
-- constituent sales (sales.payout_reference already carries the payoutId) ->
-- net. This is the API source-of-truth alongside the manual payout_imports CSV.
--
-- Tenant table: user_id + RLS (users see only their own), mirroring payout_imports.
-- Idempotent: guarded creates + DROP POLICY IF EXISTS so it re-runs cleanly.

CREATE TABLE IF NOT EXISTS public.ebay_payouts (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  payout_id         text NOT NULL,
  amount_cents      integer,
  currency          text,
  status            text,
  payout_date       timestamptz,
  transaction_count integer,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, payout_id)
);

CREATE INDEX IF NOT EXISTS idx_ebay_payouts_user_id ON public.ebay_payouts(user_id);
CREATE INDEX IF NOT EXISTS idx_ebay_payouts_payout_date ON public.ebay_payouts(payout_date DESC);

ALTER TABLE public.ebay_payouts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view own ebay payouts" ON public.ebay_payouts;
CREATE POLICY "Users can view own ebay payouts"
  ON public.ebay_payouts FOR SELECT USING (auth.uid() = user_id);
DROP POLICY IF EXISTS "Users can create own ebay payouts" ON public.ebay_payouts;
CREATE POLICY "Users can create own ebay payouts"
  ON public.ebay_payouts FOR INSERT WITH CHECK (auth.uid() = user_id);
DROP POLICY IF EXISTS "Users can update own ebay payouts" ON public.ebay_payouts;
CREATE POLICY "Users can update own ebay payouts"
  ON public.ebay_payouts FOR UPDATE USING (auth.uid() = user_id);
DROP POLICY IF EXISTS "Users can delete own ebay payouts" ON public.ebay_payouts;
CREATE POLICY "Users can delete own ebay payouts"
  ON public.ebay_payouts FOR DELETE USING (auth.uid() = user_id);

DROP TRIGGER IF EXISTS set_ebay_payouts_updated_at ON public.ebay_payouts;
CREATE TRIGGER set_ebay_payouts_updated_at
  BEFORE UPDATE ON public.ebay_payouts
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- US-1108: self-record this migration's version so the edge schema-version
-- guard (US-778) stays in sync regardless of apply method.
INSERT INTO public.applied_migrations (version) VALUES ('00327') ON CONFLICT DO NOTHING;
