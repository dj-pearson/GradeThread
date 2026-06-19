-- 00260_garment_fingerprints.sql
--
-- US-1097: per-grade visual fingerprint (Layer-3 foundation — the AI moat). On
-- each grade we derive a fingerprint from EXISTING signals (perceptual hashes of
-- the structured photos + the defect map + a wear score) and store it linked to
-- the garment. Later, a probabilistic matcher (US-1098/1099) recognizes the same
-- physical garment across listings — honestly scored, never asserted as certain.
--
-- Security model (US-268): written only by the edge service-role client. The
-- payload holds ONLY hashes/aggregates (no image, no PII). Owner reads via the
-- parent garment; all writes are service-role only. Privacy of the source images
-- is enforced upstream (US-276: signed/admin downloads of the PRIVATE
-- submission-images bucket — never getPublicUrl).
--
-- Idempotent (IF NOT EXISTS; one fingerprint per grade_report via a partial
-- unique index so the forward path + backfill upsert cleanly). Fresh-schema safe.

BEGIN;

CREATE TABLE IF NOT EXISTS public.garment_fingerprints (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  garment_id      uuid NOT NULL REFERENCES public.garments(id) ON DELETE CASCADE,
  -- The grade this fingerprint was derived from (one per grade).
  grade_report_id uuid REFERENCES public.grade_reports(id) ON DELETE SET NULL,
  -- { v, phashes:{front,back,label,…}, defects:{count,types,locations}, measurements }
  payload         jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Bounded [0,10], INCREASES with wear (10 − condition). Drives the
  -- wear-monotonicity gate (US-1098): a real later sighting should be >=.
  wear_score      numeric(4,1) NOT NULL DEFAULT 0,
  created_at      timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.garment_fingerprints IS
  'US-1097: per-grade visual fingerprint (perceptual hashes + defect map + wear '
  'score) for probabilistic same-garment matching. Hashes/aggregates only — no '
  'image, no PII. Service-role write; owner reads via the parent garment.';

CREATE INDEX IF NOT EXISTS idx_garment_fingerprints_garment
  ON public.garment_fingerprints(garment_id);
-- One fingerprint per grade — lets the forward path / backfill upsert.
CREATE UNIQUE INDEX IF NOT EXISTS uq_garment_fingerprints_grade_report
  ON public.garment_fingerprints(grade_report_id)
  WHERE grade_report_id IS NOT NULL;

-- ── RLS ──────────────────────────────────────────────────────────────────────
ALTER TABLE public.garment_fingerprints ENABLE ROW LEVEL SECURITY;

-- All writes are service-role only (no insert/update/delete policy).
REVOKE INSERT, UPDATE, DELETE ON public.garment_fingerprints FROM anon, authenticated;
-- Owner reads via the parent garment (the garment's created_by tenant key).
CREATE POLICY garment_fingerprints_select_via_garment ON public.garment_fingerprints
  FOR SELECT
  USING (
    garment_id IN (
      SELECT id FROM public.garments WHERE created_by = auth.uid()
    )
  );

-- ── Backfill: fingerprint recent grades whose photos are still available ──────
-- Best-effort + chunked. Reuses the SAME signals as the forward path: the phash
-- ALREADY stored on submission_images (so no image is re-decoded) + the
-- grade_defects map (00220). Idempotent — the NOT EXISTS guard skips grades that
-- already have a fingerprint, so re-running is a no-op. The payload shape mirrors
-- buildFingerprintPayload() in lib/garment-fingerprint.ts.
DO $$
DECLARE
  batch_size int := 500;
  processed  int;
  rec        record;
BEGIN
  LOOP
    processed := 0;
    FOR rec IN
      SELECT gr.id AS report_id, gr.garment_id, gr.submission_id, gr.overall_score
      FROM public.grade_reports gr
      WHERE gr.garment_id IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM public.garment_fingerprints f WHERE f.grade_report_id = gr.id
        )
      LIMIT batch_size
    LOOP
      INSERT INTO public.garment_fingerprints (garment_id, grade_report_id, payload, wear_score)
      VALUES (
        rec.garment_id,
        rec.report_id,
        jsonb_build_object(
          'v', 1,
          -- One phash per image_type (first by display_order), valid hashes only.
          'phashes', COALESCE((
            SELECT jsonb_object_agg(t.image_type, t.phash)
            FROM (
              SELECT DISTINCT ON (si.image_type) si.image_type, si.phash
              FROM public.submission_images si
              WHERE si.submission_id = rec.submission_id
                AND si.phash ~ '^[0-9a-f]{16}$'
              ORDER BY si.image_type, si.display_order
            ) t
          ), '{}'::jsonb),
          'defects', jsonb_build_object(
            'count', (SELECT count(*) FROM public.grade_defects d WHERE d.grade_report_id = rec.report_id),
            'types', COALESCE((
              SELECT jsonb_agg(x ORDER BY x) FROM (
                SELECT DISTINCT d.defect_type AS x FROM public.grade_defects d
                WHERE d.grade_report_id = rec.report_id AND d.defect_type IS NOT NULL
              ) s
            ), '[]'::jsonb),
            'locations', COALESCE((
              SELECT jsonb_agg(x ORDER BY x) FROM (
                SELECT DISTINCT left(lower(d.location), 40) AS x FROM public.grade_defects d
                WHERE d.grade_report_id = rec.report_id AND d.location IS NOT NULL
              ) s
            ), '[]'::jsonb)
          ),
          'measurements', NULL
        ),
        GREATEST(0, LEAST(10, round((10 - rec.overall_score)::numeric, 1)))
      );
      processed := processed + 1;
    END LOOP;
    EXIT WHEN processed = 0;
  END LOOP;
END $$;

-- self-record (US-1108): keeps the edge schema-version guard (US-778) in sync.
INSERT INTO public.applied_migrations (version) VALUES ('00260')
ON CONFLICT (version) DO NOTHING;

COMMIT;
