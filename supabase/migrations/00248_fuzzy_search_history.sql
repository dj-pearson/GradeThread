-- US-1053: fuzzy / typo-tolerant search + recent-search suggestions.
--
-- The unified flipdesk_search RPC (00016) only did exact tsvector matching, so a
-- typo like "Adiddas" returned nothing. This migration:
--   1. Adds pg_trgm GIN indexes on the brand/title columns so trigram similarity
--      lookups stay off full-table scans (pg_trgm itself was created in 00224).
--   2. Layers trigram similarity ALONGSIDE the FTS path in flipdesk_search with a
--      tunable threshold, so fuzzy brand/title matches surface while exact FTS
--      ranking still wins. Falls back gracefully: if trgm finds nothing, you keep
--      the FTS matches; if FTS finds nothing, fuzzy matches still appear.
--   3. Adds a per-user search_history table (RLS) + record_search / recent_searches
--      RPCs so the search UI can offer recent searches as suggestions.
-- Idempotent: IF NOT EXISTS / DROP-then-CREATE throughout.

-- ══════════════════════════════════════════════════════════
-- Trigram indexes for fuzzy brand/title matching
-- (pg_trgm extension already created in 00224)
-- ══════════════════════════════════════════════════════════

CREATE INDEX IF NOT EXISTS idx_inventory_items_title_trgm
  ON public.inventory_items USING GIN (title gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_inventory_items_brand_trgm
  ON public.inventory_items USING GIN (brand gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_listings_listing_title_trgm
  ON public.listings USING GIN (listing_title gin_trgm_ops);

-- ══════════════════════════════════════════════════════════
-- flipdesk_search: FTS + trigram similarity
-- Drop the old 3-arg signature so the new 4-arg version (extra
-- p_fuzzy_threshold) is unambiguous to PostgREST.
-- ══════════════════════════════════════════════════════════

DROP FUNCTION IF EXISTS public.flipdesk_search(text, text, int);

CREATE OR REPLACE FUNCTION public.flipdesk_search(
  p_query text,
  p_scope text DEFAULT 'all',
  p_limit int DEFAULT 50,
  p_fuzzy_threshold real DEFAULT 0.3
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
    SELECT
      websearch_to_tsquery('english', p_query) AS tsq,
      lower(btrim(coalesce(p_query, ''))) AS needle,
      GREATEST(0.0::real, LEAST(1.0::real, coalesce(p_fuzzy_threshold, 0.3))) AS thr
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
      GREATEST(
        coalesce(ts_rank(i.search_vec, q.tsq), 0)::real,
        similarity(
          lower(coalesce(i.title, '') || ' ' || coalesce(i.brand, '')),
          q.needle
        )
      ) AS rank
    FROM public.inventory_items i, q
    WHERE (p_scope = 'all' OR p_scope = 'items')
      AND (
        (q.tsq IS NOT NULL AND i.search_vec @@ q.tsq)
        OR (
          q.needle <> ''
          AND similarity(
            lower(coalesce(i.title, '') || ' ' || coalesce(i.brand, '')),
            q.needle
          ) >= q.thr
        )
      )

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
      GREATEST(
        coalesce(ts_rank(l.search_vec, q.tsq), 0)::real,
        similarity(lower(coalesce(l.listing_title, '')), q.needle)
      )
    FROM public.listings l, q
    WHERE (p_scope = 'all' OR p_scope = 'listings')
      AND (
        (q.tsq IS NOT NULL AND l.search_vec @@ q.tsq)
        OR (
          q.needle <> ''
          AND similarity(lower(coalesce(l.listing_title, '')), q.needle) >= q.thr
        )
      )

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
      GREATEST(
        coalesce(ts_rank(sa.search_vec, q.tsq), 0)::real,
        similarity(lower(coalesce(sa.buyer_username, '')), q.needle)
      )
    FROM public.sales sa, q
    WHERE (p_scope = 'all' OR p_scope = 'sales')
      AND (
        (q.tsq IS NOT NULL AND sa.search_vec @@ q.tsq)
        OR (
          q.needle <> ''
          AND similarity(lower(coalesce(sa.buyer_username, '')), q.needle) >= q.thr
        )
      )
  ) results
  ORDER BY rank DESC
  LIMIT GREATEST(1, LEAST(p_limit, 200));
$$;

GRANT EXECUTE ON FUNCTION public.flipdesk_search(text, text, int, real)
  TO authenticated;

-- ══════════════════════════════════════════════════════════
-- search_history: per-user recent searches
-- ══════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.search_history (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  query            text NOT NULL,
  -- Normalized form keeps one row per distinct search (case/space-insensitive).
  query_normalized text GENERATED ALWAYS AS (lower(btrim(query))) STORED,
  scope            text NOT NULL DEFAULT 'all',
  result_count     int,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

-- One row per (user, normalized query); record_search upserts onto this.
CREATE UNIQUE INDEX IF NOT EXISTS idx_search_history_user_norm
  ON public.search_history (user_id, query_normalized);
-- Recent-first lookups.
CREATE INDEX IF NOT EXISTS idx_search_history_user_recent
  ON public.search_history (user_id, updated_at DESC);

ALTER TABLE public.search_history ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view own search history" ON public.search_history;
CREATE POLICY "Users can view own search history"
  ON public.search_history FOR SELECT USING (auth.uid() = user_id);
DROP POLICY IF EXISTS "Users can create own search history" ON public.search_history;
CREATE POLICY "Users can create own search history"
  ON public.search_history FOR INSERT WITH CHECK (auth.uid() = user_id);
DROP POLICY IF EXISTS "Users can update own search history" ON public.search_history;
CREATE POLICY "Users can update own search history"
  ON public.search_history FOR UPDATE USING (auth.uid() = user_id);
DROP POLICY IF EXISTS "Users can delete own search history" ON public.search_history;
CREATE POLICY "Users can delete own search history"
  ON public.search_history FOR DELETE USING (auth.uid() = user_id);

DROP TRIGGER IF EXISTS set_search_history_updated_at ON public.search_history;
CREATE TRIGGER set_search_history_updated_at
  BEFORE UPDATE ON public.search_history
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ══════════════════════════════════════════════════════════
-- record_search / recent_searches RPCs
-- SECURITY INVOKER — RLS scopes both to the caller's own rows.
-- ══════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.record_search(
  p_query text,
  p_scope text DEFAULT 'all',
  p_result_count int DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY INVOKER
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_q   text := btrim(coalesce(p_query, ''));
BEGIN
  -- Ignore anonymous callers and trivially short queries.
  IF v_uid IS NULL OR length(v_q) < 2 THEN
    RETURN;
  END IF;
  INSERT INTO public.search_history (user_id, query, scope, result_count)
  VALUES (v_uid, v_q, coalesce(p_scope, 'all'), p_result_count)
  ON CONFLICT (user_id, query_normalized) DO UPDATE
    SET query        = EXCLUDED.query,
        scope        = EXCLUDED.scope,
        result_count = EXCLUDED.result_count,
        updated_at   = now();
END;
$$;

GRANT EXECUTE ON FUNCTION public.record_search(text, text, int) TO authenticated;

CREATE OR REPLACE FUNCTION public.recent_searches(p_limit int DEFAULT 8)
RETURNS TABLE (
  query        text,
  scope        text,
  result_count int,
  updated_at   timestamptz
)
LANGUAGE sql
STABLE
SECURITY INVOKER
AS $$
  SELECT query, scope, result_count, updated_at
  FROM public.search_history
  WHERE user_id = auth.uid()
  ORDER BY updated_at DESC
  LIMIT GREATEST(1, LEAST(coalesce(p_limit, 8), 50));
$$;

GRANT EXECUTE ON FUNCTION public.recent_searches(int) TO authenticated;
