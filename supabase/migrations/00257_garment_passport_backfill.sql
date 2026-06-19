-- 00257_garment_passport_backfill.sql
--
-- US-1091: backfill existing grade certificates into single-hop Garment
-- Passports so the ledger (US-1089) starts NON-EMPTY at launch and every
-- certificate gains a persistent garment identity.
--
-- For each existing grade_report that carries a certificate_id we seed a
-- one-hop chain:
--   • one pseudonymous origin owner_node  ("Seller A", kind=seller — chain
--     position 0; see lib/garment-passport.ts pseudonymousLabel())
--   • one garment            (created_by = the grading user; sku_class from the
--                             submission's brand/type/category)
--   • one 'graded' garment_event (confidence='deterministic' — the grade is a
--                             first-party fact, not an inference)
-- and link the report to its garment via the new grade_reports.garment_id FK.
--
-- New grades populate garment_id going forward via the grading write path
-- (lib/passport-write.ts, called from grading-pipeline.ts) — this migration
-- only seeds the existing back-catalogue.
--
-- Idempotent: garment_id is added IF NOT EXISTS and the backfill only touches
-- rows where garment_id IS NULL, so re-running creates no duplicate garments /
-- nodes / events. Chunked (500/batch) so it scales to the existing volume
-- without one unbounded statement. Applies cleanly on a fresh schema (db verify
-- lane) — on an empty DB the backfill loop simply does nothing.

BEGIN;

-- ── grade_reports.garment_id FK (nullable; ON DELETE SET NULL) ────────────────
-- Nullable: a report may briefly exist before its passport is seeded, and
-- non-certificated/superseded reports never get one. SET NULL (not CASCADE) so
-- archiving a garment never deletes the authoritative grade record.
ALTER TABLE public.grade_reports
  ADD COLUMN IF NOT EXISTS garment_id uuid
    REFERENCES public.garments(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.grade_reports.garment_id IS
  'US-1091: the Garment Passport (garments.id) this report''s certificate maps '
  'to. Backfilled for existing certs; populated by the grading write path going '
  'forward. Nullable — non-certificated/superseded reports have none.';

CREATE INDEX IF NOT EXISTS idx_grade_reports_garment
  ON public.grade_reports(garment_id) WHERE garment_id IS NOT NULL;

-- ── Backfill: seed a single-hop passport per certificated report ──────────────
-- Row-by-row inside a chunked loop. The inserts are SEQUENTIAL (node → garment →
-- event → link) so the FK chain (garment.current_owner_node_id → owner_nodes;
-- garment_events.{garment_id,actor_node_id} → garments/owner_nodes) is always
-- satisfied — a multi-statement data-modifying CTE would run each sub-statement
-- against the SAME snapshot and couldn't see its siblings' inserts, risking FK
-- violations. Chunked: each pass grabs up to `batch_size` un-backfilled reports;
-- the WHERE garment_id IS NULL filter makes the whole thing idempotent.
DO $$
DECLARE
  batch_size int := 500;
  processed  int;
  rec        record;
  v_node_id  uuid;
  v_garment_id uuid;
BEGIN
  LOOP
    processed := 0;
    FOR rec IN
      SELECT
        gr.id               AS report_id,
        s.user_id           AS created_by,
        s.brand             AS brand,
        s.garment_type      AS garment_type,
        s.garment_category  AS garment_category,
        gr.overall_score    AS overall_score,
        gr.grade_tier       AS grade_tier,
        gr.confidence_score AS confidence_score,
        gr.certificate_id   AS certificate_id,
        gr.created_at       AS created_at
      FROM public.grade_reports gr
      JOIN public.submissions s ON s.id = gr.submission_id
      WHERE gr.certificate_id IS NOT NULL
        AND gr.garment_id IS NULL
      LIMIT batch_size
    LOOP
      -- 1. Pseudonymous origin seller node (chain position 0 → "Seller A").
      INSERT INTO public.owner_nodes (pseudonymous_label, kind, created_at)
      VALUES ('Seller A', 'seller', rec.created_at)
      RETURNING id INTO v_node_id;

      -- 2. The garment identity, owned by the seller node.
      INSERT INTO public.garments
        (sku_class, current_owner_node_id, created_by, created_at, updated_at)
      VALUES (
        jsonb_strip_nulls(jsonb_build_object(
          'brand', rec.brand,
          'garment_type', rec.garment_type,
          'category', rec.garment_category
        )),
        v_node_id,
        rec.created_by,
        rec.created_at,
        rec.created_at
      )
      RETURNING id INTO v_garment_id;

      -- 3. The deterministic 'graded' event. PII-free payload — `certificate`
      --    (not certificate_id) is kept so the public passport can link back to
      --    the cert: sanitizePayload() drops any *_id key, and certificate_id is
      --    a public, non-PII handle anyway.
      INSERT INTO public.garment_events
        (garment_id, event_type, actor_node_id, payload, confidence, source, created_at)
      VALUES (
        v_garment_id,
        'graded',
        v_node_id,
        jsonb_build_object(
          'overall_score', rec.overall_score,
          'grade_tier', rec.grade_tier,
          'confidence_label', CASE
            WHEN rec.confidence_score >= 0.9  THEN 'very_high'
            WHEN rec.confidence_score >= 0.75 THEN 'high'
            WHEN rec.confidence_score >= 0.6  THEN 'moderate'
            ELSE 'reviewed'
          END,
          'certificate', rec.certificate_id
        ),
        'deterministic',
        'backfill-00257',
        rec.created_at
      );

      -- 4. Link the report to its garment.
      UPDATE public.grade_reports
      SET garment_id = v_garment_id
      WHERE id = rec.report_id;

      processed := processed + 1;
    END LOOP;

    EXIT WHEN processed = 0;
  END LOOP;
END $$;

-- ── Sibling public view: certificate_id → passport slug (PII-free) ────────────
-- Lets an anonymous certificate viewer (certificate.tsx) resolve the passport
-- slug without exposing any PII or touching the big public_grade_reports view
-- (which stays unchanged). Like public_grade_reports, security_invoker is OFF so
-- the view (owned by the migration role) is the gate; only certificate_id (a
-- public handle) and the public slug are projected.
CREATE OR REPLACE VIEW public.public_passport_links AS
SELECT
  gr.certificate_id,
  g.public_passport_slug AS passport_slug
FROM public.grade_reports gr
JOIN public.garments g ON g.id = gr.garment_id
WHERE gr.certificate_id IS NOT NULL
  AND gr.garment_id IS NOT NULL;

COMMENT ON VIEW public.public_passport_links IS
  'US-1091: PII-free map from a public certificate_id to its Garment Passport '
  'slug. For anonymous certificate viewers; exposes only public handles.';

GRANT SELECT ON public.public_passport_links TO anon, authenticated;

-- self-record (US-1108): keeps the edge schema-version guard (US-778) in sync.
INSERT INTO public.applied_migrations (version) VALUES ('00257')
ON CONFLICT (version) DO NOTHING;

COMMIT;
