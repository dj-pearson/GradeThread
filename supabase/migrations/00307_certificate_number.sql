-- 00307_certificate_number.sql
--
-- PSA-style public certificate number. The /cert/<id> URL keeps using the random
-- `certificate_id` UUID (unguessable, non-enumerable), but buyers/resellers need
-- a short, human-typeable verification key — like a PSA cert number — that rides
-- as PLAIN TEXT in eBay listings (no URL, eBay bans off-eBay links) and is typed
-- into the public /verify lookup page.
--
-- `certificate_number` is a short Crockford-base32 code "GT-XXXXXXX" (alphabet
-- excludes I/L/O/U to avoid confusion). It's UNIQUE so /verify resolves it 1:1.
-- New reports get one at grade time (edge: lib/cert-number.ts); existing
-- certified reports are backfilled here.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS, partial unique index IF NOT EXISTS, and
-- the backfill only fills NULLs.

BEGIN;

ALTER TABLE public.grade_reports
  ADD COLUMN IF NOT EXISTS certificate_number text;

-- Unique only among assigned numbers (NULLs allowed for ungraded/withheld).
CREATE UNIQUE INDEX IF NOT EXISTS grade_reports_certificate_number_key
  ON public.grade_reports (certificate_number)
  WHERE certificate_number IS NOT NULL;

-- Random Crockford-base32 cert number generator (no I/L/O/U). Used by the
-- backfill below; the edge generates new ones with the same alphabet.
CREATE OR REPLACE FUNCTION public.gen_cert_number()
RETURNS text
LANGUAGE plpgsql
AS $$
DECLARE
  alphabet constant text := '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  code text := '';
  i int;
BEGIN
  FOR i IN 1..7 LOOP
    code := code || substr(alphabet, 1 + floor(random() * 32)::int, 1);
  END LOOP;
  RETURN 'GT-' || code;
END;
$$;

-- Backfill every certified report that lacks a number, retrying on the (astro-
-- nomically rare) unique collision so the loop always terminates with a value.
DO $$
DECLARE
  r record;
  n text;
BEGIN
  FOR r IN
    SELECT id FROM public.grade_reports
    WHERE certificate_id IS NOT NULL AND certificate_number IS NULL
  LOOP
    LOOP
      n := public.gen_cert_number();
      BEGIN
        UPDATE public.grade_reports SET certificate_number = n WHERE id = r.id;
        EXIT;
      EXCEPTION WHEN unique_violation THEN
        -- collision — try another code
      END;
    END LOOP;
  END LOOP;
END $$;

-- Expose certificate_number on the anonymous public certificate view so the
-- /cert page shows the SAME number that rides in the listing. Reproduces the
-- 00194 column list verbatim (CREATE OR REPLACE can't reorder/remove columns)
-- and appends certificate_number last.
CREATE OR REPLACE VIEW public.public_grade_reports AS
SELECT
  gr.id,
  gr.submission_id,
  gr.certificate_id,
  gr.created_at,
  gr.overall_score,
  gr.grade_tier,
  gr.fabric_condition_score,
  gr.structural_integrity_score,
  gr.cosmetic_appearance_score,
  gr.functional_elements_score,
  gr.odor_cleanliness_score,
  gr.ai_summary,
  gr.model_version,
  gr.human_reviewed,
  gr.defects_found,
  gr.detected_style_attributes,
  (gr.image_authenticity IS NOT NULL) AS authenticity_checked,
  COALESCE((gr.image_authenticity ->> 'manipulation_suspected')::boolean, false)
    AS authenticity_manipulation_suspected,
  COALESCE((gr.image_authenticity ->> 'screenshot_or_watermark_detected')::boolean, false)
    AS authenticity_screenshot_or_watermark_detected,
  CASE
    WHEN gr.confidence_score >= 0.9  THEN 'very_high'
    WHEN gr.confidence_score >= 0.75 THEN 'high'
    WHEN gr.confidence_score >= 0.6  THEN 'moderate'
    ELSE 'reviewed'
  END AS confidence_label,
  gr.buyer_writeup,
  COALESCE((gr.verified_capture ->> 'verified')::boolean, false)
    AS verified_capture_passed,
  (gr.authenticity_assessment IS NOT NULL) AS authenticity_addon_included,
  CASE
    WHEN gr.authenticity_assessment IS NULL THEN NULL
    WHEN (gr.authenticity_assessment ->> 'authenticity_confidence')::numeric >= 0.85 THEN 'high'
    WHEN (gr.authenticity_assessment ->> 'authenticity_confidence')::numeric >= 0.6  THEN 'moderate'
    ELSE 'low'
  END AS authenticity_confidence_label,
  (gr.authenticity_assessment ->> 'counterfeit_risk') AS authenticity_counterfeit_risk,
  (gr.authenticity_assessment ->> 'summary') AS authenticity_summary,
  (gr.authenticity_assessment ->> 'limitations') AS authenticity_limitations,
  COALESCE((gr.original_photos ->> 'verified')::boolean, false)
    AS original_photos_verified,
  -- 00307: PSA-style public certificate number.
  gr.certificate_number
FROM public.grade_reports gr
WHERE gr.certificate_id IS NOT NULL;

GRANT SELECT ON public.public_grade_reports TO anon, authenticated;

COMMIT;

INSERT INTO public.applied_migrations (version) VALUES ('00307') ON CONFLICT DO NOTHING;
