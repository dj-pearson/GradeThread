-- Full-text search across inventory_items, listings, and sales.
-- Weighted tsvector generated columns + GIN indexes + a unified search RPC.

-- ══════════════════════════════════════════════════════════
-- tsvector generated columns
-- Weights: title = A, brand/sku = B, description = C, notes = D
-- ══════════════════════════════════════════════════════════

ALTER TABLE public.inventory_items
  ADD COLUMN IF NOT EXISTS search_vec tsvector
  GENERATED ALWAYS AS (
    setweight(to_tsvector('english', coalesce(title, '')), 'A') ||
    setweight(
      to_tsvector('english', coalesce(brand, '') || ' ' || coalesce(sku, '')),
      'B'
    ) ||
    setweight(to_tsvector('english', coalesce(description, '')), 'C') ||
    setweight(to_tsvector('english', coalesce(condition_notes, '')), 'D')
  ) STORED;

CREATE INDEX IF NOT EXISTS idx_inventory_items_search_vec
  ON public.inventory_items USING GIN (search_vec);

ALTER TABLE public.listings
  ADD COLUMN IF NOT EXISTS search_vec tsvector
  GENERATED ALWAYS AS (
    setweight(to_tsvector('english', coalesce(listing_title, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(listing_description, '')), 'C')
  ) STORED;

CREATE INDEX IF NOT EXISTS idx_listings_search_vec
  ON public.listings USING GIN (search_vec);

ALTER TABLE public.sales
  ADD COLUMN IF NOT EXISTS search_vec tsvector
  GENERATED ALWAYS AS (
    setweight(
      to_tsvector(
        'english',
        coalesce(buyer_username, '') || ' ' || coalesce(buyer_notes, '')
      ),
      'B'
    )
  ) STORED;

CREATE INDEX IF NOT EXISTS idx_sales_search_vec
  ON public.sales USING GIN (search_vec);

-- ══════════════════════════════════════════════════════════
-- Unified search RPC
-- SECURITY INVOKER (the default for SQL functions) — RLS on the
-- underlying tables filters to the caller's own rows.
-- ══════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.flipdesk_search(
  p_query text,
  p_scope text DEFAULT 'all',
  p_limit int DEFAULT 50
)
RETURNS TABLE (
  result_type   text,
  result_id     uuid,
  inventory_item_id uuid,
  title         text,
  snippet       text,
  rank          real
)
LANGUAGE sql
STABLE
AS $$
  WITH q AS (
    SELECT websearch_to_tsquery('english', p_query) AS tsq
  )
  SELECT * FROM (
    SELECT
      'item'::text AS result_type,
      i.id         AS result_id,
      i.id         AS inventory_item_id,
      i.title      AS title,
      ts_headline(
        'english',
        coalesce(i.title, '') || ' — ' || coalesce(i.description, '') ||
          ' ' || coalesce(i.condition_notes, ''),
        q.tsq,
        'StartSel=<mark>,StopSel=</mark>,MaxFragments=1,MaxWords=18,MinWords=5'
      )            AS snippet,
      ts_rank(i.search_vec, q.tsq) AS rank
    FROM public.inventory_items i, q
    WHERE (p_scope = 'all' OR p_scope = 'items')
      AND q.tsq IS NOT NULL
      AND i.search_vec @@ q.tsq

    UNION ALL

    SELECT
      'listing'::text,
      l.id,
      l.inventory_item_id,
      l.listing_title,
      ts_headline(
        'english',
        coalesce(l.listing_title, '') || ' — ' ||
          coalesce(l.listing_description, ''),
        q.tsq,
        'StartSel=<mark>,StopSel=</mark>,MaxFragments=1,MaxWords=18,MinWords=5'
      ),
      ts_rank(l.search_vec, q.tsq)
    FROM public.listings l, q
    WHERE (p_scope = 'all' OR p_scope = 'listings')
      AND q.tsq IS NOT NULL
      AND l.search_vec @@ q.tsq

    UNION ALL

    SELECT
      'sale'::text,
      sa.id,
      sa.inventory_item_id,
      coalesce(sa.buyer_username, 'Sale'),
      ts_headline(
        'english',
        coalesce(sa.buyer_username, '') || ' ' || coalesce(sa.buyer_notes, ''),
        q.tsq,
        'StartSel=<mark>,StopSel=</mark>,MaxFragments=1,MaxWords=18,MinWords=5'
      ),
      ts_rank(sa.search_vec, q.tsq)
    FROM public.sales sa, q
    WHERE (p_scope = 'all' OR p_scope = 'sales')
      AND q.tsq IS NOT NULL
      AND sa.search_vec @@ q.tsq
  ) results
  ORDER BY rank DESC
  LIMIT GREATEST(1, LEAST(p_limit, 200));
$$;

GRANT EXECUTE ON FUNCTION public.flipdesk_search(text, text, int)
  TO authenticated;
