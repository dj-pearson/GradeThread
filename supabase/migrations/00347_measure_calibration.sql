-- US-1572: persisted MeasureCard calibration on the measurement photo.
--
-- POST /api/flipdesk/measure/calibrate detects the card's four fiducials,
-- fits the image-px -> card-inch homography, and stores the result here so
-- re-opening the measurement editor (web/iOS/Android) never re-runs
-- detection. Shape (versioned):
--   { v: 1, cardVersion, ppi, homography: number[9],
--     quality: { markersFound, minMarkerSidePx, blurScore, reprojResidualIn },
--     computedAt }
-- NULL = never calibrated (or the photo isn't a measurement frame).

ALTER TABLE public.item_photos
  ADD COLUMN IF NOT EXISTS measure_calibration jsonb;

COMMENT ON COLUMN public.item_photos.measure_calibration IS
  'US-1572: MeasureCard calibration (v, cardVersion, ppi, homography[9], quality, computedAt) fitted from the fiducials in this measurement photo. NULL = not calibrated.';

-- US-1108 self-record footer.
insert into public.applied_migrations (version) values ('00347') on conflict do nothing;
