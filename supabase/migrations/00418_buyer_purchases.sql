-- US-1811: buyer rewards — purchase-link + arrival-condition capture.
--
-- A buyer links an item they bought to its existing PUBLIC GradeThread grade,
-- records purchase context, and uploads arrival photos (the same types the
-- grader uses) so a later flow (US-1812) can confirm the item matched its grade.
--
-- Two OWNER-READ / SERVICE-WRITE tables (like buyer_notification_log 00412): the
-- buyer sees their own purchases/captures, but the WRITE path runs on the edge
-- (service-role) so the cert link is verified server-side and arrival images go
-- through the hardened upload pipeline (validate → strip EXIF → private bucket).
-- The buyer can never fabricate a link to a cert they didn't resolve, or write
-- another buyer's rows (RLS denies client writes; the edge scopes by user_id,
-- US-268). Arrival images reuse the existing PRIVATE `submission-images` bucket
-- (per-user-folder RLS already enforces tenancy on the object path) — no new
-- bucket. Read them via createSignedUrl (TTL ≤ 900s), never getPublicUrl.

-- ─── buyer_purchases ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.buyer_purchases (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id               uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  -- Internal grade_reports.id (NOT certificate_id) so US-1812 can feed a
  -- grade_outcomes row (which is keyed on grade_report_id).
  grade_report_id       uuid NOT NULL REFERENCES public.grade_reports(id) ON DELETE CASCADE,
  -- Public certificate id for display + the /cert/:id deep link.
  certificate_id        text NOT NULL,
  -- Purchase context (all optional — the buyer may not recall everything).
  purchase_price_cents  integer CHECK (purchase_price_cents IS NULL OR purchase_price_cents >= 0),
  marketplace           text,
  purchased_at          date,
  -- Display snapshot at link time (brand/title of the graded item).
  brand                 text,
  title                 text,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  -- A buyer links a given cert once; re-linking updates the context.
  UNIQUE (user_id, grade_report_id)
);

CREATE INDEX IF NOT EXISTS idx_buyer_purchases_user ON public.buyer_purchases (user_id, created_at DESC);

DROP TRIGGER IF EXISTS set_buyer_purchases_updated_at ON public.buyer_purchases;
CREATE TRIGGER set_buyer_purchases_updated_at
  BEFORE UPDATE ON public.buyer_purchases
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.buyer_purchases ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Users read own purchases" ON public.buyer_purchases;
CREATE POLICY "Users read own purchases"
  ON public.buyer_purchases FOR SELECT USING (auth.uid() = user_id);

-- ─── purchase_arrival_captures ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.purchase_arrival_captures (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  purchase_id   uuid NOT NULL REFERENCES public.buyer_purchases(id) ON DELETE CASCADE,
  -- The grader's photo types (front/back/label/detail).
  image_type    text NOT NULL CHECK (image_type IN ('front', 'back', 'label', 'detail')),
  -- Object path in the private `submission-images` bucket:
  -- {userId}/{purchaseId}/arrival_{type}_{timestamp}.{ext}
  storage_path  text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  -- One capture per type per purchase; re-upload replaces (upsert).
  UNIQUE (purchase_id, image_type)
);

CREATE INDEX IF NOT EXISTS idx_arrival_captures_purchase ON public.purchase_arrival_captures (purchase_id);

ALTER TABLE public.purchase_arrival_captures ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Users read own arrival captures" ON public.purchase_arrival_captures;
CREATE POLICY "Users read own arrival captures"
  ON public.purchase_arrival_captures FOR SELECT USING (auth.uid() = user_id);

-- US-1108: self-record so the edge schema-version guard stays truthful.
INSERT INTO public.applied_migrations (version) VALUES ('00418')
ON CONFLICT (version) DO NOTHING;
