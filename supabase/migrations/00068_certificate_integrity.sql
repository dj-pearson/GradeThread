-- Tamper-evident certificates (US-333).
--
-- At grade finalization the pipeline computes a canonical SHA-256 hash of the
-- certificate's already-public grade fields (scores, tier, AI summary,
-- certificate id) and — when CERT_SIGNING_KEY is configured — an HMAC-SHA256
-- signature over that hash. The public verify endpoint re-derives the hash from
-- the stored fields and confirms it matches, so a tampered row or a forged
-- certificate screenshot can be detected. See lib/cert-integrity.ts for the
-- canonical scheme; integrity_version pins the rules a given row was hashed
-- under so future scheme changes stay backward-verifiable.

ALTER TABLE public.grade_reports
  ADD COLUMN IF NOT EXISTS content_hash text,
  ADD COLUMN IF NOT EXISTS content_signature text,
  ADD COLUMN IF NOT EXISTS integrity_version integer;

COMMENT ON COLUMN public.grade_reports.content_hash IS
  'SHA-256 hex of the canonical certificate fields (lib/cert-integrity.ts). '
  'NULL for grades finalized before US-333 — those verify as "unverifiable".';
COMMENT ON COLUMN public.grade_reports.content_signature IS
  'Base64 HMAC-SHA256(content_hash) using CERT_SIGNING_KEY. NULL when no signing '
  'key is configured (hash-only integrity) or for legacy grades.';
COMMENT ON COLUMN public.grade_reports.integrity_version IS
  'Canonicalization scheme version the content_hash was computed under.';

-- Historical rows are intentionally left NULL (the canonical hash is computed
-- in app code, not SQL). A one-off backfill can populate them by re-reading
-- each row through buildCertIntegrity(); until then they report "unverifiable",
-- which is truthful — they predate the integrity scheme.
