-- US-566: per-category eBay condition allow-list cache.
--
-- eBay's Taxonomy `get_item_condition_policies` returns the numeric
-- conditionId allow-list for a leaf category. Some leaves (vintage, designer,
-- collectibles) restrict the accepted set, so publish pre-flight validates the
-- chosen condition against this list instead of eating a raw eBay error.
--
-- Same shared-cache model as ebay_category_aspects (00030): one warm row per
-- (marketplace_id, category_tree_id, category_id), readable by any
-- authenticated user, written only via the service-role edge client.

CREATE TABLE IF NOT EXISTS public.ebay_category_condition_policies (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  marketplace_id    text NOT NULL,
  category_tree_id  text NOT NULL,
  category_id       text NOT NULL,
  -- Allowed eBay conditionIds, e.g. ['1000','1500','3000']. Empty array means
  -- "eBay returned no restriction" (category accepts the default set).
  condition_ids     text[] NOT NULL DEFAULT '{}',
  fetched_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (marketplace_id, category_tree_id, category_id)
);

CREATE INDEX IF NOT EXISTS idx_ebay_condition_policies_category_id
  ON public.ebay_category_condition_policies(category_id);

ALTER TABLE public.ebay_category_condition_policies ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can read ebay condition policies"
  ON public.ebay_category_condition_policies FOR SELECT
  USING (auth.role() = 'authenticated');
