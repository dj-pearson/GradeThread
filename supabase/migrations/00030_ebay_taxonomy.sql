-- FlipDesk → eBay taxonomy + aspects.
-- Week 1 of the "snap → list" pipeline. Adds:
--   1. ebay_category_id + ebay_aspects on inventory_items so a drafted item
--      remembers the eBay leaf category it was matched to and the per-aspect
--      values (Department, Sleeve Length, Pattern, …) the AI fills in.
--   2. ebay_category_aspects cache table so the Taxonomy API responses don't
--      need to be re-fetched on every composer load — aspects per category
--      change very slowly.

-- ── 1. inventory_items extensions ──────────────────────────────────
ALTER TABLE public.inventory_items
  ADD COLUMN IF NOT EXISTS ebay_category_id text,
  ADD COLUMN IF NOT EXISTS ebay_aspects     jsonb;

CREATE INDEX IF NOT EXISTS idx_inventory_items_ebay_category_id
  ON public.inventory_items(ebay_category_id)
  WHERE ebay_category_id IS NOT NULL;

-- ── 2. Taxonomy cache ──────────────────────────────────────────────
-- One row per (marketplace_id, category_tree_id, category_id). Aspects from
-- eBay are stored verbatim under `aspects`; `fetched_at` drives TTL refresh.
CREATE TABLE IF NOT EXISTS public.ebay_category_aspects (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  marketplace_id    text NOT NULL,
  category_tree_id  text NOT NULL,
  category_id       text NOT NULL,
  category_name     text,
  -- eBay's getItemAspectsForCategory response body.
  aspects           jsonb NOT NULL,
  fetched_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (marketplace_id, category_tree_id, category_id)
);

CREATE INDEX IF NOT EXISTS idx_ebay_category_aspects_category_id
  ON public.ebay_category_aspects(category_id);

-- This cache is shared across all users — every seller benefits from a
-- single warm cache entry. Read-allowed to any authenticated user; writes
-- go through the service-role edge client.
ALTER TABLE public.ebay_category_aspects ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can read ebay category aspects"
  ON public.ebay_category_aspects FOR SELECT
  USING (auth.role() = 'authenticated');

-- ── 3. OAuth CSRF state ────────────────────────────────────────────
-- One row per OAuth start; deleted on callback. Keyed by a random `state`
-- token; carries the originating user id so the callback (which arrives
-- unauthenticated from eBay's redirect) can identify the user safely.
CREATE TABLE IF NOT EXISTS public.oauth_states (
  state        text PRIMARY KEY,
  user_id      uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  marketplace  public.listing_platform NOT NULL,
  redirect_to  text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL DEFAULT (now() + interval '15 minutes')
);

CREATE INDEX IF NOT EXISTS idx_oauth_states_user_id
  ON public.oauth_states(user_id);
CREATE INDEX IF NOT EXISTS idx_oauth_states_expires_at
  ON public.oauth_states(expires_at);

-- OAuth state is server-side only — no client-side reads.
ALTER TABLE public.oauth_states ENABLE ROW LEVEL SECURITY;
-- No policies → all access via service-role client only.
