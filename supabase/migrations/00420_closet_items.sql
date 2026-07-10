-- US-1825: wardrobe portfolio — the closet item model.
--
-- An owner adds items they own to their closet so GradeThread can value/track
-- them (valuation is US-1826, dashboard US-1827). An item links to a
-- certificate (a grade the owner graded OR bought, US-1811) or a garment passport
-- (a chain the owner is a linked participant of, US-1105), OR carries manual
-- attributes for an ungraded item. OWNER-READ / SERVICE-WRITE: the edge verifies
-- ownership of a linked cert/passport before inserting (a buyer can never closet
-- an item they don't own), scoped by user_id (US-268). Manual entries need no
-- verification. Dedup: a given cert/garment is closeted once per owner (re-add
-- merges); manual entries may legitimately repeat (two identical owned items).

CREATE TABLE IF NOT EXISTS public.closet_items (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  -- Provenance of the closet entry.
  source          text NOT NULL CHECK (source IN ('certificate', 'passport', 'manual')),
  -- Link targets (at most one set; null for manual). certificate_id is the public
  -- string; garment_id is the passport garment uuid.
  certificate_id  text,
  garment_id      uuid REFERENCES public.garments(id) ON DELETE SET NULL,
  -- Attributes (snapshot from the link where present, else manual entry).
  brand           text,
  garment_type    text,
  size            text,
  -- Owner-stated or grade-derived condition (1.0–10.0), null when unknown.
  condition_grade numeric(3,1) CHECK (condition_grade IS NULL OR (condition_grade >= 1.0 AND condition_grade <= 10.0)),
  title           text,
  notes           text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_closet_items_user ON public.closet_items (user_id, created_at DESC);
-- Dedup for LINKED items (a cert / garment is closeted once per owner). Partial
-- so manual entries (both null) are exempt and may repeat.
CREATE UNIQUE INDEX IF NOT EXISTS uq_closet_cert
  ON public.closet_items (user_id, certificate_id) WHERE certificate_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_closet_garment
  ON public.closet_items (user_id, garment_id) WHERE garment_id IS NOT NULL;

DROP TRIGGER IF EXISTS set_closet_items_updated_at ON public.closet_items;
CREATE TRIGGER set_closet_items_updated_at
  BEFORE UPDATE ON public.closet_items
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.closet_items ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Users read own closet" ON public.closet_items;
CREATE POLICY "Users read own closet"
  ON public.closet_items FOR SELECT USING (auth.uid() = user_id);

-- US-1108: self-record so the edge schema-version guard stays truthful.
INSERT INTO public.applied_migrations (version) VALUES ('00420')
ON CONFLICT (version) DO NOTHING;
