-- Public `cert-assets` storage bucket for server-rendered certificate images:
-- the PSA-style "slab" graded photo, the social OG card, and the trust badge.
--
-- These were rendered on-demand by a Cloudflare Pages Function via workers-og
-- (Satori + resvg-wasm), which exceeds the Free-plan Worker CPU limit and
-- returns HTTP 503 "error code: 1102" for every fresh render. They now render
-- ONCE on the Deno edge (full CPU; src/lib/cert-image-render.ts) and are stored
-- here, then served statically (the Pages Functions proxy this bucket via the
-- edge). Only the service-role edge client writes (it bypasses RLS), so the
-- bucket needs a public-READ policy only — no authenticated write path.
--
-- Idempotent (ON CONFLICT / DROP POLICY IF EXISTS) — safe to re-run the whole
-- migrations directory. Cache key is the certificate_id; images are deleted on
-- re-grade by deleteCertImages() (src/lib/cloudflare-purge.ts).

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'cert-assets',
  'cert-assets',
  true,
  5242880, -- 5 MB (a 1080x1920 slab PNG is well under 1.5 MB)
  ARRAY['image/png']
)
ON CONFLICT (id) DO NOTHING;

-- Public read: the certificate is public, so its rendered images are too.
DROP POLICY IF EXISTS "cert-assets public read" ON storage.objects;
CREATE POLICY "cert-assets public read"
  ON storage.objects FOR SELECT
  USING (bucket_id = 'cert-assets');

-- US-1108 self-record: keep the edge boot guard truthful regardless of how the
-- SQL was applied.
INSERT INTO public.applied_migrations (version) VALUES ('00380')
ON CONFLICT (version) DO NOTHING;
