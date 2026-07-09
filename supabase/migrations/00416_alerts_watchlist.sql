-- US-1806: condition-based alerts — the watchlist + saved-search MODEL.
--
-- The foundation of the Alerts epic (US-1805). Two owner-managed tables:
--
--   • saved_searches  — a buyer's standing criteria ("Nike, size M tops, grade
--     ≥ 8, under $60"). The matching engine (US-1807) reads these (service-role,
--     scoped by user_id) to find newly-graded inventory that qualifies; the
--     delivery/management UI is US-1809.
--   • watchlist_items — a specific certificate / listing / passport the buyer is
--     watching, so a status/price change on THAT item can alert them.
--
-- Both are owner-managed from the SPA via RLS (no server logic on write), like
-- buyer_preferences (US-1798). Downstream EDGE features READ them via the
-- service-role client, which bypasses RLS and MUST scope by user_id (US-268).
-- Criteria on a saved search DEFAULT from buyer_preferences (US-1798) at create
-- time but are then individually editable and stored here — the two are not
-- kept in sync (a saved search is a snapshot the buyer tweaks).

-- ─── saved_searches ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.saved_searches (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  -- Buyer-facing name for the search ("Vintage Levi's 32x34").
  label            text NOT NULL DEFAULT 'Saved search',
  -- Criteria — discrete columns so the matching engine (US-1807) can filter in
  -- SQL. Mirror the buyer_preferences shape so defaults transfer cleanly.
  brands           text[] NOT NULL DEFAULT '{}',
  categories       text[] NOT NULL DEFAULT '{}',
  -- Sizes per garment group, e.g. { "tops": ["M","L"], "footwear": ["10"] }.
  sizes            jsonb  NOT NULL DEFAULT '{}'::jsonb,
  -- Free-text keywords matched against title/brand/notes (normalized client-side).
  keywords         text[] NOT NULL DEFAULT '{}',
  -- Minimum acceptable condition grade (1.0–10.0); null = no floor.
  min_grade        numeric(3,1) CHECK (min_grade IS NULL OR (min_grade >= 1.0 AND min_grade <= 10.0)),
  -- Price ceiling (cents); null = open. Floor is rarely wanted for a watch, so
  -- only a ceiling is modeled (add a floor later if buyers ask).
  max_price_cents  integer CHECK (max_price_cents IS NULL OR max_price_cents >= 0),
  -- Paused searches stay saved but stop matching/alerting.
  is_active        boolean NOT NULL DEFAULT true,
  -- Per-search notification opt-ins (defaults follow the buyer's global prefs).
  notify_email     boolean NOT NULL DEFAULT true,
  notify_push      boolean NOT NULL DEFAULT false,
  -- Set by the matching engine (US-1807) so a digest can say "last checked".
  last_matched_at  timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_saved_searches_user ON public.saved_searches(user_id);
-- Active-only partial index: the matching engine sweeps active searches.
CREATE INDEX IF NOT EXISTS idx_saved_searches_active ON public.saved_searches(user_id) WHERE is_active;

DROP TRIGGER IF EXISTS set_saved_searches_updated_at ON public.saved_searches;
CREATE TRIGGER set_saved_searches_updated_at
  BEFORE UPDATE ON public.saved_searches
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.saved_searches ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Users manage own saved searches" ON public.saved_searches;
CREATE POLICY "Users manage own saved searches"
  ON public.saved_searches FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- ─── watchlist_items ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.watchlist_items (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  -- What kind of thing is being watched. Kept as a CHECKed text (not an enum) so
  -- a new target type (e.g. a future 'search_result') needs no enum migration.
  target_type   text NOT NULL CHECK (target_type IN ('certificate', 'listing', 'passport')),
  -- The target's public id: a certificate_id, a listing id, or a garment_id.
  -- Text (not uuid) because certificate_id is a public string, not a uuid PK.
  target_id     text NOT NULL,
  -- Display snapshot so the watchlist renders without re-fetching each target
  -- (the target may also become unavailable). Purely cosmetic; the alert engine
  -- resolves fresh state from the target itself.
  label         text,
  brand         text,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- One watch per (buyer, target): a repeat "watch" is idempotent, not a duplicate.
CREATE UNIQUE INDEX IF NOT EXISTS uq_watchlist_target
  ON public.watchlist_items(user_id, target_type, target_id);
CREATE INDEX IF NOT EXISTS idx_watchlist_user ON public.watchlist_items(user_id);

ALTER TABLE public.watchlist_items ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Users manage own watchlist items" ON public.watchlist_items;
CREATE POLICY "Users manage own watchlist items"
  ON public.watchlist_items FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- US-1108: self-record this migration's version so the edge schema-version
-- guard stays truthful regardless of apply method.
INSERT INTO public.applied_migrations (version) VALUES ('00416')
ON CONFLICT (version) DO NOTHING;
