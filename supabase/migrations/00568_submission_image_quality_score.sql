-- US-2136 AC4: keep the measured photo quality, so authenticity confidence can
-- read a MEASURE instead of a pass/fail bit.
--
-- US-2136 shipped the gate (src/lib/macro-photo-quality.ts): per-slot pixel
-- floors plus a normalized Laplacian-variance sharpness score, warning the
-- seller in-capture. The assessment has always carried a continuous 0..1 `score`
-- on BOTH pass and fail, deliberately — but it died in the browser, so
-- downstream everything a macro shot could be was flattened to "the seller was
-- allowed to upload it".
--
-- That flattening has a cost with a name. AUTHENTICITY_NO_MACRO_CONFIDENCE_CAP
-- (US-2134) caps a verdict at 0.7 when NO macro frame was supplied, because the
-- tells the prompt asks about were never photographed. A macro frame so soft
-- that a serial is unreadable is the same evidentiary situation and currently
-- gets full credit, purely because a file exists in that slot.
--
-- ── WHY ONLY submission_images ──────────────────────────────────────────────
-- item_photos (FlipDesk) is assessed by the same module and is NOT given this
-- column. Nothing reads it there: item photos are listing imagery, and the
-- authenticity pass runs on submissions. A column nobody reads is a column that
-- goes stale and then gets trusted. Add it there when something needs it.

ALTER TABLE public.submission_images
  ADD COLUMN IF NOT EXISTS quality_score numeric(4,3);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'submission_images_quality_score_range'
  ) THEN
    ALTER TABLE public.submission_images
      ADD CONSTRAINT submission_images_quality_score_range
      CHECK (quality_score IS NULL OR (quality_score >= 0 AND quality_score <= 1));
  END IF;
END $$;

-- NULLABLE, and null is a real value here rather than a gap to be backfilled.
-- The measurement runs in a browser canvas and can legitimately fail (a decode
-- error, a headless context, an older client that predates this column). The
-- read path treats null as "not measured" and applies NO cap — the gate fails
-- open in every uncertain case, and a confidence cap that fires on our own
-- inability to measure would blame the seller for our bug.
COMMENT ON COLUMN public.submission_images.quality_score IS
  'US-2136 AC4: normalized 0..1 sharpness of the COMPRESSED bytes (macro-photo-quality.ts, Laplacian variance / SHARPNESS_VARIANCE_SCALE), as measured client-side at capture. NULL = not measured; readers must treat that as "unknown", never as zero. Only meaningful for macro slots (tag, label, detail, serial, marking, surface, corner, sole).';

-- US-1108: self-record the applied version so the edge boot guard stays truthful.
insert into public.applied_migrations (version) values ('00568') on conflict do nothing;
