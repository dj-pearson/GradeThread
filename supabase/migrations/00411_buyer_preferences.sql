-- US-1797/US-1798: buyer shopping preferences.
--
-- One row per buyer capturing what they shop for — the shared input for
-- condition-based alerts (US-1807), fit (US-1839), and any recommendation
-- surface. First written by buyer onboarding (US-1797), fully managed from
-- /buyer/settings (US-1798). Owner-managed from the SPA via RLS (no server
-- logic on write), so there is NO edge write route; downstream edge features
-- READ it via the service-role client scoped by user_id.
--
-- This is shopping INTENT (brands/sizes/categories/price/condition) — distinct
-- from body_profiles (US-1777, body circumference for fit). Keep the schema
-- stable/versioned: many features read it.

CREATE TABLE IF NOT EXISTS public.buyer_preferences (
  user_id                uuid PRIMARY KEY REFERENCES public.users(id) ON DELETE CASCADE,
  -- Brands the buyer follows (free text, normalized client-side).
  followed_brands        text[] NOT NULL DEFAULT '{}',
  -- Garment categories of interest (mirror GARMENT_CATEGORIES in constants).
  categories             text[] NOT NULL DEFAULT '{}',
  -- Sizes per garment group, e.g. { "tops": ["M","L"], "footwear": ["10"] }.
  sizes                  jsonb  NOT NULL DEFAULT '{}'::jsonb,
  -- Price band the buyer shops in (cents; either bound may be null = open).
  price_min_cents        integer CHECK (price_min_cents IS NULL OR price_min_cents >= 0),
  price_max_cents        integer CHECK (price_max_cents IS NULL OR price_max_cents >= 0),
  -- Minimum acceptable condition grade (1.0–10.0), null = no floor.
  condition_floor        numeric(3,1) CHECK (condition_floor IS NULL OR (condition_floor >= 1.0 AND condition_floor <= 10.0)),
  -- Measurement unit preference (reuses measurement-prefs.ts semantics).
  unit_preference        text NOT NULL DEFAULT 'in' CHECK (unit_preference IN ('in', 'cm')),
  -- Notification opt-ins (delivery infra is US-1803; these are the intent).
  notify_email           boolean NOT NULL DEFAULT true,
  notify_push            boolean NOT NULL DEFAULT false,
  -- Set when buyer onboarding is completed OR explicitly skipped, so the flow
  -- isn't shown again (null = not yet onboarded).
  onboarding_completed_at timestamptz,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now()
);

DROP TRIGGER IF EXISTS set_buyer_preferences_updated_at ON public.buyer_preferences;
CREATE TRIGGER set_buyer_preferences_updated_at
  BEFORE UPDATE ON public.buyer_preferences
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- RLS: owner-only, all operations. Buyers manage their own preferences directly
-- from the SPA (no server logic on write); downstream edge features read via the
-- service-role client, which bypasses RLS and MUST scope by user_id (US-268).
ALTER TABLE public.buyer_preferences ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users manage own buyer preferences" ON public.buyer_preferences;
CREATE POLICY "Users manage own buyer preferences"
  ON public.buyer_preferences FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- US-1108: self-record this migration's version so the edge schema-version
-- guard stays truthful regardless of apply method.
INSERT INTO public.applied_migrations (version) VALUES ('00411')
ON CONFLICT (version) DO NOTHING;
