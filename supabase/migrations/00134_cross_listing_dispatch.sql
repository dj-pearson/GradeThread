-- Multi-marketplace cross-listing dispatch (US-149).
--
-- One source draft can fan out into one listings row per platform (eBay live,
-- others stubbed until their adapters ship). Sibling rows share the same
-- draft_id — a self-reference to the source draft row (the source draft points
-- at itself once it joins a group). When one listing in a group sells, the
-- edge service auto-ends the others, gated by the per-user
-- flipdesk_settings.auto_end_cross_listings toggle.

ALTER TABLE public.listings
  ADD COLUMN IF NOT EXISTS draft_id uuid REFERENCES public.listings(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_listings_draft_id
  ON public.listings (draft_id)
  WHERE draft_id IS NOT NULL;

-- Per-user FlipDesk behavior settings. One row per user, created lazily on
-- first write; absent row = all defaults.
CREATE TABLE IF NOT EXISTS public.flipdesk_settings (
  user_id                 uuid PRIMARY KEY REFERENCES public.users(id) ON DELETE CASCADE,
  auto_end_cross_listings boolean NOT NULL DEFAULT true,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER set_flipdesk_settings_updated_at
  BEFORE UPDATE ON public.flipdesk_settings
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.flipdesk_settings ENABLE ROW LEVEL SECURITY;

-- The frontend reads/writes the caller's own row directly; the edge service
-- reads via the service-role client during sale-driven auto-end.
CREATE POLICY "Users can view own flipdesk settings"
  ON public.flipdesk_settings FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own flipdesk settings"
  ON public.flipdesk_settings FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own flipdesk settings"
  ON public.flipdesk_settings FOR UPDATE
  USING (auth.uid() = user_id);
