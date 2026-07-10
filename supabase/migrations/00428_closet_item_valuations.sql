-- US-1826: portfolio valuation cache.
--
-- A per-closet-item current-value ESTIMATE (never a fabricated exact price) with
-- a confidence band + the basis signals that fed it (cost basis from purchase
-- links, realized grade_outcomes prices, Value Index fair value, gentle
-- age-depreciation). Recomputation is cost-controlled: valuations are CACHED here
-- and refreshed on read only when stale (the edge TTL), bounded per user — no
-- live Value Index scan per portfolio view. Owner-read / service-write.

CREATE TABLE IF NOT EXISTS public.closet_item_valuations (
  closet_item_id   uuid PRIMARY KEY REFERENCES public.closet_items(id) ON DELETE CASCADE,
  user_id          uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  -- The labeled current estimate + confidence band (null when there's no signal
  -- at all — we never invent a number).
  estimate_cents   integer,
  low_cents        integer,
  high_cents       integer,
  -- 'high' | 'medium' | 'low' | 'none'.
  confidence       text NOT NULL DEFAULT 'none',
  -- Which signals fed the estimate: ['realized','value_index','cost_basis'].
  basis            jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- Cost basis (from the purchase link) so gain/loss is computable without a re-join.
  cost_basis_cents integer,
  -- Coarse per-item gain/loss trend vs cost basis: 'up' | 'down' | 'flat' | 'unknown'.
  trend            text NOT NULL DEFAULT 'unknown',
  computed_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_closet_item_valuations_user
  ON public.closet_item_valuations (user_id);

ALTER TABLE public.closet_item_valuations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users read own closet valuations" ON public.closet_item_valuations;
CREATE POLICY "Users read own closet valuations"
  ON public.closet_item_valuations FOR SELECT USING (auth.uid() = user_id);

-- US-1108: self-record so the edge schema-version guard stays truthful.
INSERT INTO public.applied_migrations (version) VALUES ('00428')
ON CONFLICT (version) DO NOTHING;
