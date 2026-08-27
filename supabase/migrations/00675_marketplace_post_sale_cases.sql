-- US-2927: one local row per post-sale case a marketplace opens against a seller.
--
-- Until now every return, cancellation and payment dispute was a LIVE fetch on
-- page load. Three consequences, all of them live defects: the page cost eBay
-- call quota every time it opened, nothing survived eBay's own retention window,
-- and no deadline, history or analytic could exist because there was nothing to
-- read. This table is the record; eBay stays the source of truth for STATE.
--
-- case_type covers the five shapes a post-sale case takes. `inquiry` and `case`
-- have no reader yet (US-2928 / US-2929 add them) and are in the CHECK now so
-- those stories need no second migration.

CREATE TABLE IF NOT EXISTS public.marketplace_post_sale_cases (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  platform          text NOT NULL DEFAULT 'ebay',
  case_type         text NOT NULL,
  external_id       text NOT NULL,
  external_order_id text,
  item_external_id  text,
  inventory_item_id uuid REFERENCES public.inventory_items(id) ON DELETE SET NULL,
  sale_id           uuid REFERENCES public.sales(id) ON DELETE SET NULL,
  state             text,
  reason            text,
  buyer_username    text,
  amount_cents      integer,
  currency          text,
  opened_at         timestamptz,
  respond_by        timestamptz,
  closed_at         timestamptz,
  outcome           text,
  -- The last payload eBay served for this case. Kept so a shape change in their
  -- API is diagnosable from the row rather than only from a log we no longer have.
  raw               jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_seen_at      timestamptz NOT NULL DEFAULT now(),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT marketplace_post_sale_cases_type_check CHECK (
    case_type IN ('return', 'cancellation', 'payment_dispute', 'inquiry', 'case')
  ),
  UNIQUE (user_id, platform, case_type, external_id)
);

-- The Post-sale page reads one seller's open cases ordered by deadline. Null
-- deadlines sort last, which is what the page shows, so the index says so too.
CREATE INDEX IF NOT EXISTS idx_mpsc_user_open_deadline
  ON public.marketplace_post_sale_cases(user_id, respond_by NULLS LAST)
  WHERE closed_at IS NULL;

-- The analytics slice (US-2936) joins by item; the reconciler looks up by order.
CREATE INDEX IF NOT EXISTS idx_mpsc_user_item
  ON public.marketplace_post_sale_cases(user_id, item_external_id)
  WHERE item_external_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_mpsc_user_order
  ON public.marketplace_post_sale_cases(user_id, external_order_id)
  WHERE external_order_id IS NOT NULL;

DROP TRIGGER IF EXISTS set_marketplace_post_sale_cases_updated_at
  ON public.marketplace_post_sale_cases;
CREATE TRIGGER set_marketplace_post_sale_cases_updated_at
  BEFORE UPDATE ON public.marketplace_post_sale_cases
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- RLS: a seller reads their own cases and nothing else. The edge writes through
-- the service-role client, which bypasses this, so the edge ALSO filters on
-- user_id explicitly (US-268) — this policy is the second lock, not the only one.
ALTER TABLE public.marketplace_post_sale_cases ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "own post sale cases" ON public.marketplace_post_sale_cases;
CREATE POLICY "own post sale cases" ON public.marketplace_post_sale_cases
  -- US-1927: the wrapped INITPLAN form, so the session-user lookup hoists to a
  -- single initplan instead of being re-evaluated once per row.
  FOR SELECT USING ((select auth.uid()) = user_id);

COMMENT ON TABLE public.marketplace_post_sale_cases IS
  'US-2927: local record of every post-sale case a marketplace opens against a seller '
  '(return, cancellation, payment dispute, inquiry, MBG case). eBay remains the source '
  'of truth for state; this table exists so history, deadlines and analytics can be read '
  'without a live call. An empty table is the normal state for a seller with no open cases.';

-- US-1108: self-record so the edge schema-version boot guard (US-778) stays
-- truthful regardless of how the SQL was applied.
INSERT INTO public.applied_migrations (version) VALUES ('00675') ON CONFLICT DO NOTHING;
