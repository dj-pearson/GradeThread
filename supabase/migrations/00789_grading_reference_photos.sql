-- US-3334: the admin reference gallery - a graded photo awarded as the example
-- of a grade level ("this is what a 7 looks like" for jeans, or for the fabric
-- factor on sweaters).
--
-- WHO MAY BE AWARDED is enforced by the edge route, not here: a photo can only
-- come from a finalized grade whose owner is staff (users.role admin or
-- super_admin) or has opted into model refinement (users.share_sale_outcomes).
-- Exemplar privacy forbids customer photos in prompts without that consent,
-- and US-3335 is what will put these in front of the grader.
--
-- Deny-all: RLS on, no policies. Only the service role reads or writes it,
-- through admin routes that require step-up and write an audit row. The
-- images themselves stay in the private submission-images bucket and are only
-- ever served through signed URLs of 900 seconds or less.
--
-- Revocation is a timestamp, not a delete, so the audit trail keeps what was
-- shown to the grader and when.

CREATE TABLE IF NOT EXISTS public.grading_reference_photos (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  submission_image_id uuid NOT NULL
    REFERENCES public.submission_images(id) ON DELETE CASCADE,
  grade_report_id uuid
    REFERENCES public.grade_reports(id) ON DELETE SET NULL,
  garment_category text NOT NULL,
  -- NULL = the whole grade; otherwise the one factor this photo exemplifies.
  factor text CHECK (
    factor IS NULL OR factor IN (
      'fabric_condition', 'structural_integrity', 'cosmetic_appearance',
      'functional_elements', 'odor_cleanliness'
    )
  ),
  awarded_score numeric(3,1) NOT NULL
    CHECK (awarded_score >= 1.0 AND awarded_score <= 10.0),
  awarded_by uuid NOT NULL,
  note text,
  revoked_at timestamptz,
  revoked_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.grading_reference_photos ENABLE ROW LEVEL SECURITY;
-- Deliberately no policies: anon and authenticated read nothing.

-- One live award per photo per factor (or per whole grade).
CREATE UNIQUE INDEX IF NOT EXISTS uq_grading_reference_photos_live
  ON public.grading_reference_photos (submission_image_id, COALESCE(factor, ''))
  WHERE revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_grading_reference_photos_category
  ON public.grading_reference_photos (garment_category, awarded_score)
  WHERE revoked_at IS NULL;

DROP TRIGGER IF EXISTS set_grading_reference_photos_updated_at ON public.grading_reference_photos;
CREATE TRIGGER set_grading_reference_photos_updated_at
  BEFORE UPDATE ON public.grading_reference_photos
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

COMMENT ON TABLE public.grading_reference_photos IS
  'US-3334: graded photos awarded as the example of a grade level, per category '
  'and optionally per factor. Staff-owned or consenting-owner photos only '
  '(edge-enforced). Deny-all; signed URLs only.';

-- US-1108: self-record the applied version so the edge boot guard stays truthful.
insert into public.applied_migrations (version) values ('00789') on conflict do nothing;
