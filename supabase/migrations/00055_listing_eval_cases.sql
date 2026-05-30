-- US-311: golden cases for the AutoLister listing-generation eval gate.
--
-- Mirrors grading_eval_cases (migration 00050) but encodes listing-specific
-- expectations: which aspects must be present after generation, what price
-- band is reasonable, and what category to expect. The eval harness
-- (services/edge-functions/src/lib/listing-eval.ts) runs every case against a
-- candidate listing_gen prompt and gates activation on the thresholds.

CREATE TABLE IF NOT EXISTS public.listing_eval_cases (
  id                              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  label                           text NOT NULL,
  is_active                       boolean NOT NULL DEFAULT true,
  -- Inputs handed to generateListingFields. Photos use the same shape as
  -- grading_eval_cases (storage_path within submission-images).
  photos                          jsonb NOT NULL DEFAULT '[]'::jsonb,
  known_brand                     text,
  known_size                      text,
  known_color                     text,
  known_material                  text,
  known_title                     text,
  measurements                    jsonb,
  -- Expectations the run is scored against.
  expected_category_id            text,
  expected_required_aspect_names  text[] NOT NULL DEFAULT '{}',
  expected_price_min_cents        integer,
  expected_price_max_cents        integer,
  notes                           text,
  created_at                      timestamptz NOT NULL DEFAULT now(),
  updated_at                      timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER set_listing_eval_cases_updated_at
  BEFORE UPDATE ON public.listing_eval_cases
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- Admin-only data: enable RLS and grant access only via the service-role
-- client used by the eval harness (no SELECT/INSERT for anon/authenticated).
ALTER TABLE public.listing_eval_cases ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE public.listing_eval_cases IS
  'Golden AutoLister listing-generation cases (US-311). Each case scores a '
  'candidate listing_gen prompt against title length, required-aspect '
  'coverage, and price sanity. activatePromptVersion blocks activation until '
  'eval_passed=true on the candidate.';
