-- US-2218: known-genuine reference imagery for authentication tells.
--
-- HALF THE TELL TAXONOMY IS VISUAL and cannot be checked from prose. The tell
-- categories include stitching, font, stamp, hardware and construction, and the
-- seeded content admits the gap in its own words: the Louis Vuitton stamp tell
-- instructs a comparison against a "known-genuine reference" that does not
-- exist anywhere in the system. A tell whose check instruction depends on an
-- artifact we do not have is not a checkable rule.
--
-- ── RIGHTS ARE NOT NULL, AND THAT IS THE POINT ─────────────────────────────
--
-- Reference imagery must be licensed or owned. `rights` is NOT NULL with no
-- default, so a row cannot exist without someone stating where the image came
-- from and on what basis we may hold it. Scraping brand or marketplace imagery
-- into this table is exactly what the column exists to prevent, and a NULL
-- default would have made the omission the easy path.
--
-- ── SELLER PHOTOS ARE NEVER PROMOTED HERE ──────────────────────────────────
--
-- There is deliberately NO foreign key to submission_images, and no code path
-- copies one. The few-shot exemplar privacy rule (US-1067) applies with equal
-- force: a seller's photograph of their own garment is theirs, and a reference
-- corpus that quietly absorbs customer uploads is a privacy incident waiting to
-- be discovered. Adding seller imagery requires explicit, recorded consent and
-- a deliberate future story — not a join.
--
-- ── PRIVATE STORAGE ONLY ───────────────────────────────────────────────────
--
-- The bucket is created with public = false. References are served exclusively
-- through short-lived signed URLs (TTL <= 900s, the same rule submission-images
-- follows). They must NEVER be placed in `item-photos`, which is the only
-- public bucket and is for seller listing imagery.
--
-- Operator table: deny-all RLS, service-role only. Registered in
-- SERVICE_ROLE_ONLY (rls-guard_test.ts). No tenant data and no owner column.
--
-- Risk: LOW. One new table, one new private bucket, no change to any existing
-- object. Idempotent and re-run safe.

CREATE TABLE IF NOT EXISTS public.authenticity_references (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Normalized brand match key, same key brandKey() computes.
  brand_key      text NOT NULL,
  -- '' = a brand-level reference; otherwise the style it depicts.
  style          text NOT NULL DEFAULT '',
  -- One of brand-authenticity.ts AuthTellCategory.
  tell_category  text NOT NULL,
  -- Path inside the PRIVATE authenticity-references bucket.
  storage_path   text NOT NULL,
  -- What the image shows, in the words a reviewer needs.
  caption        text NOT NULL DEFAULT '',
  -- Where it came from. NOT NULL: no reference without a provenance.
  source         text NOT NULL,
  -- The licence or ownership basis on which we may hold and show it.
  -- NOT NULL and no default, deliberately — see the header.
  rights         text NOT NULL,
  confidence     numeric(3,2) CHECK (confidence >= 0 AND confidence <= 1),
  verified       boolean NOT NULL DEFAULT false,
  updated_by     text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS authenticity_references_brand_idx
  ON public.authenticity_references (brand_key, tell_category);
CREATE UNIQUE INDEX IF NOT EXISTS authenticity_references_path_idx
  ON public.authenticity_references (storage_path);

ALTER TABLE public.authenticity_references ENABLE ROW LEVEL SECURITY;
-- Zero policies = deny-all. The edge service-role client bypasses RLS.

DROP TRIGGER IF EXISTS set_authenticity_references_updated_at
  ON public.authenticity_references;
CREATE TRIGGER set_authenticity_references_updated_at
  BEFORE UPDATE ON public.authenticity_references
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

comment on table public.authenticity_references is
  'US-2218 known-genuine reference imagery for visual authentication tells. PRIVATE: served only via signed URLs from the authenticity-references bucket. rights is NOT NULL — no reference may exist without a stated licence/ownership basis. Seller photos are NEVER promoted here (US-1067 privacy rule); there is deliberately no link to submission_images.';

-- PRIVATE bucket. public = false is load-bearing, not a default.
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'authenticity-references',
  'authenticity-references',
  false,
  10485760, -- 10MB
  ARRAY['image/jpeg', 'image/png', 'image/webp']
)
ON CONFLICT (id) DO NOTHING;

-- No storage policies: like the table, reads go through the service-role
-- client, which issues the short-lived signed URLs.

-- US-1108: self-record the applied version so the edge boot guard stays truthful.
insert into public.applied_migrations (version) values ('00500') on conflict do nothing;
