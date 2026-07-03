-- US-1533: garment baseline knowledge layer.
--
-- The grading prompt says "grade against as-manufactured state" but never says
-- what that state IS for this garment. This table caches short, server-
-- generated "expectation briefs" per (brand, garment_category): fabric
-- character, intentional distressing/finish, common honest-wear points, known
-- failure modes. Generated ONCE by an AI call on first encounter (lazy,
-- quota-exempt) and injected into the grading prompts as TRUSTED reference
-- context — distinct from the fenced untrusted seller text, so brand knowledge
-- returns through a channel prompt-injection can't reach. Reviewers can edit a
-- bad brief from the admin UI; reads are always DB-fresh so an edit is live
-- immediately.
--
-- Operator table: deny-all RLS, service-role only (rls-guard enforced).

CREATE TABLE IF NOT EXISTS public.garment_baselines (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Normalized lowercase brand ('' never stored — no-brand items skip baselines).
  brand            text NOT NULL,
  garment_category text NOT NULL,
  -- Identified style/model (US-1527) for style-specific briefs; '' = the
  -- brand+category-level brief. NOT NULL so the unique key below is plain
  -- columns (PostgREST upsert onConflict can't target an expression index).
  style            text NOT NULL DEFAULT '',
  brief            text NOT NULL,
  -- Generation provenance so a prompt fix can invalidate old briefs by version.
  model            text NOT NULL,
  prompt_version   text NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS garment_baselines_key_idx
  ON public.garment_baselines (brand, garment_category, style);

ALTER TABLE public.garment_baselines ENABLE ROW LEVEL SECURITY;

-- updated_at trigger (same helper every other table uses).
DROP TRIGGER IF EXISTS set_garment_baselines_updated_at ON public.garment_baselines;
CREATE TRIGGER set_garment_baselines_updated_at
  BEFORE UPDATE ON public.garment_baselines
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- US-1108 self-record footer.
insert into public.applied_migrations (version) values ('00341') on conflict do nothing;
