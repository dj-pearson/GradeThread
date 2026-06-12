-- Grade-badge + certificate-link promotion default (FlipDesk).
--
-- When enabled, every graded item published to a marketplace goes out with the
-- PSA-style grade badge burned onto its hero photo and a "View the full
-- condition certificate" link appended to the description — promoting the
-- seller's certified grade and GradeThread. The burn happens server-side at
-- publish (assemblePublishContext/publishItemForOwner in flipdesk-ebay.ts) so it
-- covers every publish path (manual, AutoLister, scheduled, bulk), not just the
-- composer.
--
-- This is the per-user GLOBAL default; an individual listing can still opt in
-- via listings.badge_enabled (migration 00027). Effective at publish =
-- listing.badge_enabled OR this default.
--
-- SELF-HEALING: flipdesk_settings is created here with IF NOT EXISTS (mirroring
-- migration 00134) so this applies cleanly even on an instance where 00134 was
-- not run. Trigger/policies are dropped-then-created so re-running is safe.

CREATE TABLE IF NOT EXISTS public.flipdesk_settings (
  user_id                 uuid PRIMARY KEY REFERENCES public.users(id) ON DELETE CASCADE,
  auto_end_cross_listings boolean NOT NULL DEFAULT true,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.flipdesk_settings
  ADD COLUMN IF NOT EXISTS auto_grade_badge boolean NOT NULL DEFAULT false;

ALTER TABLE public.flipdesk_settings ENABLE ROW LEVEL SECURITY;

DROP TRIGGER IF EXISTS set_flipdesk_settings_updated_at ON public.flipdesk_settings;
CREATE TRIGGER set_flipdesk_settings_updated_at
  BEFORE UPDATE ON public.flipdesk_settings
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- The frontend reads/writes the caller's own row directly; the edge service
-- reads via the service-role client during publish + sale-driven auto-end.
DROP POLICY IF EXISTS "Users can view own flipdesk settings" ON public.flipdesk_settings;
CREATE POLICY "Users can view own flipdesk settings"
  ON public.flipdesk_settings FOR SELECT
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can insert own flipdesk settings" ON public.flipdesk_settings;
CREATE POLICY "Users can insert own flipdesk settings"
  ON public.flipdesk_settings FOR INSERT
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can update own flipdesk settings" ON public.flipdesk_settings;
CREATE POLICY "Users can update own flipdesk settings"
  ON public.flipdesk_settings FOR UPDATE
  USING (auth.uid() = user_id);
