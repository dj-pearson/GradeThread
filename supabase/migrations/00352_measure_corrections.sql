-- US-1580: measurement-correction telemetry — the ground truth for "accurate".
--
-- Every overlay-editor save logs the delta between what the auto pass
-- proposed (ai_measured) and what the seller finally kept, per measurement
-- key. Deltas + class + confidence ONLY — no photo content, no address, no
-- free text. This is (a) the release gate's production evidence (a class's
-- copy may drop "estimated" only after 30 days of p95 <= 0.5in — a recorded
-- human decision, see MEASUREMENT_ACCURACY.md) and (b) the labeled dataset a
-- future trained landmark model would be built from.
--
-- OPERATOR table (rls-guard SERVICE_ROLE_ONLY): written by the edge
-- correction endpoint, read via documented SQL / future admin views. The SPA
-- never queries it directly.

CREATE TABLE IF NOT EXISTS public.measure_corrections (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id    uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  garment_class    text NOT NULL,          -- MeasurementGroup (top/bottom/...)
  measurement_key  text NOT NULL,          -- chest / length / inseam / ...
  proposed_inches  numeric(6,2) NOT NULL,  -- what the auto pass said
  final_inches     numeric(6,2) NOT NULL,  -- what the seller kept
  delta_inches     numeric(6,2) NOT NULL,  -- final - proposed (signed)
  confidence       numeric(4,3),           -- the proposal's model confidence
  was_flagged      boolean NOT NULL DEFAULT false,
  card_version     int,
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS measure_corrections_class_key
  ON public.measure_corrections (garment_class, measurement_key, created_at);

ALTER TABLE public.measure_corrections ENABLE ROW LEVEL SECURITY;
-- Deny-all on purpose: no policies. Service role bypasses RLS.

-- US-1108 self-record footer.
insert into public.applied_migrations (version) values ('00352') on conflict do nothing;
