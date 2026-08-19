-- US-2683: the buyer queries eBay reports back, per seller.
--
-- Everything FlipDesk knew about buyer language was inferred from other
-- sellers' listings. Promoted Listings Priority (CPC) reports are the one place
-- eBay hands a seller the queries buyers actually typed against their own
-- items, so these rows are ground truth and the mined comp terms are not.
--
-- One row per (seller, term, report type). The report type is part of the key
-- because a keyword report and a search-query report say different things about
-- the same string: the first is what the seller BID on, the second is what a
-- buyer TYPED, and collapsing them would let a bid term masquerade as demand.

CREATE TABLE IF NOT EXISTS public.ebay_search_terms (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  term             text NOT NULL,
  report_type      text NOT NULL,
  impressions      integer NOT NULL DEFAULT 0,
  clicks           integer NOT NULL DEFAULT 0,
  attributed_sales integer NOT NULL DEFAULT 0,
  last_seen_at     timestamptz NOT NULL DEFAULT now(),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, term, report_type)
);

-- The demand-term reader fetches a seller's best terms; the unique index above
-- already covers the upsert.
CREATE INDEX IF NOT EXISTS idx_ebay_search_terms_user_impressions
  ON public.ebay_search_terms(user_id, impressions DESC);

DROP TRIGGER IF EXISTS set_ebay_search_terms_updated_at ON public.ebay_search_terms;
CREATE TRIGGER set_ebay_search_terms_updated_at
  BEFORE UPDATE ON public.ebay_search_terms
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- RLS: a seller reads their own terms and nothing else. The edge writes through
-- the service-role client, which bypasses this, so the edge ALSO filters on
-- user_id explicitly (US-268) — this policy is the second lock, not the only one.
ALTER TABLE public.ebay_search_terms ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "own search terms" ON public.ebay_search_terms;
CREATE POLICY "own search terms" ON public.ebay_search_terms
  -- US-1927: the wrapped INITPLAN form. Unwrapped, the planner re-evaluates the
  -- session-user lookup once PER ROW; wrapped, it hoists to a single initplan.
  -- (The unwrapped spelling is deliberately not written here: rls-guard scans
  -- this file as text and a comment showing it would fail the guard.)
  FOR SELECT USING ((select auth.uid()) = user_id);

COMMENT ON TABLE public.ebay_search_terms IS
  'US-2683: buyer queries from eBay Promoted Listings reports, per seller. Ground '
  'truth for title vocabulary, unlike comp-mined terms which are other sellers writing. '
  'Gated on the seller running a Priority (CPC) campaign; an empty table is the normal '
  'state for everyone else and is not an error.';

-- US-1108: self-record so the edge schema-version boot guard (US-778) stays
-- truthful regardless of how the SQL was applied.
INSERT INTO public.applied_migrations (version) VALUES ('00622') ON CONFLICT DO NOTHING;
