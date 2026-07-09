-- US-1777: buyer body-profile store (the "Will it fit me?" foundation, epic
-- US-1776).
--
-- Per-user saved body measurements so a fit check is one tap. TENANT-SCOPED +
-- SENSITIVE PII: RLS restricts every row to its owner (auth.uid() = user_id),
-- and the SPA reads/writes it directly through the authenticated client — no
-- service-role edge path touches it. Anonymous buyers keep profiles client-side
-- (localStorage) for the free public fit tool (US-1780); only authenticated
-- profiles are persisted here.
--
-- Measurements are stored in INCHES (canonical, matching garment flat-lay
-- measures) as a jsonb map keyed by BODY-measurement keys (chest, waist, hips,
-- inseam, height, shoulder, sleeve, neck — body circumference/length, which the
-- US-1778 fit engine converts against flat-lay dimensions). Display in cm is a
-- device preference (measurement-prefs), not stored here.

CREATE TABLE IF NOT EXISTS public.body_profiles (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  -- Label so a buyer can keep multiple profiles (self, gift recipients).
  name          text NOT NULL DEFAULT 'My measurements',
  -- { chest: 40, waist: 32, ... } in INCHES. Sparse — only the keys entered.
  measurements  jsonb NOT NULL DEFAULT '{}'::jsonb,
  is_default    boolean NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_body_profiles_user ON public.body_profiles(user_id);

DROP TRIGGER IF EXISTS set_body_profiles_updated_at ON public.body_profiles;
CREATE TRIGGER set_body_profiles_updated_at
  BEFORE UPDATE ON public.body_profiles
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- RLS: owner-only. Body measurements are sensitive PII — a buyer sees ONLY their
-- own profiles, and can only insert/update rows owned by themselves.
ALTER TABLE public.body_profiles ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users manage own body profiles" ON public.body_profiles;
CREATE POLICY "Users manage own body profiles"
  ON public.body_profiles FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- US-1108: self-record the applied version so the edge boot guard stays truthful.
insert into public.applied_migrations (version) values ('00407') on conflict do nothing;
