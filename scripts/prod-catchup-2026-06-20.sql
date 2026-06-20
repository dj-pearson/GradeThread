-- prod-catchup-2026-06-20.sql
--
-- WHY: the edge boot guard (US-778, lib/schema-version.ts) is crash-looping:
--   [schema-version] DB is STALE: applied=00256, this build expects 00281.
--   Refusing to start.  → site down until prod reaches 00281.
--
-- This bundles migrations 00257 → 00281 VERBATIM (DDL + each file's US-1108
-- self-record footer) so ONE paste both applies the schema AND advances
-- latest_schema_migration() to 00281. Every file is idempotent
-- (IF NOT EXISTS / guarded enums / ON CONFLICT) → safe to re-run.
--
-- SOURCE OF TRUTH remains the individual migration files; this is a convenience
-- bundle. Apply via Supabase Studio SQL editor (or psql -f).
--
-- ⚠️ Back up prod first (BACKUPS.md). Migrations are forward-only.
--
-- After running, verify the tail SELECT reports 00281, then the next edge boot
-- logs "[schema-version] OK — DB at 00281 matches expected 00281".


-- ════════════════════════════════════════════════════════════════════════════
-- 00257_garment_passport_backfill.sql
-- ════════════════════════════════════════════════════════════════════════════

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


-- ════════════════════════════════════════════════════════════════════════════
-- 00258_passport_claim_tokens.sql
-- ════════════════════════════════════════════════════════════════════════════

-- 00258_passport_claim_tokens.sql
--
-- US-1094: ownership handoff / claim flow (Layer 1 — title transfer). A seller
-- who sold a graded item can mint a single-use, time-bounded CLAIM TOKEN; the
-- buyer redeems it (no account required) to transfer the Garment Passport to a
-- new pseudonymous buyer node. This is the strongest, design-driven tracking
-- layer: the chain continues DETERMINISTICALLY because the parties opt in.
--
-- Security model (US-268): written only by the edge service-role client.
--   • Only the SHA-256 HASH of the token is stored (token_hash) — the raw token
--     is shown to the seller exactly once and is never recoverable from the row,
--     so a DB read can't redeem outstanding tokens.
--   • Single-use: claimed_at is set atomically on redemption (the edge claims
--     via UPDATE ... WHERE claimed_at IS NULL RETURNING, so a replay/double-claim
--     loses the race and is rejected).
--   • Time-bounded: expires_at gates redemption.
--   • created_by is the tenant key (the minting workspace owner). RLS: the owner
--     may READ their own tokens; all writes are service-role only.
--
-- Idempotent (IF NOT EXISTS / guarded). Applies cleanly on a fresh schema.

BEGIN;

CREATE TABLE IF NOT EXISTS public.passport_claim_tokens (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  garment_id         uuid NOT NULL REFERENCES public.garments(id) ON DELETE CASCADE,
  -- SHA-256 hex of the raw claim token. The raw token is never stored.
  token_hash         text NOT NULL UNIQUE,
  -- Tenant key: the workspace owner that minted the token.
  created_by         uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  expires_at         timestamptz NOT NULL,
  -- Set once, atomically, on redemption — the single-use gate.
  claimed_at         timestamptz,
  -- The pseudonymous buyer node the token minted on redemption.
  claimed_by_node_id uuid REFERENCES public.owner_nodes(id) ON DELETE SET NULL,
  created_at         timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.passport_claim_tokens IS
  'US-1094: single-use, time-bounded Garment Passport ownership-claim tokens. '
  'Only the SHA-256 hash is stored; raw token shown to the seller once. '
  'Service-role write only; owner reads own via created_by.';

-- Redemption looks up by token_hash and filters unclaimed/unexpired.
CREATE INDEX IF NOT EXISTS idx_passport_claim_tokens_garment
  ON public.passport_claim_tokens(garment_id);
-- Owner's "outstanding tokens" list.
CREATE INDEX IF NOT EXISTS idx_passport_claim_tokens_created_by
  ON public.passport_claim_tokens(created_by);

-- ── RLS ──────────────────────────────────────────────────────────────────────
ALTER TABLE public.passport_claim_tokens ENABLE ROW LEVEL SECURITY;

-- All writes are service-role only (no insert/update/delete policy).
REVOKE INSERT, UPDATE, DELETE ON public.passport_claim_tokens FROM anon, authenticated;
-- The minting owner may read their own tokens (status/expiry), never others'.
-- token_hash is a digest, so this exposes nothing redeemable.
CREATE POLICY passport_claim_tokens_select_own ON public.passport_claim_tokens
  FOR SELECT
  USING (created_by = auth.uid());

-- self-record (US-1108): keeps the edge schema-version guard (US-778) in sync.
INSERT INTO public.applied_migrations (version) VALUES ('00258')
ON CONFLICT (version) DO NOTHING;

COMMIT;


-- ════════════════════════════════════════════════════════════════════════════
-- 00259_passport_tags.sql
-- ════════════════════════════════════════════════════════════════════════════

-- 00259_passport_tags.sql
--
-- US-1096: physical Garment Passport tags (Layer 2). A seller of a higher-value
-- item can attach a printable QR + human-readable short code bound to the
-- garment's passport. Scanning the tag opens the public passport and offers a
-- deterministic scan-to-claim handoff (Layer 1, US-1094).
--
-- The short_code is NOT a secret — it is printed on a physical tag and embedded
-- in the QR. Security is by (a) opt-in issuance, (b) server-side validation +
-- rate-limiting of the public scan/claim endpoints, and (c) revocation: a lost
-- tag can be revoked and a fresh one (re)issued. We therefore store the code in
-- the clear (unlike claim TOKENS, which are secret and hash-only).
--
-- Security model (US-268): written only by the edge service-role client. Owner
-- reads their own tags via created_by; the public resolve/claim path is served
-- by the edge from a non-PII projection, never anon PostgREST.
--
-- Idempotent; applies cleanly on a fresh schema.

BEGIN;

CREATE TABLE IF NOT EXISTS public.passport_tags (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  garment_id  uuid NOT NULL REFERENCES public.garments(id) ON DELETE CASCADE,
  -- Human-readable, QR-embedded handle (Crockford base32, no ambiguous chars).
  -- Public, not a secret.
  short_code  text NOT NULL UNIQUE,
  -- Tenant key: the workspace owner that issued the tag.
  created_by  uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  -- Soft revocation: a revoked tag resolves to nothing (lost/reissued).
  revoked_at  timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.passport_tags IS
  'US-1096: physical Garment Passport tags (QR + short code) bound to a garment. '
  'short_code is public (printed on the tag). Service-role write; owner reads own.';

-- Public scan resolves by short_code; owner lists by garment / created_by.
CREATE INDEX IF NOT EXISTS idx_passport_tags_garment
  ON public.passport_tags(garment_id);
CREATE INDEX IF NOT EXISTS idx_passport_tags_created_by
  ON public.passport_tags(created_by);

-- ── RLS ──────────────────────────────────────────────────────────────────────
ALTER TABLE public.passport_tags ENABLE ROW LEVEL SECURITY;

-- All writes are service-role only (no insert/update/delete policy).
REVOKE INSERT, UPDATE, DELETE ON public.passport_tags FROM anon, authenticated;
-- The issuing owner may read their own tags (status/code for reprint).
CREATE POLICY passport_tags_select_own ON public.passport_tags
  FOR SELECT
  USING (created_by = auth.uid());

-- self-record (US-1108): keeps the edge schema-version guard (US-778) in sync.
INSERT INTO public.applied_migrations (version) VALUES ('00259')
ON CONFLICT (version) DO NOTHING;

COMMIT;


-- ════════════════════════════════════════════════════════════════════════════
-- 00260_garment_fingerprints.sql
-- ════════════════════════════════════════════════════════════════════════════

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


-- ════════════════════════════════════════════════════════════════════════════
-- 00261_item_photos_phash.sql
-- ════════════════════════════════════════════════════════════════════════════

-- 00261_item_photos_phash.sql
--
-- US-1099: relist detection via listing-image hash. To recognize when a seller
-- drafts a NEW listing using the SAME/near-identical photos as a garment we've
-- already graded (and minted a passport for), we perceptually hash the listing's
-- photos and compare them against the garment fingerprints (US-1097). This adds
-- a nullable, cached perceptual-hash column to item_photos so the hash is
-- computed once (on demand, server-side) and reused by later detections / the
-- admin fraud sweep (US-1103) — mirroring submission_images.phash (00062).
--
-- The hash is the SAME 64-bit dHash space (16 hex chars) used platform-wide
-- (perceptual-hash.ts / image-utils.ts), so item-photo hashes are directly
-- comparable to fingerprint hashes. NULL = not yet hashed (or undecodable);
-- detection treats NULL as "skip", so this is purely additive and safe.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS + guarded constraint + IF NOT EXISTS
-- index. Applies cleanly on a fresh schema (db verify lane).

BEGIN;

ALTER TABLE public.item_photos
  ADD COLUMN IF NOT EXISTS phash text;

COMMENT ON COLUMN public.item_photos.phash IS
  'US-1099: cached 64-bit perceptual dHash (16 hex chars) of this listing photo, '
  'computed server-side on demand. Comparable to garment_fingerprints phashes for '
  'relist detection. NULL until hashed (or if the image was undecodable).';

-- Enforce the 16-hex shape so a malformed value can never poison a Hamming
-- comparison (NULL stays allowed). Guarded so re-running is a no-op.
DO $$ BEGIN
  ALTER TABLE public.item_photos
    ADD CONSTRAINT item_photos_phash_format
    CHECK (phash IS NULL OR phash ~ '^[0-9a-f]{16}$');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Partial index: relist detection / fraud sweeps scan only the hashed rows.
CREATE INDEX IF NOT EXISTS idx_item_photos_phash
  ON public.item_photos(phash) WHERE phash IS NOT NULL;

-- self-record (US-1108): keeps the edge schema-version guard (US-778) in sync no
-- matter how this migration is applied. Version = this file's NNNNN prefix.
INSERT INTO public.applied_migrations (version) VALUES ('00261')
ON CONFLICT (version) DO NOTHING;

COMMIT;


-- ════════════════════════════════════════════════════════════════════════════
-- 00262_owner_nodes_linkage.sql
-- ════════════════════════════════════════════════════════════════════════════

-- 00262_owner_nodes_linkage.sql
--
-- US-1100: eBay sale → pseudonymous sold-to node (Garment Passport Layer 4).
-- When an item sells, we record WHO it sold to as a pseudonymous buyer node
-- WITHOUT storing buyer PII: the node carries a SALTED SHA-256 of the buyer
-- identifier (minimizeLinkageRef, US-1090) — never a name/email/address. The
-- same hash reappearing later (e.g. that buyer becomes a seller) lets us LINK
-- nodes to detect resale, with zero retained PII.
--
-- This adds a nullable linkage_hash column to owner_nodes + a partial index so
-- the resale-detection lookup (find other nodes sharing a hash) is cheap. The
-- raw identifier is never stored, and the digest is irreversible, so this is
-- limited-PII by construction. Service-role write only (owner_nodes is already
-- deny-all to anon/authenticated — 00256).
--
-- Idempotent: ADD COLUMN IF NOT EXISTS + IF NOT EXISTS index. Fresh-schema safe.

BEGIN;

ALTER TABLE public.owner_nodes
  ADD COLUMN IF NOT EXISTS linkage_hash text;

COMMENT ON COLUMN public.owner_nodes.linkage_hash IS
  'US-1100: salted SHA-256 (hex) of the buyer/seller identifier behind this '
  'pseudonymous node. NOT PII — the raw value is never stored and is not '
  'recoverable. Lets the same party be re-identified across chains to detect '
  'resale, while the public passport still shows only the ordinal label.';

-- Resale detection scans nodes sharing a linkage_hash; index only hashed rows.
CREATE INDEX IF NOT EXISTS idx_owner_nodes_linkage_hash
  ON public.owner_nodes(linkage_hash) WHERE linkage_hash IS NOT NULL;

-- self-record (US-1108): keeps the edge schema-version guard (US-778) in sync.
INSERT INTO public.applied_migrations (version) VALUES ('00262')
ON CONFLICT (version) DO NOTHING;

COMMIT;


-- ════════════════════════════════════════════════════════════════════════════
-- 00263_guarantee_claims_garment.sql
-- ════════════════════════════════════════════════════════════════════════════

-- 00263_guarantee_claims_garment.sql
--
-- US-1101: tie the buyer trust-guarantee to the Garment Passport CHAIN, not just
-- a one-off certificate. A guarantee claim (US-867) is filed against a public
-- certificate; that certificate's grade_report already carries a garment_id
-- (00257), so we denormalize the garment_id onto the claim. This makes the
-- guarantee travel WITH the passport — the incentive that makes buyers claim the
-- chain and resellers carry it forward.
--
-- Nullable + ON DELETE SET NULL: pre-passport certificates have no garment, and
-- a deleted garment must never cascade-delete a buyer's claim. Service-role
-- write only (guarantee_claims is already RLS-deny-all to clients — 00197).
--
-- Idempotent: ADD COLUMN IF NOT EXISTS + IF NOT EXISTS index. Fresh-schema safe.

BEGIN;

ALTER TABLE public.guarantee_claims
  ADD COLUMN IF NOT EXISTS garment_id uuid
    REFERENCES public.garments(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.guarantee_claims.garment_id IS
  'US-1101: the Garment Passport this claim is tied to (resolved server-side '
  'from the certificate''s grade_report, never the request). Nullable for '
  'pre-passport certificates. Lets a claim be anchored to the chain.';

CREATE INDEX IF NOT EXISTS idx_guarantee_claims_garment_id
  ON public.guarantee_claims (garment_id) WHERE garment_id IS NOT NULL;

-- self-record (US-1108): keeps the edge schema-version guard (US-778) in sync.
INSERT INTO public.applied_migrations (version) VALUES ('00263')
ON CONFLICT (version) DO NOTHING;

COMMIT;


-- ════════════════════════════════════════════════════════════════════════════
-- 00264_passport_integrity.sql
-- ════════════════════════════════════════════════════════════════════════════

-- 00264_passport_integrity.sql
--
-- US-1103: Garment Passport admin integrity & fraud signals. Keeps the ledger
-- credible by surfacing anomalies an admin can triage + act on:
--   • wear_reversal         — condition that IMPROVED across a 'same item' link
--                             (a later fingerprint is in better shape than an
--                             earlier one — physically impossible without a swap).
--   • duplicate_fingerprint — the SAME visual fingerprint on two ACTIVE garments
--                             held by DIFFERENT owner nodes (one physical item
--                             can't be in two active chains at once).
--   • rapid_reclaim         — a garment's passport reclaimed many times in a short
--                             window (claim-link churn / resale laundering).
--   • token_replay          — repeated redemption attempts against an already-used
--                             or expired claim token (a replay probe).
--
-- This MIRRORS the durable abuse_signals lifecycle (00212) — one row per concern,
-- idempotent via a stable dedupe_key, moved through open→reviewing→
-- actioned/dismissed — but is keyed on garment_id (not a user) because passport
-- participants are PSEUDONYMOUS owner_nodes, not accounts. It REUSES the existing
-- abuse_signal_severity / abuse_signal_status enums rather than re-declaring them.
--
-- Two supporting pieces:
--   • passport_claim_attempts — an append-only log of claim-token redemption
--     attempts (success + rejection) so the token_replay / rapid_reclaim detectors
--     have something to count. Records only a token HASH + outcome + a SALTED
--     source hash — never the raw token, never a raw IP.
--   • garment_events.severed_* — lets an admin SEVER a probable link (AC2): a
--     severed event is dropped from the public passport timeline + chain.
--
-- Security: all three surfaces are OPERATOR-only (service-role write, deny-all to
-- anon/authenticated) — a tenant must not read anomalies raised about a chain.
-- Keyed on garment_id (not user_id/created_by) so the tenant-isolation guard does
-- not misclassify these admin-only tables as user-owned tenant data.
--
-- Idempotent: enum guarded, tables IF NOT EXISTS, columns ADD IF NOT EXISTS,
-- trigger dropped-then-created. Fresh-schema safe (db verify lane).

BEGIN;

-- ── Anomaly type enum ─────────────────────────────────────────────────────────
DO $$ BEGIN
  CREATE TYPE public.passport_integrity_type AS ENUM (
    'wear_reversal', 'duplicate_fingerprint', 'rapid_reclaim', 'token_replay'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── passport_claim_attempts (append-only redemption log) ──────────────────────
-- Written by the anonymous /api/passport/claim route (service role). Holds only
-- the attempted token HASH (so we can join to passport_claim_tokens), the garment
-- when resolvable, the outcome, and a SALTED source hash — never the raw token,
-- never a raw IP/email. Cascade-deletes with the garment.
CREATE TABLE IF NOT EXISTS public.passport_claim_attempts (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- SHA-256 of the attempted raw token (same hashing as passport_claim_tokens).
  token_hash      text NOT NULL,
  -- The garment, when the token resolved to one (NULL for an unknown token).
  garment_id      uuid REFERENCES public.garments(id) ON DELETE CASCADE,
  -- 'claimed' (first valid redemption) | 'rejected' (invalid/expired/replay).
  outcome         text NOT NULL CHECK (outcome IN ('claimed', 'rejected')),
  -- The buyer node a successful claim minted (NULL on rejection).
  claimed_node_id uuid REFERENCES public.owner_nodes(id) ON DELETE SET NULL,
  -- Salted SHA-256 of the caller IP (PII-minimized; NULL when absent).
  source_hash     text,
  created_at      timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.passport_claim_attempts IS
  'US-1103: append-only log of passport claim-token redemption attempts (success '
  '+ rejection). Token HASH + outcome + salted source hash only — never the raw '
  'token or a raw IP. Feeds the token_replay / rapid_reclaim integrity detectors. '
  'Service-role only.';

-- Replay detection joins attempts to a token by hash; both detectors scan recent.
CREATE INDEX IF NOT EXISTS idx_passport_claim_attempts_token
  ON public.passport_claim_attempts(token_hash, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_passport_claim_attempts_garment
  ON public.passport_claim_attempts(garment_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_passport_claim_attempts_created
  ON public.passport_claim_attempts(created_at DESC);

ALTER TABLE public.passport_claim_attempts ENABLE ROW LEVEL SECURITY;
-- Service-role only — no client policies (deny-all to anon/authenticated).
REVOKE INSERT, UPDATE, DELETE ON public.passport_claim_attempts FROM anon, authenticated;

-- ── garment_events: admin "sever a probable link" (AC2) ───────────────────────
-- The ledger stays append-only for tenants; an admin can SEVER a specific link
-- (a probable ownership_transfer/listed event flagged as fraudulent). A severed
-- event is filtered out of the public passport timeline + chain. Service-role
-- write only (the existing REVOKE on garment_events already blocks clients).
ALTER TABLE public.garment_events
  ADD COLUMN IF NOT EXISTS severed_at     timestamptz;
ALTER TABLE public.garment_events
  ADD COLUMN IF NOT EXISTS severed_by     uuid REFERENCES public.users(id) ON DELETE SET NULL;
ALTER TABLE public.garment_events
  ADD COLUMN IF NOT EXISTS severed_reason text;

-- Public read filters severed events; index the live (un-severed) ledger.
CREATE INDEX IF NOT EXISTS idx_garment_events_live
  ON public.garment_events(garment_id, created_at)
  WHERE severed_at IS NULL;

-- ── passport_integrity_signals (durable, triageable anomalies) ────────────────
CREATE TABLE IF NOT EXISTS public.passport_integrity_signals (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  signal_type       public.passport_integrity_type not null,
  severity          public.abuse_signal_severity   not null default 'medium',
  status            public.abuse_signal_status     not null default 'open',
  -- The garment the anomaly is RAISED ABOUT (the primary subject). A
  -- duplicate_fingerprint also names a counterpart garment in evidence.
  garment_id        uuid not null references public.garments(id) on delete cascade,
  -- Stable identity for an in-progress concern → the scan is idempotent: a re-run
  -- UPDATES evidence/last_seen of an existing open/reviewing signal rather than
  -- duplicating, and never reopens one already actioned/dismissed.
  dedupe_key        text not null unique,
  -- The anomaly FACT only — garment/owner-node/event ids + hashes + counts. Never
  -- image bytes, signed URLs, or PII (enforced by assertSafePassportEvidence).
  evidence          jsonb not null default '{}'::jsonb,
  -- Admin annotations (AC2): [{ by, at, text }] appended via /notes. Free-form
  -- operator context, kept separate from the machine evidence.
  notes             jsonb not null default '[]'::jsonb,
  -- Triage trail. resolution_reason is required by the API on action/dismiss.
  resolved_by       uuid references public.users(id) on delete set null,
  resolution_reason text,
  resolved_at       timestamptz,
  first_seen_at     timestamptz not null default now(),
  last_seen_at      timestamptz not null default now(),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

COMMENT ON TABLE public.passport_integrity_signals IS
  'US-1103: durable, triageable Garment Passport integrity anomalies (wear '
  'reversal, duplicate fingerprint across owners, rapid re-claim, token replay). '
  'Populated by the passport-integrity-scan cron; managed via '
  '/api/admin/passport-integrity/*. Keyed on garment_id (not user_id) so the '
  'tenant-isolation guard does not treat this admin-only table as user-owned '
  'data. evidence holds only ids + hashes + counts, never image bytes. '
  'Service-role only (deny-all RLS).';

-- The console lists by status, filtered by type/severity, newest first.
CREATE INDEX IF NOT EXISTS idx_passport_integrity_triage
  ON public.passport_integrity_signals (status, signal_type, severity, last_seen_at desc);
CREATE INDEX IF NOT EXISTS idx_passport_integrity_garment
  ON public.passport_integrity_signals (garment_id);

DROP TRIGGER IF EXISTS trg_passport_integrity_updated_at ON public.passport_integrity_signals;
CREATE TRIGGER trg_passport_integrity_updated_at
  BEFORE UPDATE ON public.passport_integrity_signals
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.passport_integrity_signals ENABLE ROW LEVEL SECURITY;
-- Service-role only (no client policies). Deny-all to anon/authenticated.
REVOKE INSERT, UPDATE, DELETE ON public.passport_integrity_signals FROM anon, authenticated;

-- self-record (US-1108): keeps the edge schema-version guard (US-778) in sync no
-- matter how this migration is applied. Version = this file's NNNNN prefix.
INSERT INTO public.applied_migrations (version) VALUES ('00264')
ON CONFLICT (version) DO NOTHING;

COMMIT;


-- ════════════════════════════════════════════════════════════════════════════
-- 00265_owner_nodes_identity_reveal.sql
-- ════════════════════════════════════════════════════════════════════════════

-- 00265_owner_nodes_identity_reveal.sql
--
-- US-1105: opt-in identity reveal for the Garment Passport. By default every
-- participant on a passport is fully PSEUDONYMOUS (US-1090) — `owner_nodes` carry
-- only an ordinal label ("Seller A", "Buyer B") and, when the actor happened to
-- be signed in during a claim, a `linked_user_id` uuid that is NEVER exposed
-- publicly. This story lets a user who WANTS public credit explicitly, per-hop,
-- reveal their *already-public* GradeThread Verified handle on the chain.
--
-- Two columns on owner_nodes drive it:
--   • identity_revealed    — the per-hop consent flag. OFF by default. A reveal
--                            is only ever EFFECTIVE when this is true AND the
--                            node is linked AND that user has a PUBLIC verified
--                            profile (verified_enabled + handle). So the reveal
--                            ANDs with the existing opt-in verified profile —
--                            disabling either instantly re-pseudonymizes the hop.
--   • identity_revealed_at — when consent was granted (audit + reversibility).
--
-- PRIVACY: no PII is added here. The only thing a reveal ever surfaces is the
-- user's own public verified handle/display name (the same fields US-1101
-- already exposes for the origin seller) — never an id, email, or address. The
-- raw account linkage (`linked_user_id`) stays service-role-only and unexposed.
-- Reveals are honored across export/delete: account deletion's ON DELETE SET NULL
-- on linked_user_id severs the link, and /api/account/delete additionally
-- unreveals the user's nodes (defense-in-depth) so nothing can resolve after.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS + IF NOT EXISTS index. Fresh-schema safe.
-- owner_nodes is already deny-all to anon/authenticated (00256) — service-role
-- writes only; the public passport reads a PII-free projection via the edge.

BEGIN;

ALTER TABLE public.owner_nodes
  ADD COLUMN IF NOT EXISTS identity_revealed boolean NOT NULL DEFAULT false;

ALTER TABLE public.owner_nodes
  ADD COLUMN IF NOT EXISTS identity_revealed_at timestamptz;

COMMENT ON COLUMN public.owner_nodes.identity_revealed IS
  'US-1105: per-hop opt-in consent to show this node owner''s PUBLIC GradeThread '
  'Verified handle on the passport. OFF by default; only effective when '
  'linked_user_id is set AND that user has a public verified profile. Reversible.';

COMMENT ON COLUMN public.owner_nodes.identity_revealed_at IS
  'US-1105: when identity_revealed was last set true (audit / reversibility). '
  'NULL while pseudonymous.';

-- The reveal projection / management list both filter by linked_user_id (already
-- indexed, 00256). A small partial index over the revealed rows keeps the public
-- passport''s "is this actor revealed" resolution cheap without bloating writes.
CREATE INDEX IF NOT EXISTS idx_owner_nodes_revealed
  ON public.owner_nodes(linked_user_id)
  WHERE identity_revealed AND linked_user_id IS NOT NULL;

-- self-record (US-1108): keeps the edge schema-version guard (US-778) in sync.
INSERT INTO public.applied_migrations (version) VALUES ('00265')
ON CONFLICT (version) DO NOTHING;

COMMIT;


-- ════════════════════════════════════════════════════════════════════════════
-- 00266_flipdesk_expenses_item_link.sql
-- ════════════════════════════════════════════════════════════════════════════

-- 00266_flipdesk_expenses_item_link.sql
--
-- US-750: single source of truth for Sales + Expenses on iOS. The Expenses half
-- needs each expense to optionally point at the inventory item (and/or listing)
-- it offsets, so per-item P&L and expense-by-source reporting become possible —
-- today `flipdesk_expenses` (00019) only models business-wide overhead with no
-- way to attribute a cost to the thing it was spent on.
--
-- Two nullable foreign keys:
--   • inventory_item_id — the item this expense offsets (e.g. a repair, a
--                         dry-clean, sourcing cost for one piece). NULL = general
--                         overhead, the existing behavior.
--   • listing_id        — the listing this expense is tied to (e.g. a promoted-
--                         listing fee). NULL = not listing-specific.
--
-- Both ON DELETE SET NULL: deleting the item/listing must NOT delete the
-- expense — the money was still spent; it just becomes unattributed overhead.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS + IF NOT EXISTS indexes. Fresh-schema
-- safe (the table + referenced tables already exist by this point).

BEGIN;

ALTER TABLE public.flipdesk_expenses
  ADD COLUMN IF NOT EXISTS inventory_item_id uuid
    REFERENCES public.inventory_items(id) ON DELETE SET NULL;

ALTER TABLE public.flipdesk_expenses
  ADD COLUMN IF NOT EXISTS listing_id uuid
    REFERENCES public.listings(id) ON DELETE SET NULL;

-- Partial indexes so per-item / per-listing expense roll-ups stay cheap and the
-- index only carries the rows that are actually attributed.
CREATE INDEX IF NOT EXISTS idx_flipdesk_expenses_inventory_item_id
  ON public.flipdesk_expenses(inventory_item_id)
  WHERE inventory_item_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_flipdesk_expenses_listing_id
  ON public.flipdesk_expenses(listing_id)
  WHERE listing_id IS NOT NULL;

-- self-record (US-1108): keeps the edge schema-version guard (US-778) in sync.
INSERT INTO public.applied_migrations (version) VALUES ('00266')
ON CONFLICT (version) DO NOTHING;

COMMIT;


-- ════════════════════════════════════════════════════════════════════════════
-- 00267_drip_next_evaluation.sql
-- ════════════════════════════════════════════════════════════════════════════

-- US-943: Autonomous drip orchestration tick — self-gating evaluation cursor.
--
-- The autonomous engine tick (POST /api/drip/tick) runs frequently (e.g.
-- hourly) and must stay cheap + idempotent: most active enrollments have nothing
-- due on any given run. `next_evaluation_at` lets the tick skip enrollments that
-- aren't due yet with a single indexed predicate, instead of re-walking every
-- enrollment's graph each run. After processing an enrollment the tick stamps the
-- projected time of its next unsent step here; a NULL value means "evaluate on
-- the next run" (freshly enrolled, or never evaluated). Catch-up after downtime
-- is automatic: a window that elapsed while the engine was down simply has
-- next_evaluation_at in the past, so the next run picks it up rather than
-- skipping it.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS + IF NOT EXISTS index. Service-role only
-- (the table already has RLS on with no policy from 00253).

BEGIN;

ALTER TABLE public.drip_enrollments
  ADD COLUMN IF NOT EXISTS next_evaluation_at timestamptz;

COMMENT ON COLUMN public.drip_enrollments.next_evaluation_at IS
  'US-943: when the autonomous tick should next evaluate this enrollment. NULL = '
  'evaluate on the next run. The tick self-gates on this so frequent ticks stay cheap.';

-- Partial index over the exact predicate the tick filters on: active (not exited)
-- enrollments whose evaluation is due. Keeps the per-tick scan bounded to the
-- backlog regardless of total enrollment volume.
CREATE INDEX IF NOT EXISTS drip_enrollments_due_idx
  ON public.drip_enrollments (campaign, next_evaluation_at)
  WHERE exited_at IS NULL;

COMMIT;

-- self-record (US-1108): keeps the edge schema-version guard (US-778) in sync
-- regardless of how this migration is applied.
INSERT INTO public.applied_migrations (version) VALUES ('00267')
ON CONFLICT (version) DO NOTHING;


-- ════════════════════════════════════════════════════════════════════════════
-- 00268_drip_incentive.sql
-- ════════════════════════════════════════════════════════════════════════════

-- US-942: Conversion incentive / promo integration for the trial-conversion
-- drip win-back.
--
-- When the autonomous drip engine (00267 / routes/drip.ts) sends an eligible
-- win-back step with the campaign incentive ON, it stashes a time-boxed Stripe
-- coupon on the recipient so their next subscription checkout pre-applies it
-- (one-click conversion, payments.ts). These two columns hold that pending
-- offer; the Stripe webhook clears them once the subscription is created
-- (one-time offer, mirrors `pending_referral_coupon` from 00236).
--
-- The incentive DEFINITION (enabled flag, coupon id, promo code, max-discount
-- guardrail, expiry window) lives on drip_campaigns.graph.incentive (jsonb, no
-- schema change — validated in drip-graph.ts) and is edited from the admin
-- builder. Redemption/ROI is tracked via the existing
-- drip_enrollments.incentive_enabled flag + drip_attributions (00253) — the
-- engine flips the flag when it surfaces the offer, so the incentive-lift
-- analytics already pick it up.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS. No RLS change — `users` already has its
-- policies; these columns are written by the service-role engine + webhook and
-- read by the checkout handler.

BEGIN;

ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS pending_drip_coupon text;

ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS pending_drip_coupon_expires_at timestamptz;

COMMENT ON COLUMN public.users.pending_drip_coupon IS
  'US-942: Stripe coupon id from a win-back drip incentive, pre-applied at the '
  'next subscription checkout. Cleared by the webhook on subscription.created.';
COMMENT ON COLUMN public.users.pending_drip_coupon_expires_at IS
  'US-942: time-box for pending_drip_coupon; checkout ignores it once expired.';

COMMIT;

-- self-record (US-1108): keeps the edge schema-version guard (US-778) in sync
-- regardless of how this migration is applied.
INSERT INTO public.applied_migrations (version) VALUES ('00268')
ON CONFLICT (version) DO NOTHING;


-- ════════════════════════════════════════════════════════════════════════════
-- 00269_drip_winback_sequence.sql
-- ════════════════════════════════════════════════════════════════════════════

-- US-941: Phase 3 post-trial win-back sequence (days 15–28).
--
-- The default trial-conversion campaign graph (seeded in 00255) shipped with a
-- minimal 2-touch win-back tail (win_back_1 + win_back_final). This migration
-- replaces that tail with the full, respectful post-trial sequence for a
-- trialist who lapsed to Free, anchored to the (14-day) trial end:
--
--   • Day 16 (trial_end + 48h)  win_back_free  — "you're on Free now; here's
--                                what you're missing" (outcome + lost Pro features)
--   • Day 20 (trial_end + 144h) win_back_value — value / objection-handling
--   • Day 24 (trial_end + 240h) win_back_offer — incentive offer (config-gated:
--                                surfaces a code ONLY when graph.incentive is on,
--                                US-942, and the user hasn't converted)
--   • Day 28 (trial_end + 336h) win_back_final — final touch, THEN exit the
--                                journey → the user is handed back to the standard
--                                (occasional) newsletter cadence.
--
-- Every win-back step gates on `converted = is_false`, so a user who converted
-- during the trial never enters win-back (and a conversion exits the whole
-- journey instantly — routes/drip.ts). Marketing consent / suppression /
-- unsubscribe are enforced at dispatch (the engine exits an opted-out recipient),
-- so the sequence is unambiguously marketing and fully honors opt-out.
--
-- The in-trial steps (welcome, tips, ending_soon, ending_soon_active) are
-- unchanged except their `next` now points at the new first win-back step.
--
-- Idempotent + non-clobbering: only the recognizable ORIGINAL default graph (has
-- win_back_1, lacks win_back_free) is rewritten. Once the new steps exist — or an
-- operator has edited the graph in the builder — this is a no-op.

BEGIN;

UPDATE public.drip_campaigns
SET graph = $json$
{
  "entryStepId": "welcome",
  "steps": [
    {
      "id": "welcome",
      "label": "Welcome — grade your first item",
      "phase": "in_trial",
      "trigger": "trial_started",
      "anchor": "enrollment",
      "delayHours": 0,
      "conditions": [],
      "brief": "Warm welcome. One clear CTA: upload your first garment and get a grade in minutes. No card on file — reassure them the trial is free.",
      "incentiveEnabled": false,
      "branches": [],
      "next": "tips",
      "exit": false,
      "variants": [
        {
          "id": "A",
          "weight": 100,
          "subject": "Welcome to GradeThread, {{firstName}} — let's grade your first item",
          "html": "<p>Hi {{firstName}},</p><p>Your free trial is live. Upload a garment and get a standardized condition grade in minutes.</p><p><a href=\"https://gradethread.com/dashboard\">Grade your first item</a></p>"
        }
      ]
    },
    {
      "id": "tips",
      "label": "Day 3 — get better grades",
      "phase": "in_trial",
      "trigger": "after_previous",
      "anchor": "previous",
      "delayHours": 72,
      "conditions": [{ "field": "converted", "op": "is_false" }],
      "brief": "Educational: how to photograph for the most accurate grade (front/back/label/detail). Reinforce value of the certificate.",
      "incentiveEnabled": false,
      "branches": [],
      "next": "ending_soon",
      "exit": false,
      "variants": [
        {
          "id": "A",
          "weight": 100,
          "subject": "Get sharper grades, {{firstName}}",
          "html": "<p>Hi {{firstName}},</p><p>Four photos — front, back, label, and a detail — get you the most accurate grade and a shareable certificate.</p>"
        }
      ]
    },
    {
      "id": "ending_soon",
      "label": "Trial ending — convert with incentive",
      "phase": "in_trial",
      "trigger": "before_trial_end",
      "anchor": "trial_end",
      "delayHours": -72,
      "conditions": [{ "field": "converted", "op": "is_false" }],
      "brief": "Urgency: trial ends in 3 days. Offer the launch incentive. Make upgrading one click.",
      "incentiveEnabled": true,
      "branches": [
        { "conditions": [{ "field": "gradesUsed", "op": "gte", "value": 1 }], "targetStepId": "ending_soon_active" }
      ],
      "next": "win_back_free",
      "exit": false,
      "variants": [
        {
          "id": "A",
          "weight": 50,
          "subject": "Your trial ends in 3 days, {{firstName}}",
          "html": "<p>Hi {{firstName}},</p><p>Your trial ends {{trialEndsAt}}. Upgrade now to keep grading.</p>{{incentive}}"
        },
        {
          "id": "B",
          "weight": 50,
          "subject": "Don't lose your reports, {{firstName}}",
          "html": "<p>Hi {{firstName}},</p><p>Keep your certificates and reports — upgrade before {{trialEndsAt}}.</p>{{incentive}}"
        }
      ]
    },
    {
      "id": "ending_soon_active",
      "label": "Trial ending — engaged users",
      "phase": "in_trial",
      "trigger": "before_trial_end",
      "anchor": "trial_end",
      "delayHours": -72,
      "conditions": [{ "field": "converted", "op": "is_false" }],
      "brief": "For users who already graded items: emphasize what they'll lose access to and how cheap continuing is.",
      "incentiveEnabled": true,
      "branches": [],
      "next": "win_back_free",
      "exit": false,
      "variants": [
        {
          "id": "A",
          "weight": 100,
          "subject": "Keep grading, {{firstName}} — your trial ends {{trialEndsAt}}",
          "html": "<p>Hi {{firstName}},</p><p>You've already graded items this trial. Upgrade to keep your reports and grade more.</p>{{incentive}}"
        }
      ]
    },
    {
      "id": "win_back_free",
      "label": "Win-back Day 16 — you're on Free now",
      "phase": "win_back",
      "trigger": "trial_expired",
      "anchor": "trial_end",
      "delayHours": 48,
      "conditions": [{ "field": "converted", "op": "is_false" }],
      "brief": "Trial lapsed to Free. Friendly, no guilt. Name the specific Pro features they used during the trial that are now paused (unlimited grading, shareable certificates, full condition reports) and lead with the outcome — buyer-trusted grades sell faster. One low-friction CTA to upgrade.",
      "incentiveEnabled": false,
      "branches": [],
      "next": "win_back_value",
      "exit": false,
      "variants": [
        {
          "id": "A",
          "weight": 100,
          "subject": "You're on Free now, {{firstName}} — here's what you're missing",
          "html": "<p>Hi {{firstName}},</p><p>Your trial wrapped up and you're back on the Free plan. The Pro features you used during your trial — unlimited grading, shareable certificates, and full condition reports — are paused.</p><p>Sellers using buyer-trusted grades move items faster and field fewer 'what condition is it really?' questions. Pick up right where you left off whenever you're ready.</p><p><a href=\"https://gradethread.com/pricing\">See what Pro unlocks</a></p>"
        }
      ]
    },
    {
      "id": "win_back_value",
      "label": "Win-back Day 20 — is it worth it?",
      "phase": "win_back",
      "trigger": "after_trial_end",
      "anchor": "trial_end",
      "delayHours": 144,
      "conditions": [{ "field": "converted", "op": "is_false" }],
      "brief": "Objection-handling. Tackle the price objection head-on with outcomes: one extra sale a month more than covers Pro; standardized grades cut returns and disputes; certificates build buyer trust. No incentive yet — earn the upgrade on value.",
      "incentiveEnabled": false,
      "branches": [],
      "next": "win_back_offer",
      "exit": false,
      "variants": [
        {
          "id": "A",
          "weight": 100,
          "subject": "Is GradeThread worth it, {{firstName}}? Here's the honest math",
          "html": "<p>Hi {{firstName}},</p><p>Fair question. Here's how Pro pays for itself:</p><ul><li><strong>One extra sale a month</strong> more than covers it — standardized grades help items sell faster and at better prices.</li><li><strong>Fewer returns and disputes</strong> — a clear, certified condition grade sets buyer expectations up front.</li><li><strong>Buyer trust</strong> — a shareable certificate signals you're a serious, transparent seller.</li></ul><p><a href=\"https://gradethread.com/pricing\">Upgrade to Pro</a></p>"
        }
      ]
    },
    {
      "id": "win_back_offer",
      "label": "Win-back Day 24 — incentive offer",
      "phase": "win_back",
      "trigger": "after_trial_end",
      "anchor": "trial_end",
      "delayHours": 240,
      "conditions": [{ "field": "converted", "op": "is_false" }],
      "brief": "Now sweeten it. Recap the value, then surface the conversion incentive (config-gated — only renders when the campaign incentive is enabled and the user hasn't converted). Make upgrading one click.",
      "incentiveEnabled": true,
      "branches": [],
      "next": "win_back_final",
      "exit": false,
      "variants": [
        {
          "id": "A",
          "weight": 100,
          "subject": "A little nudge to come back, {{firstName}}",
          "html": "<p>Hi {{firstName}},</p><p>You graded items, built certificates, and saw what standardized condition grading does for your listings. Here's a hand getting back to it.</p>{{incentive}}<p><a href=\"https://gradethread.com/pricing\">Upgrade to Pro</a></p>"
        }
      ]
    },
    {
      "id": "win_back_final",
      "label": "Win-back Day 28 — final, then exit",
      "phase": "win_back",
      "trigger": "after_trial_end",
      "anchor": "trial_end",
      "delayHours": 336,
      "conditions": [{ "field": "converted", "op": "is_false" }],
      "brief": "Last touch of the focused win-back. Strongest incentive with a clear deadline, then exit the journey — the user is handed back to the standard occasional newsletter (no more drip). Respectful sign-off.",
      "incentiveEnabled": true,
      "branches": [],
      "next": null,
      "exit": true,
      "variants": [
        {
          "id": "A",
          "weight": 100,
          "subject": "Last call, {{firstName}} — your offer expires soon",
          "html": "<p>Hi {{firstName}},</p><p>This is the last nudge from our trial series — your offer expires soon.</p>{{incentive}}<p>Whatever you decide, your past grades and certificates are safe, and we'll only send the occasional newsletter from here. Come back any time.</p><p><a href=\"https://gradethread.com/pricing\">Upgrade to Pro</a></p>"
        }
      ]
    }
  ]
}
$json$::jsonb
WHERE campaign = 'trial_conversion'
  AND graph -> 'steps' @> '[{"id": "win_back_1"}]'::jsonb
  AND NOT (graph -> 'steps' @> '[{"id": "win_back_free"}]'::jsonb);

COMMIT;

-- self-record (US-1108): keeps the edge schema-version guard (US-778) in sync
-- regardless of how this migration is applied.
INSERT INTO public.applied_migrations (version) VALUES ('00269')
ON CONFLICT (version) DO NOTHING;


-- ════════════════════════════════════════════════════════════════════════════
-- 00270_drip_conversion_push.sql
-- ════════════════════════════════════════════════════════════════════════════

-- US-940: Phase 2 in-trial conversion-push sequence (days 7–14).
--
-- The default trial-conversion campaign graph (00255 → 00269) carried a thin
-- in-trial middle: welcome (day 0) → tips (day 3) → a single ending_soon touch
-- (~day 11, with an engaged-user branch) → the post-trial win-back tail. This
-- migration replaces that single ending_soon touch with the full conversion-push
-- sequence that carries a trialist to the finish line:
--
--   • Day 7  (enrollment + 168h)  recap            — mid-trial personalized recap
--            + ROI framing from their REAL activity ({{gradesCount}}/
--            {{listingsCount}}/{{salesCount}}/{{certificatesCount}}). Sends only
--            when they have activity; a zero-activity trialist instead falls
--            through to…
--   • Day 7  (enrollment + 168h)  recap_reactivate — re-activation variant for a
--            zero-activity trialist (totalActivity = 0).
--   • Day 10 (enrollment + 240h)  feature_deepdive — deep-dive on the shareable
--            certificate (a high-value feature). Branch: if they've already made
--            a certificate (certificatesCount > 0) the step is skipped.
--   • Day 12 (trial_end − 48h)    urgency_2d       — "trial ends in 2 days".
--   • Day 13 (trial_end − 24h)    urgency_1d       — "ends tomorrow / what you'll
--            lose" (grounded {{lostFeatures}} list).
--   • Day 14 (trial_end)          urgency_today    — "last chance today", then on
--            to the post-trial win-back tail.
--
-- The three urgency steps are anchored to the ACTUAL trial_end (anchor
-- "trial_end"), NOT a fixed offset from enrollment — so an admin-adjusted trial
-- window (admin-billing.ts) stays correct (AC2). Every step gates on
-- `converted = is_false`, so conversion at ANY point skips all further sends and
-- the engine exits the journey instantly (routes/drip.ts). Each step's primary
-- CTA is the subscribe / add-a-card deep-link ({{checkoutUrl}} →
-- /dashboard/billing?upgrade=pro for the recommended plan).
--
-- Idempotent + non-clobbering: only the recognizable 00269-shape default graph
-- (has ending_soon, lacks recap) is rewritten. Once the conversion-push steps
-- exist — or an operator has edited the graph in the builder — this is a no-op.

BEGIN;

UPDATE public.drip_campaigns
SET graph = $json$
{
  "entryStepId": "welcome",
  "steps": [
    {
      "id": "welcome",
      "label": "Welcome — grade your first item",
      "phase": "in_trial",
      "trigger": "trial_started",
      "anchor": "enrollment",
      "delayHours": 0,
      "conditions": [],
      "brief": "Warm welcome. One clear CTA: upload your first garment and get a grade in minutes. No card on file — reassure them the trial is free.",
      "incentiveEnabled": false,
      "branches": [],
      "next": "tips",
      "exit": false,
      "variants": [
        {
          "id": "A",
          "weight": 100,
          "subject": "Welcome to GradeThread, {{firstName}} — let's grade your first item",
          "html": "<p>Hi {{firstName}},</p><p>Your free trial is live. Upload a garment and get a standardized condition grade in minutes.</p><p><a href=\"https://gradethread.com/dashboard\">Grade your first item</a></p>"
        }
      ]
    },
    {
      "id": "tips",
      "label": "Day 3 — get better grades",
      "phase": "in_trial",
      "trigger": "after_previous",
      "anchor": "previous",
      "delayHours": 72,
      "conditions": [{ "field": "converted", "op": "is_false" }],
      "brief": "Educational: how to photograph for the most accurate grade (front/back/label/detail). Reinforce value of the certificate.",
      "incentiveEnabled": false,
      "branches": [],
      "next": "recap",
      "exit": false,
      "variants": [
        {
          "id": "A",
          "weight": 100,
          "subject": "Get sharper grades, {{firstName}}",
          "html": "<p>Hi {{firstName}},</p><p>Four photos — front, back, label, and a detail — get you the most accurate grade and a shareable certificate.</p>"
        }
      ]
    },
    {
      "id": "recap",
      "label": "Day 7 — your trial so far (recap + ROI)",
      "phase": "in_trial",
      "trigger": "midtrial_recap",
      "anchor": "enrollment",
      "delayHours": 168,
      "conditions": [
        { "field": "converted", "op": "is_false" },
        { "field": "totalActivity", "op": "gt", "value": 0 }
      ],
      "brief": "Mid-trial personalized recap. Reflect their REAL numbers (grades, listings, sales, certificates) and frame the ROI: standardized grades sell faster, build buyer trust, cut returns. Primary CTA: subscribe so they keep it all. Only sent to users with activity; the zero-activity branch sends a re-activation variant instead.",
      "incentiveEnabled": false,
      "branches": [
        { "conditions": [{ "field": "totalActivity", "op": "is_false" }], "targetStepId": "recap_reactivate" }
      ],
      "next": "feature_deepdive",
      "exit": false,
      "variants": [
        {
          "id": "A",
          "weight": 100,
          "subject": "{{firstName}}, here's your GradeThread trial so far",
          "html": "<p>Hi {{firstName}},</p><p>You're a week into your trial — here's what you've done:</p><ul><li><strong>{{gradesCount}}</strong> items graded</li><li><strong>{{certificatesCount}}</strong> shareable certificates</li><li><strong>{{listingsCount}}</strong> listings</li><li><strong>{{salesCount}}</strong> sales</li></ul><p>Sellers who lead with buyer-trusted grades move items faster and field fewer 'what condition is it really?' questions. Keep that momentum — subscribe to {{recommendedPlan}} before your trial ends.</p><p><a href=\"{{checkoutUrl}}\">Subscribe to {{recommendedPlan}}</a></p>"
        }
      ]
    },
    {
      "id": "recap_reactivate",
      "label": "Day 7 — re-activation (no activity yet)",
      "phase": "in_trial",
      "trigger": "midtrial_reactivate",
      "anchor": "enrollment",
      "delayHours": 168,
      "conditions": [{ "field": "converted", "op": "is_false" }],
      "brief": "Re-activation for a trialist who hasn't done anything yet. No guilt — make the very first grade feel effortless and show the payoff. One low-friction CTA to grade a first item. Keep the subscribe option secondary.",
      "incentiveEnabled": false,
      "branches": [],
      "next": "feature_deepdive",
      "exit": false,
      "variants": [
        {
          "id": "A",
          "weight": 100,
          "subject": "{{firstName}}, grade your first item in under 5 minutes",
          "html": "<p>Hi {{firstName}},</p><p>Your trial is running and you haven't graded anything yet — no worries, it takes minutes. Snap four photos (front, back, label, a detail) and get a standardized condition grade plus a shareable certificate buyers trust.</p><p><a href=\"https://gradethread.com/dashboard\">Grade your first item</a></p><p>Already convinced? <a href=\"{{checkoutUrl}}\">Subscribe to {{recommendedPlan}}</a>.</p>"
        }
      ]
    },
    {
      "id": "feature_deepdive",
      "label": "Day 10 — shareable certificate deep-dive",
      "phase": "in_trial",
      "trigger": "feature_deepdive",
      "anchor": "enrollment",
      "delayHours": 240,
      "conditions": [
        { "field": "converted", "op": "is_false" },
        { "field": "certificatesCount", "op": "is_false" }
      ],
      "brief": "Deep-dive on a high-value feature they haven't used yet: the shareable condition certificate. Show the outcome — a public, verifiable certificate buyers trust. Skipped (branch) for anyone who already created a certificate. CTA to subscribe so the certificates stay live.",
      "incentiveEnabled": false,
      "branches": [
        { "conditions": [{ "field": "certificatesCount", "op": "gt", "value": 0 }], "targetStepId": "urgency_2d" }
      ],
      "next": "urgency_2d",
      "exit": false,
      "variants": [
        {
          "id": "A",
          "weight": 100,
          "subject": "{{firstName}}, the one feature buyers love most",
          "html": "<p>Hi {{firstName}},</p><p>You've graded items — but have you shared a <strong>certificate</strong> yet? Each grade comes with a public, verifiable condition certificate you can drop into any listing. It's the single fastest way to turn 'what condition is it?' into a confident buy.</p><p><a href=\"https://gradethread.com/dashboard\">Create a certificate</a></p><p>Keep your certificates live after the trial — <a href=\"{{checkoutUrl}}\">subscribe to {{recommendedPlan}}</a>.</p>"
        }
      ]
    },
    {
      "id": "urgency_2d",
      "label": "Day 12 — trial ends in 2 days",
      "phase": "in_trial",
      "trigger": "trial_end_minus_2d",
      "anchor": "trial_end",
      "delayHours": -48,
      "conditions": [{ "field": "converted", "op": "is_false" }],
      "brief": "Urgency, anchored to the ACTUAL trial end. Two days left. Clear, friendly nudge: add a card now to keep Pro. One-click subscribe CTA.",
      "incentiveEnabled": false,
      "branches": [],
      "next": "urgency_1d",
      "exit": false,
      "variants": [
        {
          "id": "A",
          "weight": 100,
          "subject": "Your trial ends in 2 days, {{firstName}}",
          "html": "<p>Hi {{firstName}},</p><p>Your trial ends {{trialEndsAt}} — that's two days away. Add a card now to keep grading, certificates, and your reports without interruption.</p><p><a href=\"{{checkoutUrl}}\">Subscribe to {{recommendedPlan}}</a></p>"
        }
      ]
    },
    {
      "id": "urgency_1d",
      "label": "Day 13 — ends tomorrow / what you'll lose",
      "phase": "in_trial",
      "trigger": "trial_end_minus_1d",
      "anchor": "trial_end",
      "delayHours": -24,
      "conditions": [{ "field": "converted", "op": "is_false" }],
      "brief": "Ends tomorrow. Spell out concretely what drops on downgrade to Free (grounded {{lostFeatures}} list from plan entitlements). Make subscribing one click.",
      "incentiveEnabled": false,
      "branches": [],
      "next": "urgency_today",
      "exit": false,
      "variants": [
        {
          "id": "A",
          "weight": 100,
          "subject": "Tomorrow you go back to Free, {{firstName}} — here's what pauses",
          "html": "<p>Hi {{firstName}},</p><p>Your trial ends {{trialEndsAt}}. Once it does, you drop to the Free plan and these {{recommendedPlan}} features pause:</p>{{lostFeatures}}<p>Keep all of it — add a card before tomorrow.</p><p><a href=\"{{checkoutUrl}}\">Subscribe to {{recommendedPlan}}</a></p>"
        }
      ]
    },
    {
      "id": "urgency_today",
      "label": "Day 14 — last chance today",
      "phase": "in_trial",
      "trigger": "trial_end",
      "anchor": "trial_end",
      "delayHours": 0,
      "conditions": [{ "field": "converted", "op": "is_false" }],
      "brief": "Final in-trial touch on the day the trial ends. Last-chance framing, single one-click subscribe CTA. After this the user lapses to Free and enters the post-trial win-back tail.",
      "incentiveEnabled": false,
      "branches": [],
      "next": "win_back_free",
      "exit": false,
      "variants": [
        {
          "id": "A",
          "weight": 100,
          "subject": "Last chance today, {{firstName}} — keep your Pro features",
          "html": "<p>Hi {{firstName}},</p><p>Your trial ends today. Add a card now to keep unlimited grading, shareable certificates, and full condition reports — no interruption.</p><p><a href=\"{{checkoutUrl}}\">Subscribe to {{recommendedPlan}} now</a></p>"
        }
      ]
    },
    {
      "id": "win_back_free",
      "label": "Win-back Day 16 — you're on Free now",
      "phase": "win_back",
      "trigger": "trial_expired",
      "anchor": "trial_end",
      "delayHours": 48,
      "conditions": [{ "field": "converted", "op": "is_false" }],
      "brief": "Trial lapsed to Free. Friendly, no guilt. Name the specific Pro features they used during the trial that are now paused (unlimited grading, shareable certificates, full condition reports) and lead with the outcome — buyer-trusted grades sell faster. One low-friction CTA to upgrade.",
      "incentiveEnabled": false,
      "branches": [],
      "next": "win_back_value",
      "exit": false,
      "variants": [
        {
          "id": "A",
          "weight": 100,
          "subject": "You're on Free now, {{firstName}} — here's what you're missing",
          "html": "<p>Hi {{firstName}},</p><p>Your trial wrapped up and you're back on the Free plan. The Pro features you used during your trial — unlimited grading, shareable certificates, and full condition reports — are paused.</p><p>Sellers using buyer-trusted grades move items faster and field fewer 'what condition is it really?' questions. Pick up right where you left off whenever you're ready.</p><p><a href=\"https://gradethread.com/pricing\">See what Pro unlocks</a></p>"
        }
      ]
    },
    {
      "id": "win_back_value",
      "label": "Win-back Day 20 — is it worth it?",
      "phase": "win_back",
      "trigger": "after_trial_end",
      "anchor": "trial_end",
      "delayHours": 144,
      "conditions": [{ "field": "converted", "op": "is_false" }],
      "brief": "Objection-handling. Tackle the price objection head-on with outcomes: one extra sale a month more than covers Pro; standardized grades cut returns and disputes; certificates build buyer trust. No incentive yet — earn the upgrade on value.",
      "incentiveEnabled": false,
      "branches": [],
      "next": "win_back_offer",
      "exit": false,
      "variants": [
        {
          "id": "A",
          "weight": 100,
          "subject": "Is GradeThread worth it, {{firstName}}? Here's the honest math",
          "html": "<p>Hi {{firstName}},</p><p>Fair question. Here's how Pro pays for itself:</p><ul><li><strong>One extra sale a month</strong> more than covers it — standardized grades help items sell faster and at better prices.</li><li><strong>Fewer returns and disputes</strong> — a clear, certified condition grade sets buyer expectations up front.</li><li><strong>Buyer trust</strong> — a shareable certificate signals you're a serious, transparent seller.</li></ul><p><a href=\"https://gradethread.com/pricing\">Upgrade to Pro</a></p>"
        }
      ]
    },
    {
      "id": "win_back_offer",
      "label": "Win-back Day 24 — incentive offer",
      "phase": "win_back",
      "trigger": "after_trial_end",
      "anchor": "trial_end",
      "delayHours": 240,
      "conditions": [{ "field": "converted", "op": "is_false" }],
      "brief": "Now sweeten it. Recap the value, then surface the conversion incentive (config-gated — only renders when the campaign incentive is enabled and the user hasn't converted). Make upgrading one click.",
      "incentiveEnabled": true,
      "branches": [],
      "next": "win_back_final",
      "exit": false,
      "variants": [
        {
          "id": "A",
          "weight": 100,
          "subject": "A little nudge to come back, {{firstName}}",
          "html": "<p>Hi {{firstName}},</p><p>You graded items, built certificates, and saw what standardized condition grading does for your listings. Here's a hand getting back to it.</p>{{incentive}}<p><a href=\"https://gradethread.com/pricing\">Upgrade to Pro</a></p>"
        }
      ]
    },
    {
      "id": "win_back_final",
      "label": "Win-back Day 28 — final, then exit",
      "phase": "win_back",
      "trigger": "after_trial_end",
      "anchor": "trial_end",
      "delayHours": 336,
      "conditions": [{ "field": "converted", "op": "is_false" }],
      "brief": "Last touch of the focused win-back. Strongest incentive with a clear deadline, then exit the journey — the user is handed back to the standard occasional newsletter (no more drip). Respectful sign-off.",
      "incentiveEnabled": true,
      "branches": [],
      "next": null,
      "exit": true,
      "variants": [
        {
          "id": "A",
          "weight": 100,
          "subject": "Last call, {{firstName}} — your offer expires soon",
          "html": "<p>Hi {{firstName}},</p><p>This is the last nudge from our trial series — your offer expires soon.</p>{{incentive}}<p>Whatever you decide, your past grades and certificates are safe, and we'll only send the occasional newsletter from here. Come back any time.</p><p><a href=\"https://gradethread.com/pricing\">Upgrade to Pro</a></p>"
        }
      ]
    }
  ]
}
$json$::jsonb
WHERE campaign = 'trial_conversion'
  AND graph -> 'steps' @> '[{"id": "ending_soon"}]'::jsonb
  AND NOT (graph -> 'steps' @> '[{"id": "recap"}]'::jsonb);

COMMIT;

-- self-record (US-1108): keeps the edge schema-version guard (US-778) in sync
-- regardless of how this migration is applied.
INSERT INTO public.applied_migrations (version) VALUES ('00270')
ON CONFLICT (version) DO NOTHING;


-- ════════════════════════════════════════════════════════════════════════════
-- 00271_drip_activation_sequence.sql
-- ════════════════════════════════════════════════════════════════════════════

-- US-939: Phase 1 in-trial ACTIVATION sequence (days 0–6).
--
-- The trial-conversion campaign graph (00255 → 00269 → 00270) carried a thin
-- early in-trial run: welcome (day 0) → a single "tips" touch (day 3) → the
-- Phase-2 conversion-push (recap, day 7+). This migration replaces that thin
-- early run with the full first-week activation sequence that gets a new
-- trialist to value fast, then hands off to the (unchanged) Phase-2 recap:
--
--   • Day 0 (enrollment + 0)    welcome          — warm welcome + grade-your-
--            first-item CTA (deep-links into /dashboard/submissions/new).
--   • Day 1 (enrollment + 24h)  day1_first_grade — first-grade nudge. Sends ONLY
--            while they have NOT graded yet (`gradesCount is_false`); once the
--            first grade exists the step is SKIPPED (not the journey).
--   • Day 2 (enrollment + 48h)  day2_value       — "how grading lifts resale
--            price" value email, gated on the first grade having happened
--            (`gradesCount gte 1`) — the first_grade event, expressed as state.
--   • Day 3 (enrollment + 72h)  day3_education   — accurate listing-management
--            education (deep-links into FlipDesk). Branch: a 3-day inactivity
--            nudge if the trialist has gone quiet (see below).
--   • Day 5 (enrollment + 120h) day5_social      — social-proof + a feature
--            highlight, then on to the Phase-2 recap (day 7).
--
--   • inactivity_nudge (enrollment + 96h) — fires ONLY when the trialist has had
--            no real activity for 3+ days (`daysSinceActive gte 3`, derived in
--            the engine from their latest grade/listing/sale, anchored to signup
--            for a never-active user). Reached via a branch off day3_education;
--            its `next` rejoins the main timeline at day5_social so the nudge is
--            INSERTED without breaking the sequence. The branch re-evaluates each
--            tick, so a reactivated user is routed straight to day5_social and
--            never sees it.
--
-- Every step gates on `converted = is_false`, so a conversion at ANY point skips
-- all further sends and the engine exits the journey instantly (routes/drip.ts).
-- Consent (US-911), suppression (US-914), CAN-SPAM unsubscribe and the frequency
-- cap are enforced universally at dispatch. CTAs deep-link into the exact next
-- action with UTM tracking (utm_source=drip…), and copy is personalized
-- ({{firstName}}, {{gradesCount}}) with safe fallbacks.
--
-- The Phase-2 / win-back tail (recap … win_back_final) is carried through
-- BYTE-IDENTICAL to 00270 — this migration only rewrites the early run.
--
-- Idempotent + non-clobbering: only the recognizable 00270-shape graph (has
-- `recap`, lacks `day1_first_grade`) is rewritten. Once the activation steps
-- exist — or an operator has edited the graph in the builder — this is a no-op.

BEGIN;

UPDATE public.drip_campaigns
SET graph = $json$
{
  "entryStepId": "welcome",
  "steps": [
    {
      "id": "welcome",
      "label": "Day 0 — welcome + grade your first item",
      "phase": "in_trial",
      "trigger": "trial_started",
      "anchor": "enrollment",
      "delayHours": 0,
      "conditions": [],
      "brief": "Warm welcome on signup. One clear CTA: upload your first garment and get a standardized condition grade in minutes. No card on file — reassure them the trial is free. Deep-link straight to the new-submission flow.",
      "incentiveEnabled": false,
      "branches": [],
      "next": "day1_first_grade",
      "exit": false,
      "variants": [
        {
          "id": "A",
          "weight": 100,
          "subject": "Welcome to GradeThread, {{firstName}} — let's grade your first item",
          "html": "<p>Hi {{firstName}},</p><p>Your free trial is live — no card needed. Upload a garment and get a standardized condition grade (and a shareable certificate) in minutes.</p><p><a href=\"https://gradethread.com/dashboard/submissions/new?utm_source=drip&utm_medium=email&utm_campaign=trial_conversion&utm_content=welcome\">Grade your first item</a></p>"
        }
      ]
    },
    {
      "id": "day1_first_grade",
      "label": "Day 1 — grade your first item (no grade yet)",
      "phase": "in_trial",
      "trigger": "day1_no_first_grade",
      "anchor": "enrollment",
      "delayHours": 24,
      "conditions": [
        { "field": "converted", "op": "is_false" },
        { "field": "gradesCount", "op": "is_false" }
      ],
      "brief": "Gentle day-1 nudge for a trialist who hasn't graded anything yet. No guilt — make the first grade feel effortless (four photos: front, back, label, a detail) and show the payoff. Skipped automatically once they've graded their first item. One low-friction CTA into the new-submission flow.",
      "incentiveEnabled": false,
      "branches": [],
      "next": "day2_value",
      "exit": false,
      "variants": [
        {
          "id": "A",
          "weight": 100,
          "subject": "{{firstName}}, your first grade takes about 5 minutes",
          "html": "<p>Hi {{firstName}},</p><p>Ready to see GradeThread in action? Snap four photos — front, back, label, and a detail — and you'll get a standardized 1.0–10.0 condition grade plus a shareable certificate buyers trust.</p><p><a href=\"https://gradethread.com/dashboard/submissions/new?utm_source=drip&utm_medium=email&utm_campaign=trial_conversion&utm_content=day1_first_grade\">Grade your first item</a></p>"
        }
      ]
    },
    {
      "id": "day2_value",
      "label": "Day 2 — how grading lifts resale price",
      "phase": "in_trial",
      "trigger": "first_grade",
      "anchor": "enrollment",
      "delayHours": 48,
      "conditions": [
        { "field": "converted", "op": "is_false" },
        { "field": "gradesCount", "op": "gte", "value": 1 }
      ],
      "brief": "Value email triggered by their first grade (only sends once gradesCount >= 1). Connect grading to outcomes grounded in real platform capabilities: a standardized, certified condition grade sets buyer expectations, builds trust, and helps items sell faster and at better prices. Reference how many they've graded so far. CTA: grade another item.",
      "incentiveEnabled": false,
      "branches": [],
      "next": "day3_education",
      "exit": false,
      "variants": [
        {
          "id": "A",
          "weight": 100,
          "subject": "Nice work, {{firstName}} — here's what a grade does for your price",
          "html": "<p>Hi {{firstName}},</p><p>You've graded <strong>{{gradesCount}}</strong> item(s) so far — here's why that matters. A standardized condition grade and a shareable certificate set clear buyer expectations up front: that's how sellers build trust, cut 'what condition is it really?' questions, and move items faster.</p><p><a href=\"https://gradethread.com/dashboard/submissions/new?utm_source=drip&utm_medium=email&utm_campaign=trial_conversion&utm_content=day2_value\">Grade another item</a></p>"
        }
      ]
    },
    {
      "id": "day3_education",
      "label": "Day 3 — accurate listing management",
      "phase": "in_trial",
      "trigger": "day3_education",
      "anchor": "enrollment",
      "delayHours": 72,
      "conditions": [{ "field": "converted", "op": "is_false" }],
      "brief": "Education on accurate listing management in FlipDesk: turn a graded item into a clean, accurate listing — measurements, condition grade, photos — so buyers know exactly what they're getting. Grounded only in real FlipDesk capabilities. CTA into FlipDesk. Branch: if the trialist has been inactive for 3+ days, route to the inactivity nudge first.",
      "incentiveEnabled": false,
      "branches": [
        { "conditions": [{ "field": "daysSinceActive", "op": "gte", "value": 3 }], "targetStepId": "inactivity_nudge" }
      ],
      "next": "day5_social",
      "exit": false,
      "variants": [
        {
          "id": "A",
          "weight": 100,
          "subject": "{{firstName}}, turn your grades into accurate listings",
          "html": "<p>Hi {{firstName}},</p><p>A grade is most powerful inside a listing. In FlipDesk you can carry the condition grade, measurements, and photos straight into an accurate listing — so buyers know exactly what they're getting and you field fewer questions and returns.</p><p><a href=\"https://gradethread.com/dashboard/flipdesk?utm_source=drip&utm_medium=email&utm_campaign=trial_conversion&utm_content=day3_education\">Manage your listings in FlipDesk</a></p>"
        }
      ]
    },
    {
      "id": "inactivity_nudge",
      "label": "Inactivity — no activity for 3 days",
      "phase": "in_trial",
      "trigger": "inactivity_3d",
      "anchor": "enrollment",
      "delayHours": 96,
      "conditions": [
        { "field": "converted", "op": "is_false" },
        { "field": "daysSinceActive", "op": "gte", "value": 3 }
      ],
      "brief": "Re-engagement for a trialist who's gone quiet (no grade/listing/sale for 3+ days). Friendly, no pressure — remind them the trial clock is running and that the first grade takes minutes. One low-friction CTA into the new-submission flow. Inserted between day 3 and day 5 without breaking the main sequence.",
      "incentiveEnabled": false,
      "branches": [],
      "next": "day5_social",
      "exit": false,
      "variants": [
        {
          "id": "A",
          "weight": 100,
          "subject": "Still there, {{firstName}}? Your trial's waiting",
          "html": "<p>Hi {{firstName}},</p><p>We noticed you haven't been back in a few days — no worries. Your free trial is still running, and grading an item takes about five minutes: four photos in, a standardized condition grade and shareable certificate out.</p><p><a href=\"https://gradethread.com/dashboard/submissions/new?utm_source=drip&utm_medium=email&utm_campaign=trial_conversion&utm_content=inactivity_nudge\">Pick up where you left off</a></p>"
        }
      ]
    },
    {
      "id": "day5_social",
      "label": "Day 5 — social proof + feature highlight",
      "phase": "in_trial",
      "trigger": "day5_social_proof",
      "anchor": "enrollment",
      "delayHours": 120,
      "conditions": [{ "field": "converted", "op": "is_false" }],
      "brief": "Social-proof + a single feature highlight. Lead with why resellers trust standardized grading (consistent, transparent condition buyers can verify), then spotlight ONE high-value capability they may not have tried — the shareable, public condition certificate. Grounded only in real platform capabilities (no invented stats or testimonials). CTA to grade or view a certificate.",
      "incentiveEnabled": false,
      "branches": [],
      "next": "recap",
      "exit": false,
      "variants": [
        {
          "id": "A",
          "weight": 100,
          "subject": "Why resellers lead with a GradeThread grade, {{firstName}}",
          "html": "<p>Hi {{firstName}},</p><p>Resellers use GradeThread because a standardized, transparent condition grade is something buyers can actually verify — no more guessing from a few photos. One feature worth a look: every grade comes with a <strong>public, shareable certificate</strong> you can drop into any listing.</p><p><a href=\"https://gradethread.com/dashboard/submissions/new?utm_source=drip&utm_medium=email&utm_campaign=trial_conversion&utm_content=day5_social\">Grade an item & share its certificate</a></p>"
        }
      ]
    },
    {
      "id": "recap",
      "label": "Day 7 — your trial so far (recap + ROI)",
      "phase": "in_trial",
      "trigger": "midtrial_recap",
      "anchor": "enrollment",
      "delayHours": 168,
      "conditions": [
        { "field": "converted", "op": "is_false" },
        { "field": "totalActivity", "op": "gt", "value": 0 }
      ],
      "brief": "Mid-trial personalized recap. Reflect their REAL numbers (grades, listings, sales, certificates) and frame the ROI: standardized grades sell faster, build buyer trust, cut returns. Primary CTA: subscribe so they keep it all. Only sent to users with activity; the zero-activity branch sends a re-activation variant instead.",
      "incentiveEnabled": false,
      "branches": [
        { "conditions": [{ "field": "totalActivity", "op": "is_false" }], "targetStepId": "recap_reactivate" }
      ],
      "next": "feature_deepdive",
      "exit": false,
      "variants": [
        {
          "id": "A",
          "weight": 100,
          "subject": "{{firstName}}, here's your GradeThread trial so far",
          "html": "<p>Hi {{firstName}},</p><p>You're a week into your trial — here's what you've done:</p><ul><li><strong>{{gradesCount}}</strong> items graded</li><li><strong>{{certificatesCount}}</strong> shareable certificates</li><li><strong>{{listingsCount}}</strong> listings</li><li><strong>{{salesCount}}</strong> sales</li></ul><p>Sellers who lead with buyer-trusted grades move items faster and field fewer 'what condition is it really?' questions. Keep that momentum — subscribe to {{recommendedPlan}} before your trial ends.</p><p><a href=\"{{checkoutUrl}}\">Subscribe to {{recommendedPlan}}</a></p>"
        }
      ]
    },
    {
      "id": "recap_reactivate",
      "label": "Day 7 — re-activation (no activity yet)",
      "phase": "in_trial",
      "trigger": "midtrial_reactivate",
      "anchor": "enrollment",
      "delayHours": 168,
      "conditions": [{ "field": "converted", "op": "is_false" }],
      "brief": "Re-activation for a trialist who hasn't done anything yet. No guilt — make the very first grade feel effortless and show the payoff. One low-friction CTA to grade a first item. Keep the subscribe option secondary.",
      "incentiveEnabled": false,
      "branches": [],
      "next": "feature_deepdive",
      "exit": false,
      "variants": [
        {
          "id": "A",
          "weight": 100,
          "subject": "{{firstName}}, grade your first item in under 5 minutes",
          "html": "<p>Hi {{firstName}},</p><p>Your trial is running and you haven't graded anything yet — no worries, it takes minutes. Snap four photos (front, back, label, a detail) and get a standardized condition grade plus a shareable certificate buyers trust.</p><p><a href=\"https://gradethread.com/dashboard\">Grade your first item</a></p><p>Already convinced? <a href=\"{{checkoutUrl}}\">Subscribe to {{recommendedPlan}}</a>.</p>"
        }
      ]
    },
    {
      "id": "feature_deepdive",
      "label": "Day 10 — shareable certificate deep-dive",
      "phase": "in_trial",
      "trigger": "feature_deepdive",
      "anchor": "enrollment",
      "delayHours": 240,
      "conditions": [
        { "field": "converted", "op": "is_false" },
        { "field": "certificatesCount", "op": "is_false" }
      ],
      "brief": "Deep-dive on a high-value feature they haven't used yet: the shareable condition certificate. Show the outcome — a public, verifiable certificate buyers trust. Skipped (branch) for anyone who already created a certificate. CTA to subscribe so the certificates stay live.",
      "incentiveEnabled": false,
      "branches": [
        { "conditions": [{ "field": "certificatesCount", "op": "gt", "value": 0 }], "targetStepId": "urgency_2d" }
      ],
      "next": "urgency_2d",
      "exit": false,
      "variants": [
        {
          "id": "A",
          "weight": 100,
          "subject": "{{firstName}}, the one feature buyers love most",
          "html": "<p>Hi {{firstName}},</p><p>You've graded items — but have you shared a <strong>certificate</strong> yet? Each grade comes with a public, verifiable condition certificate you can drop into any listing. It's the single fastest way to turn 'what condition is it?' into a confident buy.</p><p><a href=\"https://gradethread.com/dashboard\">Create a certificate</a></p><p>Keep your certificates live after the trial — <a href=\"{{checkoutUrl}}\">subscribe to {{recommendedPlan}}</a>.</p>"
        }
      ]
    },
    {
      "id": "urgency_2d",
      "label": "Day 12 — trial ends in 2 days",
      "phase": "in_trial",
      "trigger": "trial_end_minus_2d",
      "anchor": "trial_end",
      "delayHours": -48,
      "conditions": [{ "field": "converted", "op": "is_false" }],
      "brief": "Urgency, anchored to the ACTUAL trial end. Two days left. Clear, friendly nudge: add a card now to keep Pro. One-click subscribe CTA.",
      "incentiveEnabled": false,
      "branches": [],
      "next": "urgency_1d",
      "exit": false,
      "variants": [
        {
          "id": "A",
          "weight": 100,
          "subject": "Your trial ends in 2 days, {{firstName}}",
          "html": "<p>Hi {{firstName}},</p><p>Your trial ends {{trialEndsAt}} — that's two days away. Add a card now to keep grading, certificates, and your reports without interruption.</p><p><a href=\"{{checkoutUrl}}\">Subscribe to {{recommendedPlan}}</a></p>"
        }
      ]
    },
    {
      "id": "urgency_1d",
      "label": "Day 13 — ends tomorrow / what you'll lose",
      "phase": "in_trial",
      "trigger": "trial_end_minus_1d",
      "anchor": "trial_end",
      "delayHours": -24,
      "conditions": [{ "field": "converted", "op": "is_false" }],
      "brief": "Ends tomorrow. Spell out concretely what drops on downgrade to Free (grounded {{lostFeatures}} list from plan entitlements). Make subscribing one click.",
      "incentiveEnabled": false,
      "branches": [],
      "next": "urgency_today",
      "exit": false,
      "variants": [
        {
          "id": "A",
          "weight": 100,
          "subject": "Tomorrow you go back to Free, {{firstName}} — here's what pauses",
          "html": "<p>Hi {{firstName}},</p><p>Your trial ends {{trialEndsAt}}. Once it does, you drop to the Free plan and these {{recommendedPlan}} features pause:</p>{{lostFeatures}}<p>Keep all of it — add a card before tomorrow.</p><p><a href=\"{{checkoutUrl}}\">Subscribe to {{recommendedPlan}}</a></p>"
        }
      ]
    },
    {
      "id": "urgency_today",
      "label": "Day 14 — last chance today",
      "phase": "in_trial",
      "trigger": "trial_end",
      "anchor": "trial_end",
      "delayHours": 0,
      "conditions": [{ "field": "converted", "op": "is_false" }],
      "brief": "Final in-trial touch on the day the trial ends. Last-chance framing, single one-click subscribe CTA. After this the user lapses to Free and enters the post-trial win-back tail.",
      "incentiveEnabled": false,
      "branches": [],
      "next": "win_back_free",
      "exit": false,
      "variants": [
        {
          "id": "A",
          "weight": 100,
          "subject": "Last chance today, {{firstName}} — keep your Pro features",
          "html": "<p>Hi {{firstName}},</p><p>Your trial ends today. Add a card now to keep unlimited grading, shareable certificates, and full condition reports — no interruption.</p><p><a href=\"{{checkoutUrl}}\">Subscribe to {{recommendedPlan}} now</a></p>"
        }
      ]
    },
    {
      "id": "win_back_free",
      "label": "Win-back Day 16 — you're on Free now",
      "phase": "win_back",
      "trigger": "trial_expired",
      "anchor": "trial_end",
      "delayHours": 48,
      "conditions": [{ "field": "converted", "op": "is_false" }],
      "brief": "Trial lapsed to Free. Friendly, no guilt. Name the specific Pro features they used during the trial that are now paused (unlimited grading, shareable certificates, full condition reports) and lead with the outcome — buyer-trusted grades sell faster. One low-friction CTA to upgrade.",
      "incentiveEnabled": false,
      "branches": [],
      "next": "win_back_value",
      "exit": false,
      "variants": [
        {
          "id": "A",
          "weight": 100,
          "subject": "You're on Free now, {{firstName}} — here's what you're missing",
          "html": "<p>Hi {{firstName}},</p><p>Your trial wrapped up and you're back on the Free plan. The Pro features you used during your trial — unlimited grading, shareable certificates, and full condition reports — are paused.</p><p>Sellers using buyer-trusted grades move items faster and field fewer 'what condition is it really?' questions. Pick up right where you left off whenever you're ready.</p><p><a href=\"https://gradethread.com/pricing\">See what Pro unlocks</a></p>"
        }
      ]
    },
    {
      "id": "win_back_value",
      "label": "Win-back Day 20 — is it worth it?",
      "phase": "win_back",
      "trigger": "after_trial_end",
      "anchor": "trial_end",
      "delayHours": 144,
      "conditions": [{ "field": "converted", "op": "is_false" }],
      "brief": "Objection-handling. Tackle the price objection head-on with outcomes: one extra sale a month more than covers Pro; standardized grades cut returns and disputes; certificates build buyer trust. No incentive yet — earn the upgrade on value.",
      "incentiveEnabled": false,
      "branches": [],
      "next": "win_back_offer",
      "exit": false,
      "variants": [
        {
          "id": "A",
          "weight": 100,
          "subject": "Is GradeThread worth it, {{firstName}}? Here's the honest math",
          "html": "<p>Hi {{firstName}},</p><p>Fair question. Here's how Pro pays for itself:</p><ul><li><strong>One extra sale a month</strong> more than covers it — standardized grades help items sell faster and at better prices.</li><li><strong>Fewer returns and disputes</strong> — a clear, certified condition grade sets buyer expectations up front.</li><li><strong>Buyer trust</strong> — a shareable certificate signals you're a serious, transparent seller.</li></ul><p><a href=\"https://gradethread.com/pricing\">Upgrade to Pro</a></p>"
        }
      ]
    },
    {
      "id": "win_back_offer",
      "label": "Win-back Day 24 — incentive offer",
      "phase": "win_back",
      "trigger": "after_trial_end",
      "anchor": "trial_end",
      "delayHours": 240,
      "conditions": [{ "field": "converted", "op": "is_false" }],
      "brief": "Now sweeten it. Recap the value, then surface the conversion incentive (config-gated — only renders when the campaign incentive is enabled and the user hasn't converted). Make upgrading one click.",
      "incentiveEnabled": true,
      "branches": [],
      "next": "win_back_final",
      "exit": false,
      "variants": [
        {
          "id": "A",
          "weight": 100,
          "subject": "A little nudge to come back, {{firstName}}",
          "html": "<p>Hi {{firstName}},</p><p>You graded items, built certificates, and saw what standardized condition grading does for your listings. Here's a hand getting back to it.</p>{{incentive}}<p><a href=\"https://gradethread.com/pricing\">Upgrade to Pro</a></p>"
        }
      ]
    },
    {
      "id": "win_back_final",
      "label": "Win-back Day 28 — final, then exit",
      "phase": "win_back",
      "trigger": "after_trial_end",
      "anchor": "trial_end",
      "delayHours": 336,
      "conditions": [{ "field": "converted", "op": "is_false" }],
      "brief": "Last touch of the focused win-back. Strongest incentive with a clear deadline, then exit the journey — the user is handed back to the standard occasional newsletter (no more drip). Respectful sign-off.",
      "incentiveEnabled": true,
      "branches": [],
      "next": null,
      "exit": true,
      "variants": [
        {
          "id": "A",
          "weight": 100,
          "subject": "Last call, {{firstName}} — your offer expires soon",
          "html": "<p>Hi {{firstName}},</p><p>This is the last nudge from our trial series — your offer expires soon.</p>{{incentive}}<p>Whatever you decide, your past grades and certificates are safe, and we'll only send the occasional newsletter from here. Come back any time.</p><p><a href=\"https://gradethread.com/pricing\">Upgrade to Pro</a></p>"
        }
      ]
    }
  ]
}
$json$::jsonb
WHERE campaign = 'trial_conversion'
  AND graph -> 'steps' @> '[{"id": "recap"}]'::jsonb
  AND NOT (graph -> 'steps' @> '[{"id": "day1_first_grade"}]'::jsonb);

COMMIT;

-- self-record (US-1108): keeps the edge schema-version guard (US-778) in sync
-- regardless of how this migration is applied.
INSERT INTO public.applied_migrations (version) VALUES ('00271')
ON CONFLICT (version) DO NOTHING;


-- ════════════════════════════════════════════════════════════════════════════
-- 00272_drip_send_tracking.sql
-- ════════════════════════════════════════════════════════════════════════════

-- US-938: Durable per-step drip send — idempotency key + skip ledger.
--
-- The trial-conversion drip engine (routes/drip.ts) now routes every step send
-- through the durable email_deliveries outbox (US-498/US-925) with the open/click
-- tracking rewriter (US-913) and a pre-send QA gate (US-924), and gates each send
-- on consent (US-911), suppression (US-914) and a frequency cap before dispatch.
-- This migration adds the two columns/constraints that make that durable +
-- measurable without a second table:
--
--   • a UNIQUE (enrollment_id, step) index so the engine UPSERTS exactly ONE row
--     per (enrollment, step) — a re-tick / catch-up batch can never double-send
--     or double-record a step (AC4 idempotency).
--   • `skip_reason` — why a send did NOT go out (opted_out, suppressed,
--     frequency_capped, qa_failed). NULL on an actually-sent row, so the funnel
--     separates "skipped with reason" from "delivered" off the existing grain.
--
-- drip_sends stays service-role only (written by the edge engine). The open/click
-- tracking endpoints (routes/drip-tracking.ts) stamp opened_at/clicked_at on a row
-- identified by its unguessable id (the send token) — no client-facing access.

BEGIN;

-- Idempotency grain: one row per (enrollment, step).
create unique index if not exists drip_sends_enrollment_step_uniq
  on public.drip_sends (enrollment_id, step);

-- Why a step was skipped instead of sent (NULL on a delivered row).
alter table public.drip_sends
  add column if not exists skip_reason text;

create index if not exists drip_sends_skip_reason_idx
  on public.drip_sends (campaign, skip_reason)
  where skip_reason is not null;

comment on column public.drip_sends.skip_reason is
  'US-938: why this (enrollment, step) was skipped (opted_out/suppressed/frequency_capped/qa_failed); NULL when delivered.';

COMMIT;

-- self-record (US-1108): keeps the edge schema-version guard (US-778) in sync
-- regardless of how this migration is applied.
INSERT INTO public.applied_migrations (version) VALUES ('00272')
ON CONFLICT (version) DO NOTHING;


-- ════════════════════════════════════════════════════════════════════════════
-- 00273_drip_conversion_attribution.sql
-- ════════════════════════════════════════════════════════════════════════════

-- US-937: Conversion attribution & goal tracking — first/last-touch + ROI fields.
--
-- The trial-conversion drip already records ONE drip_attributions row per
-- converted enrollment (00253). This adds the columns that let a conversion be
-- attributed to the drip step/email that drove it and that power the ROI rollup
-- (US-946):
--
--   • attribution_model — last_touch | first_touch | organic. A converter who
--     never opened/clicked a drip email is 'organic' (AC4); otherwise the
--     conversion is credited to the last email they engaged with (last-touch).
--   • first_touch_step / last_touch_step — the first & last drip steps the user
--     engaged with before converting (NULL for organic). `step` (00253) stays the
--     canonical attributed step (= last_touch_step) so the US-946 funnel's
--     per-step conversion count is unchanged.
--   • last_touch_at — when the last-touch email was engaged.
--   • days_to_convert — trial-clock days from enrollment/trial-start to
--     conversion (denormalized alongside the RPC's live median for per-row ROI).
--
-- The webhook (customer.subscription.created) now fills mrr_cents +
-- stripe_subscription_id + stripe_reconciled from the live Stripe subscription,
-- so the existing rollup's attributed-MRR / reconciliation figures become real.
-- drip_attributions stays service-role only (written by the edge engine/webhook).

BEGIN;

alter table public.drip_attributions
  add column if not exists attribution_model text not null default 'last_touch',
  add column if not exists first_touch_step int,
  add column if not exists last_touch_step  int,
  add column if not exists last_touch_at    timestamptz,
  add column if not exists days_to_convert  numeric;

-- Constrain the model vocabulary (idempotent — skip if already present).
do $$ begin
  alter table public.drip_attributions
    add constraint drip_attributions_model_chk
    check (attribution_model in ('last_touch', 'first_touch', 'organic'));
exception
  when duplicate_object then null;
end $$;

comment on column public.drip_attributions.attribution_model is
  'US-937: last_touch | first_touch | organic (organic = converted without opening/clicking any drip email).';
comment on column public.drip_attributions.first_touch_step is
  'US-937: first drip step the converter engaged with before converting (NULL when organic).';
comment on column public.drip_attributions.last_touch_step is
  'US-937: last drip step the converter engaged with (= step, the canonical credit); NULL when organic.';
comment on column public.drip_attributions.days_to_convert is
  'US-937: trial-clock days from enrollment/trial-start to conversion (denormalized for ROI rows).';

COMMIT;

-- self-record (US-1108): keeps the edge schema-version guard (US-778) in sync
-- regardless of how this migration is applied.
INSERT INTO public.applied_migrations (version) VALUES ('00273')
ON CONFLICT (version) DO NOTHING;


-- ════════════════════════════════════════════════════════════════════════════
-- 00274_drip_enrollment_uniqueness.sql
-- ════════════════════════════════════════════════════════════════════════════

-- US-936: Enrollment & state-machine engine — durable once-per-campaign guard.
--
-- The trial-conversion drip engine (routes/drip.ts) is the durable per-user
-- enrollment state machine this story specifies: drip_enrollments holds one row
-- per user per campaign run, advanced by the pure planner (lib/drip-graph.ts
-- planTick) against the persisted step-graph, with exit_reason recording the
-- terminal state (converted/unsubscribed/suppressed/completed) and
-- next_evaluation_at driving the bounded, resumable tick (00267). Per-step
-- idempotency is already DB-enforced by the UNIQUE (enrollment_id, step) index
-- on drip_sends (00272).
--
-- The one durability guarantee that was enforced only in application code
-- (enrollNewTrialists filters out users with an existing enrollment) is the
-- "a user enrolls once per campaign" invariant from AC1. This migration makes it
-- a DB-level constraint so a concurrent/retried enroll path can never create a
-- second enrollment for the same (user, campaign) — the engine's enroll insert
-- now upserts ON CONFLICT against this index, turning a duplicate into a no-op
-- instead of a failure.
--
-- Idempotent: CREATE UNIQUE INDEX IF NOT EXISTS. Existing rows already satisfy
-- the invariant (the app-level filter has always prevented duplicates), so the
-- index builds cleanly on current data.

BEGIN;

create unique index if not exists drip_enrollments_user_campaign_uniq
  on public.drip_enrollments (user_id, campaign);

comment on index public.drip_enrollments_user_campaign_uniq is
  'US-936: a user enrolls at most once per campaign (entry-trigger idempotency).';

COMMIT;

-- self-record (US-1108): keeps the edge schema-version guard (US-778) in sync
-- regardless of how this migration is applied.
INSERT INTO public.applied_migrations (version) VALUES ('00274')
ON CONFLICT (version) DO NOTHING;


-- ════════════════════════════════════════════════════════════════════════════
-- 00275_drip_campaign_goal_event.sql
-- ════════════════════════════════════════════════════════════════════════════

-- US-935: make the drip campaign's GOAL a first-class, declared property.
--
-- The branching drip data model (drip_campaigns, 00255) embeds the step graph in
-- `graph` jsonb and gates the engine on `status` + `feature_flag_key`. What it
-- did NOT carry was an explicit declaration of the campaign's conversion GOAL and
-- its target AUDIENCE — the goal (customer.subscription.created → exit the whole
-- journey) was hardcoded in the engine (lib/drip-conversion.ts) rather than
-- declared on the row. This migration adds those two declarative columns so the
-- data model is self-describing (AC1/AC3): a campaign now DECLARES its
-- goal_event, and reaching that goal is what exits the campaign (the engine
-- already short-circuits a converted enrollment).
--
-- Additive + idempotent: new columns are nullable / defaulted, so the live engine
-- and admin builder keep working unchanged; admin reads surface them.
--
-- NOTE on US-929: there is no separate email_journeys/email_journey_steps table —
-- US-929's linear "three series" (welcome / win-back / trial) were never built as
-- their own engine; this branching engine subsumes them. welcome + win-back are
-- PHASES of the seeded `trial_conversion` campaign (graph phase = in_trial |
-- win_back), so there is nothing to migrate FROM — drip_campaigns is the engine.

BEGIN;

ALTER TABLE public.drip_campaigns
  -- The conversion event whose arrival exits the whole campaign (first-class
  -- goal, AC3). Defaults to the trial→paid conversion the engine watches.
  ADD COLUMN IF NOT EXISTS goal_event text NOT NULL DEFAULT 'subscription_created',
  -- Free-text descriptor of who the campaign targets (e.g. 'trial_no_card').
  -- Documentation/admin-facing; entry filtering still lives in the engine.
  ADD COLUMN IF NOT EXISTS audience text;

COMMENT ON COLUMN public.drip_campaigns.goal_event IS
  'US-935: the conversion event that exits this campaign (e.g. subscription_created).';
COMMENT ON COLUMN public.drip_campaigns.audience IS
  'US-935: human descriptor of the campaign audience (e.g. trial_no_card).';

-- Stamp the seeded trial-conversion campaign's audience (goal_event already
-- defaults correctly). Only touch the row if its audience is still unset so a
-- re-run / operator edit is never clobbered.
UPDATE public.drip_campaigns
   SET audience = 'trial_no_card'
 WHERE campaign = 'trial_conversion'
   AND audience IS NULL;

COMMIT;

-- US-1108: self-record this migration's version so the edge schema-version
-- guard (US-778) stays in sync regardless of apply method.
INSERT INTO public.applied_migrations (version) VALUES ('00275')
ON CONFLICT DO NOTHING;


-- ════════════════════════════════════════════════════════════════════════════
-- 00276_marketing_send_coordination.sql
-- ════════════════════════════════════════════════════════════════════════════

-- US-934: marketing frequency cap & cross-program send coordination.
--
-- A unified, per-recipient ledger of marketing emails ACTUALLY sent, so the
-- coordinator (lib/marketing-coordinator.ts) can enforce a per-recipient daily
-- frequency cap ACROSS all marketing programs (trial drip, journeys, weekly
-- newsletter, win-back) — not per-program. Every marketing send writes one row
-- here; the coordinator counts rows since the recipient's local midnight to
-- decide send vs. defer.
--
-- Service-role only: RLS enabled with an explicit `revoke all from anon,
-- authenticated` and zero policies by design — written + read ONLY by the edge
-- marketing coordinator via the service-role client; the SPA never touches it.
-- owner_user_id (NOT user_id) so the rls-guard does not classify it as
-- user-owned tenant data — it is an operational send ledger keyed by recipient.
--
-- Additive + idempotent.

BEGIN;

CREATE TABLE IF NOT EXISTS public.marketing_send_log (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  recipient     text NOT NULL,
  source        text NOT NULL,
  category      text,
  owner_user_id uuid REFERENCES public.users(id) ON DELETE SET NULL,
  sent_at       timestamptz NOT NULL DEFAULT now(),
  created_at    timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.marketing_send_log IS
  'US-934: unified per-recipient marketing-email send ledger driving the '
  'cross-program frequency cap. Service-role only.';

-- The cap query is "count by recipient since a window start" — index it.
CREATE INDEX IF NOT EXISTS idx_marketing_send_log_recipient_sent
  ON public.marketing_send_log (recipient, sent_at DESC);

ALTER TABLE public.marketing_send_log ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.marketing_send_log FROM anon, authenticated;

-- ── Seed the tunable coordinator settings into the registry (US-884) ────────
-- `on conflict do nothing` so an operator override applied before a re-run is
-- never clobbered.
INSERT INTO public.system_settings (key, value, value_type, default_value, description, category)
VALUES
  (
    'marketing_frequency_cap_per_day',
    '1'::jsonb, 'number', '1'::jsonb,
    'US-934: max marketing emails per recipient per day across ALL programs (drip, journeys, newsletter, win-back).',
    'marketing'
  ),
  (
    'marketing_quiet_hours',
    '{"enabled": true, "startHour": 21, "endHour": 8, "timezone": "America/Chicago"}'::jsonb,
    'json',
    '{"enabled": true, "startHour": 21, "endHour": 8, "timezone": "America/Chicago"}'::jsonb,
    'US-934: no marketing sends during these local quiet hours (24h clock; window may wrap midnight).',
    'marketing'
  )
ON CONFLICT (key) DO NOTHING;

COMMIT;

-- US-1108: self-record this migration's version so the edge schema-version
-- guard (US-778) stays in sync regardless of apply method.
INSERT INTO public.applied_migrations (version) VALUES ('00276')
ON CONFLICT (version) DO NOTHING;


-- ════════════════════════════════════════════════════════════════════════════
-- 00277_user_events.sql
-- ════════════════════════════════════════════════════════════════════════════

-- US-932: internal behavioral event stream (trigger substrate).
--
-- Server-side PostHog (lib/posthog.ts) only fires OUT to analytics — there is no
-- internal store the drip / journey trigger engine (US-933, lib/drip-trigger.ts)
-- can query to decide "has first_grade happened since enrolled_at?". This is that
-- store: a thin, append-only log of the lifecycle actions the engine triggers on.
--
-- Service-role only: RLS enabled with an explicit `revoke all from anon,
-- authenticated` and ZERO policies by design. It is written + read ONLY by the
-- edge via the service-role client (lib/user-events.ts); the SPA never touches it
-- (it carries no client-facing data — analytics, not tenant content). The
-- rls-guard auto-discovers it via its user_id column and is satisfied by the
-- SERVICE_ROLE_ONLY classification in rls-guard_test.ts.
--
-- Additive + idempotent.

BEGIN;

-- ── Event log ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.user_events (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  event_key   text NOT NULL,
  properties  jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  -- Nullable stable key for first-occurrence / once-only events (e.g.
  -- 'first_grade:<uid>'). UNIQUE so a re-emit is a no-op; plain (repeatable)
  -- events leave it NULL — Postgres treats each NULL as distinct, so they are
  -- never deduped.
  dedupe_key  text UNIQUE,
  created_at  timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.user_events IS
  'US-932: append-only internal behavioral event stream the drip/journey trigger '
  'engine queries. Service-role only — never client-exposed.';

-- The hot query is "events of key K for user U, most-recent first" (the trigger
-- snapshot loads latest occurrence per key per user).
CREATE INDEX IF NOT EXISTS idx_user_events_user_key_time
  ON public.user_events (user_id, event_key, occurred_at DESC);

ALTER TABLE public.user_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.user_events FROM anon, authenticated;

-- ── Derived recency on users ─────────────────────────────────────────────────
-- A cheap, denormalized "last_active_at" maintained by lib/user-events.ts from
-- activity events (app_open / grade / listing / sale) so inactivity triggers
-- don't have to join across grade_reports/listings/sales every tick. Exposed to
-- the segment + trigger field allowlists (segment-predicates.ts).
ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS last_active_at timestamptz;

COMMENT ON COLUMN public.users.last_active_at IS
  'US-932: most-recent activity timestamp (signup/app_open/grade/listing/sale), '
  'maintained forward-only by lib/user-events.ts for cheap inactivity triggers.';

-- ── signup emission (DB-side) ────────────────────────────────────────────────
-- Signup happens via Supabase Auth (client-side) → the handle_new_user trigger
-- creates the profile row; there is NO edge action site to call emitEvent() from.
-- So the signup event is emitted here, AFTER the users row exists (an event row
-- FK-references it). Exception-guarded: an analytics write can never fail signup.
CREATE OR REPLACE FUNCTION public.emit_signup_event()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  BEGIN
    INSERT INTO public.user_events (user_id, event_key, properties, occurred_at, dedupe_key)
    VALUES (NEW.id, 'signup', '{}'::jsonb, COALESCE(NEW.created_at, now()), 'signup:' || NEW.id)
    ON CONFLICT (dedupe_key) DO NOTHING;
    -- A brand-new user is active now; seed the recency signal forward-only.
    UPDATE public.users
      SET last_active_at = COALESCE(NEW.created_at, now())
      WHERE id = NEW.id AND last_active_at IS NULL;
  EXCEPTION WHEN OTHERS THEN
    -- swallow — never block account creation on the event stream
    NULL;
  END;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_emit_signup_event ON public.users;
CREATE TRIGGER trg_emit_signup_event
  AFTER INSERT ON public.users
  FOR EACH ROW EXECUTE FUNCTION public.emit_signup_event();

-- ── Backfill ─────────────────────────────────────────────────────────────────
-- Seed first-occurrence lifecycle timestamps for EXISTING users so current
-- trialists enroll with correct history. Idempotent via dedupe_key.

-- signup ← users.created_at
INSERT INTO public.user_events (user_id, event_key, properties, occurred_at, dedupe_key)
SELECT u.id, 'signup', '{"backfilled": true}'::jsonb, u.created_at, 'signup:' || u.id
FROM public.users u
ON CONFLICT (dedupe_key) DO NOTHING;

-- first_grade ← earliest grade_reports.created_at per user. grade_reports has no
-- user_id of its own — ownership flows through submissions.user_id.
INSERT INTO public.user_events (user_id, event_key, properties, occurred_at, dedupe_key)
SELECT s.user_id, 'first_grade', '{"backfilled": true}'::jsonb,
       min(gr.created_at), 'first_grade:' || s.user_id
FROM public.grade_reports gr
JOIN public.submissions s ON s.id = gr.submission_id
WHERE s.user_id IS NOT NULL
GROUP BY s.user_id
ON CONFLICT (dedupe_key) DO NOTHING;

-- first_listing ← earliest listings.created_at per user
INSERT INTO public.user_events (user_id, event_key, properties, occurred_at, dedupe_key)
SELECT l.user_id, 'first_listing', '{"backfilled": true}'::jsonb,
       min(l.created_at), 'first_listing:' || l.user_id
FROM public.listings l
WHERE l.user_id IS NOT NULL
GROUP BY l.user_id
ON CONFLICT (dedupe_key) DO NOTHING;

-- last_active_at ← greatest of signup + latest real activity (only fills NULLs,
-- so a re-run never regresses a value the live path has since advanced).
UPDATE public.users u
SET last_active_at = GREATEST(
  u.created_at,
  COALESCE((SELECT max(gr.created_at) FROM public.grade_reports gr
              JOIN public.submissions sub ON sub.id = gr.submission_id
              WHERE sub.user_id = u.id), u.created_at),
  COALESCE((SELECT max(l.created_at)  FROM public.listings l      WHERE l.user_id  = u.id), u.created_at),
  COALESCE((SELECT max(s.created_at)  FROM public.sales s         WHERE s.user_id  = u.id), u.created_at)
)
WHERE u.last_active_at IS NULL;

COMMIT;

-- US-1108: self-record this migration's version so the edge schema-version
-- guard (US-778) stays in sync regardless of apply method.
INSERT INTO public.applied_migrations (version) VALUES ('00277')
ON CONFLICT (version) DO NOTHING;


-- ════════════════════════════════════════════════════════════════════════════
-- 00278_newsletter_analytics.sql
-- ════════════════════════════════════════════════════════════════════════════

-- US-931: Email program analytics & deliverability — subscriber registry +
-- read-only rollup RPC.
--
-- The newsletter program reuses the Growth/Promote broadcast infrastructure
-- (growth_campaigns + campaign_recipients, migration 00102): each email-channel
-- campaign is an "issue", and campaign_recipients is the per-recipient delivery +
-- engagement ledger (sent/opened/clicked/failed/skipped). This migration adds the
-- confirmed-subscriber registry (email_subscribers) the program needs for list
-- size/growth, and the server-side `newsletter_analytics(period)` rollup that
-- powers the operator deliverability dashboard.
--
-- Definitions (documented so the dashboard numbers are unambiguous and reconcile
-- with the campaign_recipients ledger):
--   • issue            — a growth_campaigns row whose channels include 'email'
--                        and that has been sent (status sent/sending) in-window.
--   • sent             — campaign_recipients rows (channel='email') with
--                        status='sent' for the issue.
--   • opened/clicked   — campaign_recipients with opened_at/clicked_at set
--                        (US-913 open-pixel + click-redirect tracking).
--   • open rate        — opened / sent. CTR — clicked / sent. Click-to-open —
--                        clicked / opened.
--   • failed/skipped   — send-time failures / suppression-skips on the ledger.
--   • bounces/complaints — email_suppressions rows (reason bounce/complaint)
--                        created in-window; the SES feedback loop (US-1057) is the
--                        source. Program bounce/complaint RATE = these / sent.
--   • list size        — confirmed subscribers now. growth — confirmed in-window
--                        minus unsubscribed in-window. unsub rate — unsubscribed
--                        in-window / sent.
--
-- email_subscribers + the rollup are service-role only; the dashboard reads
-- exclusively through the aggregating RPC, never the raw rows.
--
-- Additive + idempotent.

BEGIN;

-- ── Confirmed-subscriber registry ──────────────────────────────────────────
-- One row per email address on the newsletter list. user_id links the row to a
-- platform account when the subscriber is also a user (nullable — standalone
-- leads have none). Status drives list-size/growth: 'confirmed' is the engaged
-- list, 'unsubscribed'/'cleaned' have left it. Service-role only.
CREATE TABLE IF NOT EXISTS public.email_subscribers (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email           text NOT NULL UNIQUE,            -- normalized (trimmed, lowercased)
  user_id         uuid REFERENCES public.users(id) ON DELETE SET NULL,
  status          text NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'confirmed', 'unsubscribed', 'cleaned')),
  source          text,                            -- where they signed up (footer, modal, import, …)
  confirmed_at    timestamptz,
  unsubscribed_at timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.email_subscribers IS
  'US-931: newsletter confirmed-subscriber registry driving list size/growth + '
  'confirmed-subscriber counts in newsletter_analytics. Service-role only.';

CREATE INDEX IF NOT EXISTS email_subscribers_status_idx
  ON public.email_subscribers (status);
CREATE INDEX IF NOT EXISTS email_subscribers_confirmed_idx
  ON public.email_subscribers (confirmed_at);
CREATE INDEX IF NOT EXISTS email_subscribers_unsubscribed_idx
  ON public.email_subscribers (unsubscribed_at);

-- updated_at maintenance (project-wide trigger convention).
CREATE OR REPLACE FUNCTION public.set_email_subscribers_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_email_subscribers_updated_at ON public.email_subscribers;
CREATE TRIGGER trg_email_subscribers_updated_at
  BEFORE UPDATE ON public.email_subscribers
  FOR EACH ROW EXECUTE FUNCTION public.set_email_subscribers_updated_at();

-- Service-role only — written by the edge consent/subscriber paths, read only
-- through the aggregating RPC; RLS enabled with zero policies = deny-all.
ALTER TABLE public.email_subscribers ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.email_subscribers FROM anon, authenticated;

-- ── Rollup RPC ──────────────────────────────────────────────────────────────
-- Single jsonb document; payload size is bounded by the in-window issue count
-- (not subscriber/recipient volume). `p_period` is a token ('7d'|'30d'|'90d'|
-- '180d'|'365d'); anything else falls back to 30 days. Window anchors on p_end.
CREATE OR REPLACE FUNCTION public.newsletter_analytics(
  p_period text DEFAULT '30d',
  p_end    timestamptz DEFAULT now()
)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH params AS (
    SELECT
      p_end AS w_end,
      p_end - (CASE p_period
                 WHEN '7d'   THEN interval '7 days'
                 WHEN '30d'  THEN interval '30 days'
                 WHEN '90d'  THEN interval '90 days'
                 WHEN '180d' THEN interval '180 days'
                 WHEN '365d' THEN interval '365 days'
                 ELSE interval '30 days'
               END) AS w_start
  ),
  -- Email-channel campaigns sent in-window = newsletter "issues".
  issues AS (
    SELECT g.id, g.name, g.subject, g.sent_at
    FROM public.growth_campaigns g, params p
    WHERE 'email' = ANY (g.channels)
      AND g.status IN ('sent', 'sending')
      AND g.sent_at IS NOT NULL
      AND g.sent_at >= p.w_start
      AND g.sent_at <  p.w_end
  ),
  -- Per-recipient email ledger for those issues.
  rcpt AS (
    SELECT r.*
    FROM public.campaign_recipients r
    JOIN issues i ON i.id = r.campaign_id
    WHERE r.channel = 'email'
  ),
  per_issue AS (
    SELECT
      i.id,
      i.name,
      i.subject,
      i.sent_at,
      count(*) FILTER (WHERE r.status = 'sent')         AS sent,
      count(*) FILTER (WHERE r.opened_at IS NOT NULL)   AS opened,
      count(*) FILTER (WHERE r.clicked_at IS NOT NULL)  AS clicked,
      count(*) FILTER (WHERE r.status = 'failed')       AS failed,
      count(*) FILTER (WHERE r.status = 'skipped')      AS skipped
    FROM issues i
    LEFT JOIN rcpt r ON r.campaign_id = i.id
    GROUP BY i.id, i.name, i.subject, i.sent_at
  ),
  totals AS (
    SELECT
      coalesce(count(*), 0)                  AS issues,
      coalesce(sum(sent), 0)                 AS sent,
      coalesce(sum(opened), 0)               AS opened,
      coalesce(sum(clicked), 0)              AS clicked,
      coalesce(sum(failed), 0)               AS failed,
      coalesce(sum(skipped), 0)              AS skipped
    FROM per_issue
  ),
  -- Suppression feedback (US-1057) in-window: hard bounces + complaints.
  supp AS (
    SELECT
      count(*) FILTER (WHERE s.reason = 'bounce')    AS bounces,
      count(*) FILTER (WHERE s.reason = 'complaint') AS complaints
    FROM public.email_suppressions s, params p
    WHERE s.created_at >= p.w_start AND s.created_at < p.w_end
  ),
  -- Closed-loop product outcome (reusing the click signal): newsletter readers
  -- who clicked and then graded a garment after that click, in-window. Bounded by
  -- the (small) set of clickers, so cheap. Distinct users so multiple clicks/
  -- submissions don't double-count.
  closed_loop AS (
    SELECT count(DISTINCT r.user_id) AS clicked_then_graded
    FROM rcpt r
    JOIN public.submissions sub
      ON sub.user_id = r.user_id
     AND sub.created_at >= r.clicked_at
     AND sub.created_at <  (SELECT w_end FROM params)
    WHERE r.clicked_at IS NOT NULL
  ),
  -- Subscriber list: size now + in-window growth.
  subs AS (
    SELECT
      count(*) FILTER (WHERE es.status = 'confirmed')                                   AS confirmed,
      count(*) FILTER (WHERE es.status = 'pending')                                     AS pending,
      count(*) FILTER (WHERE es.confirmed_at >= p.w_start AND es.confirmed_at < p.w_end) AS new_confirmed,
      count(*) FILTER (WHERE es.unsubscribed_at >= p.w_start AND es.unsubscribed_at < p.w_end) AS unsubscribed
    FROM public.email_subscribers es, params p
  )
  SELECT jsonb_build_object(
    'period', p_period,
    'window', (SELECT jsonb_build_object('start', w_start, 'end', w_end) FROM params),
    'program', (
      SELECT jsonb_build_object(
        'issuesSent', t.issues,
        'sent', t.sent,
        'opened', t.opened,
        'clicked', t.clicked,
        'failed', t.failed,
        'skipped', t.skipped,
        'openRate',    CASE WHEN t.sent > 0 THEN round(t.opened::numeric / t.sent, 4) ELSE 0 END,
        'ctr',         CASE WHEN t.sent > 0 THEN round(t.clicked::numeric / t.sent, 4) ELSE 0 END,
        'clickToOpenRate', CASE WHEN t.opened > 0 THEN round(t.clicked::numeric / t.opened, 4) ELSE 0 END,
        'bounces', s.bounces,
        'complaints', s.complaints,
        'bounceRate',    CASE WHEN t.sent > 0 THEN round(s.bounces::numeric / t.sent, 5) ELSE 0 END,
        'complaintRate', CASE WHEN t.sent > 0 THEN round(s.complaints::numeric / t.sent, 5) ELSE 0 END,
        'unsubscribed', sub.unsubscribed,
        'unsubRate',     CASE WHEN t.sent > 0 THEN round(sub.unsubscribed::numeric / t.sent, 5) ELSE 0 END,
        'listSize', sub.confirmed,
        'confirmedSubscribers', sub.confirmed,
        'pendingSubscribers', sub.pending,
        'newSubscribers', sub.new_confirmed,
        'netGrowth', sub.new_confirmed - sub.unsubscribed,
        -- Closed-loop product impact: distinct readers who clicked then graded.
        'clickedThenGraded', cl.clicked_then_graded
      )
      FROM totals t, supp s, subs sub, closed_loop cl
    ),
    'issues', (
      SELECT coalesce(jsonb_agg(
        jsonb_build_object(
          'id', pi.id,
          'name', pi.name,
          'subject', pi.subject,
          'sentAt', pi.sent_at,
          'sent', pi.sent,
          'opened', pi.opened,
          'clicked', pi.clicked,
          'failed', pi.failed,
          'skipped', pi.skipped,
          'openRate', CASE WHEN pi.sent > 0 THEN round(pi.opened::numeric / pi.sent, 4) ELSE 0 END,
          'ctr',      CASE WHEN pi.sent > 0 THEN round(pi.clicked::numeric / pi.sent, 4) ELSE 0 END,
          -- send-time failure proxy (post-send hard bounces aren't linked to an issue).
          'bounceRate', CASE WHEN (pi.sent + pi.failed) > 0
                          THEN round(pi.failed::numeric / (pi.sent + pi.failed), 4) ELSE 0 END
        ) ORDER BY pi.sent_at DESC
      ), '[]'::jsonb)
      FROM per_issue pi
    )
  );
$$;

COMMENT ON FUNCTION public.newsletter_analytics(text, timestamptz) IS
  'US-931: read-only newsletter program rollup (per-issue + program-level open/'
  'CTR/bounce/complaint/unsub rates + list size/growth) from campaign_recipients '
  '+ email_suppressions + email_subscribers. Reconciles with the recipients ledger.';

GRANT EXECUTE ON FUNCTION public.newsletter_analytics(text, timestamptz) TO service_role;

-- ── Seed the deliverability-guard settings into the registry (US-884) ───────
-- `on conflict do nothing` so an operator override applied before a re-run is
-- never clobbered.
INSERT INTO public.system_settings (key, value, value_type, default_value, description, category)
VALUES
  (
    'newsletter_complaint_rate_threshold',
    '0.001'::jsonb, 'number', '0.001'::jsonb,
    'US-931: program complaint rate (complaints/sent) above which deliverability is flagged critical (default 0.1%).',
    'marketing'
  ),
  (
    'newsletter_bounce_rate_threshold',
    '0.02'::jsonb, 'number', '0.02'::jsonb,
    'US-931: program bounce rate (bounces/sent) above which deliverability is flagged critical (default 2%).',
    'marketing'
  ),
  (
    'newsletter_auto_pause_enabled',
    'false'::jsonb, 'bool', 'false'::jsonb,
    'US-931: when true, a critical bounce/complaint breach auto-pauses newsletter sends (sets newsletter_send_paused).',
    'marketing'
  ),
  (
    'newsletter_send_paused',
    'false'::jsonb, 'bool', 'false'::jsonb,
    'US-931: kill-switch the newsletter sender checks before dispatch; set true automatically on a critical deliverability breach (when auto-pause is enabled) or manually by an operator.',
    'marketing'
  )
ON CONFLICT (key) DO NOTHING;

COMMIT;

-- US-1108: self-record this migration's version so the edge schema-version
-- guard (US-778) stays in sync regardless of apply method.
INSERT INTO public.applied_migrations (version) VALUES ('00278')
ON CONFLICT (version) DO NOTHING;


-- ════════════════════════════════════════════════════════════════════════════
-- 00279_newsletter_console.sql
-- ════════════════════════════════════════════════════════════════════════════

-- US-930: Newsletter admin console — the operator oversight + safety-brake
-- surface for the autonomous newsletter program.
--
-- The newsletter ENGINE (auto-build/QA/schedule/send) is delivered incrementally
-- by sibling stories; this migration adds the durable substrate the console
-- manages:
--   • newsletter_issues            — one row per program "issue" with the full
--                                    lifecycle the console drives:
--                                    draft → ready_for_qa → awaiting_review →
--                                    approved → sending → sent, plus a `blocked`
--                                    terminal the kill-switch / operator reject
--                                    lands on. Carries the editable subject +
--                                    sections, schedule, audience, QA results,
--                                    and live send-progress counters.
--   • newsletter_issue_recipients  — the per-issue resolved-recipient ledger that
--                                    powers the drill-in: who was resolved, who
--                                    was skipped (with a reason), and live send
--                                    progress.
--
-- Both are service-role only (RLS enabled, zero policies = deny-all): they are an
-- operator surface read/written exclusively by the role-gated /api/admin/newsletter
-- endpoints via the service-role edge client; the SPA never reads the raw rows.
--
-- Program-level controls (pause / require-approval) live in the system_settings
-- registry (00207) alongside the existing newsletter_send_paused kill-switch; the
-- platform-wide kill-switch is a feature_flags row (00096) so it halts instantly.
--
-- Additive + idempotent.

BEGIN;

-- ── Issue lifecycle ──────────────────────────────────────────────────────────
-- One row per newsletter issue. `status` is the lifecycle the console drives;
-- `sections` is the editable ordered content blocks (jsonb array of
-- {heading?, body, ctaLabel?, ctaUrl?}); `qa_results` is the automated QA report
-- (jsonb). created_by/approved_by reference the acting admin (NOT a tenant key —
-- this is an operator-owned program table, not user data).
CREATE TABLE IF NOT EXISTS public.newsletter_issues (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title             text NOT NULL DEFAULT 'Untitled issue',  -- internal label
  subject           text NOT NULL DEFAULT '',                -- email subject line
  preheader         text,                                    -- inbox preview text
  sections          jsonb NOT NULL DEFAULT '[]'::jsonb,      -- ordered content blocks
  status            text NOT NULL DEFAULT 'draft'
                      CHECK (status IN (
                        'draft', 'ready_for_qa', 'approved', 'awaiting_review',
                        'sending', 'sent', 'blocked'
                      )),
  audience          text NOT NULL DEFAULT 'all_confirmed',   -- segment key / 'all_confirmed'
  segment_id        uuid,                                    -- optional audience_segments ref
  scheduled_for     timestamptz,                             -- when the program will send it
  qa_results        jsonb NOT NULL DEFAULT '{}'::jsonb,      -- automated QA report
  recipients_total  integer NOT NULL DEFAULT 0,              -- resolved at send time
  sent_count        integer NOT NULL DEFAULT 0,
  skipped_count     integer NOT NULL DEFAULT 0,
  failed_count      integer NOT NULL DEFAULT 0,
  block_reason      text,                                    -- why blocked/rejected
  created_by        uuid REFERENCES public.users(id) ON DELETE SET NULL,
  approved_by       uuid REFERENCES public.users(id) ON DELETE SET NULL,
  approved_at       timestamptz,
  send_started_at   timestamptz,
  sent_at           timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.newsletter_issues IS
  'US-930: newsletter program issues with full draft→sent lifecycle, editable '
  'subject/sections, schedule, audience, QA results + send-progress counters. '
  'Operator surface — service-role only.';

CREATE INDEX IF NOT EXISTS newsletter_issues_status_idx
  ON public.newsletter_issues (status);
CREATE INDEX IF NOT EXISTS newsletter_issues_scheduled_idx
  ON public.newsletter_issues (scheduled_for);
CREATE INDEX IF NOT EXISTS newsletter_issues_created_idx
  ON public.newsletter_issues (created_at DESC);

CREATE OR REPLACE FUNCTION public.set_newsletter_issues_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_newsletter_issues_updated_at ON public.newsletter_issues;
CREATE TRIGGER trg_newsletter_issues_updated_at
  BEFORE UPDATE ON public.newsletter_issues
  FOR EACH ROW EXECUTE FUNCTION public.set_newsletter_issues_updated_at();

ALTER TABLE public.newsletter_issues ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.newsletter_issues FROM anon, authenticated;

-- ── Per-issue resolved-recipient ledger (drill-in) ───────────────────────────
-- One row per resolved recipient of an issue. `status` mirrors campaign_recipients
-- semantics (pending/sent/skipped/failed); `skip_reason` records WHY a recipient
-- was skipped (opted-out / suppressed / no-account / frequency-capped). The
-- subscriber's linked account id is subscriber_user_id (deliberately NOT named
-- user_id — this is an operator program ledger, not tenant-owned data).
CREATE TABLE IF NOT EXISTS public.newsletter_issue_recipients (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  issue_id            uuid NOT NULL REFERENCES public.newsletter_issues(id) ON DELETE CASCADE,
  email               text NOT NULL,
  subscriber_user_id  uuid,                                  -- linked account, if any
  status              text NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending', 'sent', 'skipped', 'failed')),
  skip_reason         text,                                  -- why skipped (when status='skipped')
  sent_at             timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.newsletter_issue_recipients IS
  'US-930: per-issue resolved-recipient ledger powering the console drill-in '
  '(resolved / skipped-with-reason / live send progress). Operator surface — '
  'service-role only.';

CREATE INDEX IF NOT EXISTS newsletter_issue_recipients_issue_idx
  ON public.newsletter_issue_recipients (issue_id);
CREATE INDEX IF NOT EXISTS newsletter_issue_recipients_status_idx
  ON public.newsletter_issue_recipients (issue_id, status);
CREATE UNIQUE INDEX IF NOT EXISTS newsletter_issue_recipients_unique_idx
  ON public.newsletter_issue_recipients (issue_id, email);

ALTER TABLE public.newsletter_issue_recipients ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.newsletter_issue_recipients FROM anon, authenticated;

-- ── Program controls (settings registry) ─────────────────────────────────────
-- The master "require human approval" toggle. The "pause program" master brake
-- reuses the existing newsletter_send_paused kill-switch (seeded 00278). `on
-- conflict do nothing` so an operator override is never clobbered on a re-run.
INSERT INTO public.system_settings (key, value, value_type, default_value, description, category)
VALUES
  (
    'newsletter_require_approval',
    'true'::jsonb, 'bool', 'true'::jsonb,
    'US-930: when true, every newsletter issue must be human-approved (status awaiting_review → approved) before the program may send it; off lets QA-passing issues auto-approve.',
    'marketing'
  )
ON CONFLICT (key) DO NOTHING;

-- ── Platform-wide kill-switch (feature flag) ─────────────────────────────────
-- A dedicated feature_flags row so the whole newsletter program can be halted
-- instantly fleet-wide from the Feature Flags console or the newsletter console.
-- Seeded enabled; the program sender checks isFeatureEnabled('newsletter').
INSERT INTO public.feature_flags (key, enabled, description)
VALUES (
  'newsletter',
  true,
  'US-930: master kill-switch for the autonomous newsletter program. Disable to halt all newsletter sends instantly platform-wide.'
)
ON CONFLICT (key) DO NOTHING;

COMMIT;

-- US-1108: self-record this migration's version so the edge schema-version
-- guard (US-778) stays in sync regardless of apply method.
INSERT INTO public.applied_migrations (version) VALUES ('00279')
ON CONFLICT (version) DO NOTHING;


-- ════════════════════════════════════════════════════════════════════════════
-- 00280_email_journeys.sql
-- ════════════════════════════════════════════════════════════════════════════

-- US-929: Lifecycle drip series (welcome, trial-nurture, win-back).
--
-- A general lifecycle email-journey engine that complements the focused
-- trial-conversion drip (drip_campaigns, 00255). A daily evaluation job
-- (POST /api/jobs/journey-tick) enrolls users whose state matches a journey's
-- trigger and walks them through an ordered, time-offset series of steps,
-- reusing the SAME send stack (emailLayout render + coordinateMarketingSend for
-- marketing classes / durable transactional send for lifecycle-transactional
-- ones), honoring consent (US-911) + suppression (US-914) + the cross-program
-- frequency cap (US-934).
--
-- Substrate:
--   • email_journeys            — one row per journey: its trigger, email class
--                                 (transactional vs marketing), enrolment window
--                                 and the master enable toggle the admin flips.
--   • email_journey_steps       — the ordered, day-offset steps (subject + body
--                                 template + CTA), reusing {{token}} personalization.
--   • email_journey_enrollments — per-(journey,user) enrolment; UNIQUE so each user
--                                 advances through a series ONCE (idempotent), with
--                                 the cursor (current_step / next_step_at) and the
--                                 exit/goal terminal.
--   • email_journey_step_sends  — per-(enrollment,step) send/skip ledger; UNIQUE so
--                                 a step is sent once + the admin metrics roll up
--                                 per step.
--
-- The trial-nurture journey (trigger = trial_ending) finally closes the
-- long-standing gap where the trial-expiry downgrade cron (US-383) demotes a
-- user without ever warning them first.
--
-- All four tables are service-role only (RLS enabled, REVOKE, zero policies):
-- they are written/read ONLY by the edge journey engine + the role-gated
-- /api/admin/journeys console via the service-role client; the SPA never reads
-- the raw rows. (email_journey_enrollments.user_id is the enrolled tenant, not a
-- client read key — same model as drip_enrollments.)
--
-- Additive + idempotent.

BEGIN;

-- ── Journeys ─────────────────────────────────────────────────────────────────
-- `trigger` is the user-state event that enrols a user. `email_class` decides
-- the send path: 'transactional' (welcome — never capped, no opt-out, durable
-- retry) vs 'marketing' (win-back / nurture — consent + suppression + cap +
-- one-click unsubscribe, via coordinateMarketingSend). `trigger_window_days`
-- parameterizes the trigger (trial_ending: enrol when trial_ends_at is within N
-- days; inactivity: enrol after N days with no activity; signup/first_*: enrol on
-- the event within the last N days). `enabled` is the admin master switch — every
-- seeded journey ships OFF so an operator deliberately turns each on.
CREATE TABLE IF NOT EXISTS public.email_journeys (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  journey_key         text NOT NULL UNIQUE,                  -- stable slug (e.g. 'welcome')
  name                text NOT NULL,
  description         text NOT NULL DEFAULT '',
  trigger             text NOT NULL
                        CHECK (trigger IN (
                          'signup', 'trial_ending', 'inactivity',
                          'first_grade', 'first_sale'
                        )),
  email_class         text NOT NULL DEFAULT 'marketing'
                        CHECK (email_class IN ('transactional', 'marketing')),
  trigger_window_days integer NOT NULL DEFAULT 3
                        CHECK (trigger_window_days >= 0),
  enabled             boolean NOT NULL DEFAULT false,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.email_journeys IS
  'US-929: lifecycle email journeys (welcome/trial-nurture/win-back). Operator '
  'surface — service-role only. trigger drives enrolment; email_class drives the '
  'send path (transactional vs marketing); enabled is the admin master switch.';

CREATE INDEX IF NOT EXISTS email_journeys_enabled_idx
  ON public.email_journeys (enabled);
CREATE INDEX IF NOT EXISTS email_journeys_trigger_idx
  ON public.email_journeys (trigger);

CREATE OR REPLACE FUNCTION public.set_email_journeys_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_email_journeys_updated_at ON public.email_journeys;
CREATE TRIGGER trg_email_journeys_updated_at
  BEFORE UPDATE ON public.email_journeys
  FOR EACH ROW EXECUTE FUNCTION public.set_email_journeys_updated_at();

ALTER TABLE public.email_journeys ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.email_journeys FROM anon, authenticated;

-- ── Steps ────────────────────────────────────────────────────────────────────
-- Ordered, day-offset steps. `offset_days` is days after enrolment that the step
-- becomes due. `body_html` is the editable content fragment (may carry {{tokens}}
-- — firstName, trialEndsAt, dashboardUrl, aiIntro); the renderer appends the CTA
-- from cta_label/cta_url. `ai_personalize` opts a step into the optional AI
-- intro line (US-911 consent + content_ai kill-switch still apply; falls back to
-- the static template on any failure).
CREATE TABLE IF NOT EXISTS public.email_journey_steps (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  journey_id      uuid NOT NULL REFERENCES public.email_journeys(id) ON DELETE CASCADE,
  step_order      integer NOT NULL CHECK (step_order >= 1),
  offset_days     integer NOT NULL DEFAULT 0 CHECK (offset_days >= 0),
  subject         text NOT NULL DEFAULT '',
  body_html       text NOT NULL DEFAULT '',
  cta_label       text,
  cta_url         text,
  ai_personalize  boolean NOT NULL DEFAULT false,
  enabled         boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.email_journey_steps IS
  'US-929: ordered, day-offset steps for an email_journeys row. Operator surface '
  '— service-role only.';

CREATE UNIQUE INDEX IF NOT EXISTS email_journey_steps_order_unique_idx
  ON public.email_journey_steps (journey_id, step_order);
CREATE INDEX IF NOT EXISTS email_journey_steps_journey_idx
  ON public.email_journey_steps (journey_id);

DROP TRIGGER IF EXISTS trg_email_journey_steps_updated_at ON public.email_journey_steps;
CREATE TRIGGER trg_email_journey_steps_updated_at
  BEFORE UPDATE ON public.email_journey_steps
  FOR EACH ROW EXECUTE FUNCTION public.set_email_journeys_updated_at();

ALTER TABLE public.email_journey_steps ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.email_journey_steps FROM anon, authenticated;

-- ── Enrolments ───────────────────────────────────────────────────────────────
-- One row per (journey, user). The UNIQUE index makes "each user advances through
-- a series once" a DB invariant (idempotent enrolment — never re-enrol). The
-- cursor is current_step (highest step_order sent) + next_step_at (when to next
-- evaluate; the engine self-gates on it). A terminal stamps exited_at/exit_reason
-- (goal met / opted-out / suppressed) or completed_at (ran the whole series).
CREATE TABLE IF NOT EXISTS public.email_journey_enrollments (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  journey_id      uuid NOT NULL REFERENCES public.email_journeys(id) ON DELETE CASCADE,
  user_id         uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  enrolled_at     timestamptz NOT NULL DEFAULT now(),
  current_step    integer NOT NULL DEFAULT 0,
  next_step_at    timestamptz,                              -- when to next evaluate
  completed_at    timestamptz,                              -- ran the whole series
  exited_at       timestamptz,                              -- goal met / opt-out / suppressed
  exit_reason     text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.email_journey_enrollments IS
  'US-929: per-(journey,user) enrolment with the cursor + exit/goal terminal. '
  'UNIQUE(journey_id,user_id) = each user runs a series once (idempotent). '
  'Service-role only; user_id is the enrolled tenant, not a client read key.';

CREATE UNIQUE INDEX IF NOT EXISTS email_journey_enrollments_unique_idx
  ON public.email_journey_enrollments (journey_id, user_id);
CREATE INDEX IF NOT EXISTS email_journey_enrollments_due_idx
  ON public.email_journey_enrollments (journey_id, next_step_at)
  WHERE exited_at IS NULL AND completed_at IS NULL;

DROP TRIGGER IF EXISTS trg_email_journey_enrollments_updated_at ON public.email_journey_enrollments;
CREATE TRIGGER trg_email_journey_enrollments_updated_at
  BEFORE UPDATE ON public.email_journey_enrollments
  FOR EACH ROW EXECUTE FUNCTION public.set_email_journeys_updated_at();

ALTER TABLE public.email_journey_enrollments ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.email_journey_enrollments FROM anon, authenticated;

-- ── Per-step send/skip ledger ────────────────────────────────────────────────
-- One row per (enrollment, step). UNIQUE makes the send idempotent (a step is
-- sent once) and powers the per-step admin metrics roll-up. sent_at set = sent
-- (or durably enqueued); skip_reason set with sent_at null = skipped (opted-out /
-- suppressed / deferred-elsewhere). No user_id of its own (tenancy flows through
-- the enrollment), so it is not auto-discovered by the rls-guard.
CREATE TABLE IF NOT EXISTS public.email_journey_step_sends (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  enrollment_id   uuid NOT NULL REFERENCES public.email_journey_enrollments(id) ON DELETE CASCADE,
  journey_id      uuid NOT NULL REFERENCES public.email_journeys(id) ON DELETE CASCADE,
  step_order      integer NOT NULL,
  recipient       text,
  sent_at         timestamptz,
  skip_reason     text,
  created_at      timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.email_journey_step_sends IS
  'US-929: per-(enrollment,step) send/skip ledger. UNIQUE(enrollment_id,step_order) '
  '= idempotent per-step send + admin per-step metrics. Service-role only.';

CREATE UNIQUE INDEX IF NOT EXISTS email_journey_step_sends_unique_idx
  ON public.email_journey_step_sends (enrollment_id, step_order);
CREATE INDEX IF NOT EXISTS email_journey_step_sends_metrics_idx
  ON public.email_journey_step_sends (journey_id, step_order);

ALTER TABLE public.email_journey_step_sends ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.email_journey_step_sends FROM anon, authenticated;

-- ── Platform-wide kill-switch (feature flag) ─────────────────────────────────
-- A dedicated feature_flags row so the whole lifecycle-journey engine can be
-- halted instantly fleet-wide. Seeded ENABLED; the journey tick gates on
-- isFeatureEnabled('lifecycle_journeys'). (Individual journeys still ship OFF via
-- email_journeys.enabled, so nothing sends until an operator enables a journey.)
INSERT INTO public.feature_flags (key, enabled, description)
VALUES (
  'lifecycle_journeys',
  true,
  'US-929: master kill-switch for the lifecycle email-journey engine (welcome / trial-nurture / win-back). Disable to halt all journey sends instantly platform-wide.'
)
ON CONFLICT (key) DO NOTHING;

-- ── Seed the three lifecycle journeys (all disabled by default) ───────────────
-- Idempotent: keyed on journey_key; steps keyed on (journey_id, step_order).

-- 1. Welcome (signup) — lifecycle-transactional onboarding.
INSERT INTO public.email_journeys (journey_key, name, description, trigger, email_class, trigger_window_days, enabled)
VALUES (
  'welcome', 'Welcome series',
  'Onboards a new signup: a welcome + getting-started nudge over the first few days.',
  'signup', 'transactional', 7, false
)
ON CONFLICT (journey_key) DO NOTHING;

-- 2. Trial-ending nurture — marketing; closes the no-warning trial-expiry gap (US-383).
INSERT INTO public.email_journeys (journey_key, name, description, trigger, email_class, trigger_window_days, enabled)
VALUES (
  'trial-nurture', 'Trial-ending nurture',
  'Warns a trialist their Pro trial is ending and nudges them to add a card before the auto-downgrade.',
  'trial_ending', 'marketing', 3, false
)
ON CONFLICT (journey_key) DO NOTHING;

-- 3. Win-back — marketing; re-engages an inactive user.
INSERT INTO public.email_journeys (journey_key, name, description, trigger, email_class, trigger_window_days, enabled)
VALUES (
  'win-back', 'Win-back series',
  'Re-engages a user who has had no activity for the configured window.',
  'inactivity', 'marketing', 21, false
)
ON CONFLICT (journey_key) DO NOTHING;

-- Seed steps for each journey (resolve journey_id by key; idempotent on step_order).
INSERT INTO public.email_journey_steps (journey_id, step_order, offset_days, subject, body_html, cta_label, cta_url, ai_personalize)
SELECT j.id, v.step_order, v.offset_days, v.subject, v.body_html, v.cta_label, v.cta_url, v.ai_personalize
FROM public.email_journeys j
JOIN (
  VALUES
    -- Welcome series
    ('welcome', 1, 0,
      'Welcome to GradeThread, {{firstName}}',
      '<h2 style="margin:0 0 8px;color:#1A1A2E;font-size:20px;">Welcome to GradeThread!</h2>{{aiIntro}}<p style="margin:0 0 16px;color:#666;font-size:15px;line-height:1.5;">Hi {{firstName}}, thanks for joining. You''re ready to start grading clothing with AI precision — upload front, back, label and a detail photo and we''ll grade it instantly. You''re on a 14-day Pro trial, no card required.</p>',
      'Go to your dashboard', '{{dashboardUrl}}', true),
    ('welcome', 2, 2,
      'Grade your first item, {{firstName}}',
      '<h2 style="margin:0 0 8px;color:#1A1A2E;font-size:20px;">Ready for your first grade?</h2><p style="margin:0 0 16px;color:#666;font-size:15px;line-height:1.5;">Hi {{firstName}}, the fastest way to see GradeThread''s value is to grade a real item. Our AI scores fabric, structure, cosmetics, function and cleanliness, then gives you a shareable condition certificate buyers trust.</p>',
      'Submit your first item', '{{dashboardUrl}}/submissions/new', false),
    ('welcome', 3, 5,
      'Get more out of GradeThread',
      '<h2 style="margin:0 0 8px;color:#1A1A2E;font-size:20px;">Three ways to get more value</h2><p style="margin:0 0 16px;color:#666;font-size:15px;line-height:1.5;">Hi {{firstName}}, share your certificates with buyers to build trust, use FlipDesk to manage your eBay listings end-to-end, and grade in bulk to keep your pipeline moving. Your Pro trial unlocks all of it.</p>',
      'Explore your dashboard', '{{dashboardUrl}}', false),
    -- Trial-ending nurture
    ('trial-nurture', 1, 0,
      'Your Pro trial ends {{trialEndsAt}}',
      '<h2 style="margin:0 0 8px;color:#1A1A2E;font-size:20px;">Your Pro trial is ending soon</h2><p style="margin:0 0 16px;color:#666;font-size:15px;line-height:1.5;">Hi {{firstName}}, your 14-day FlipDesk Pro trial ends on <strong>{{trialEndsAt}}</strong>. Add a card now to keep your Pro features without interruption — if you don''t, your account will automatically drop to Free and your caps will tighten (your data stays safe).</p>',
      'Add a card to keep Pro', '{{dashboardUrl}}/billing', false),
    ('trial-nurture', 2, 2,
      'Last chance to keep Pro, {{firstName}}',
      '<h2 style="margin:0 0 8px;color:#1A1A2E;font-size:20px;">Last chance to stay on Pro</h2><p style="margin:0 0 16px;color:#666;font-size:15px;line-height:1.5;">Hi {{firstName}}, your trial ends {{trialEndsAt}}. After that you''ll move to Free automatically — bulk actions, comp pricing, auto-relist and unlimited grading will pause. Add a card now and nothing changes.</p>',
      'Keep my Pro features', '{{dashboardUrl}}/billing', false),
    -- Win-back
    ('win-back', 1, 0,
      'We miss you at GradeThread, {{firstName}}',
      '<h2 style="margin:0 0 8px;color:#1A1A2E;font-size:20px;">We miss you</h2><p style="margin:0 0 16px;color:#666;font-size:15px;line-height:1.5;">Hi {{firstName}}, it''s been a while. Your GradeThread account, grade history and credits are all still here. Grade an item or list one on FlipDesk to pick up right where you left off.</p>',
      'Come back', '{{dashboardUrl}}', false),
    ('win-back', 2, 5,
      'Here''s what''s new at GradeThread',
      '<h2 style="margin:0 0 8px;color:#1A1A2E;font-size:20px;">A lot has improved</h2><p style="margin:0 0 16px;color:#666;font-size:15px;line-height:1.5;">Hi {{firstName}}, we''ve been busy — faster grading, sharper condition reports and a smoother FlipDesk listing flow. Take a fresh look; your account is ready when you are.</p>',
      'See what''s new', '{{dashboardUrl}}', false)
) AS v(journey_key, step_order, offset_days, subject, body_html, cta_label, cta_url, ai_personalize)
  ON v.journey_key = j.journey_key
ON CONFLICT (journey_id, step_order) DO NOTHING;

COMMIT;

-- US-1108: self-record this migration's version so the edge schema-version
-- guard (US-778) stays in sync regardless of apply method.
INSERT INTO public.applied_migrations (version) VALUES ('00280')
ON CONFLICT (version) DO NOTHING;


-- ════════════════════════════════════════════════════════════════════════════
-- 00281_newsletter_self_tuning.sql
-- ════════════════════════════════════════════════════════════════════════════

-- US-928: Closed-loop self-tuning from engagement for the autonomous newsletter.
--
-- The newsletter program (US-930 console + sibling engine stories) picks a topic,
-- writes a subject, and schedules a send hour. This migration adds the durable
-- substrate that lets an analysis job feed open/click/unsubscribe engagement back
-- into those choices so the program gets smarter over time:
--
--   • newsletter_issues gains PROVENANCE columns (pillar / angle / subject_style /
--     send_hour) so every issue records WHICH topic + subject style + hour it used.
--     The analysis job attributes engagement to these dimensions; the assembler
--     reads the resulting weights to bias the next issue.
--   • newsletter_issue_recipients gains the per-recipient ENGAGEMENT signals
--     (opened_at / clicked_at / unsubscribed_at) the analysis job aggregates into
--     per-issue / per-topic / per-style / per-hour rates. (Population — open/click
--     pixels + unsubscribe stamping — is wired by the tracking sibling; the column
--     home + aggregation live here so the closed loop is data-driven by construction.)
--   • system_settings registry keys: the tuning CONFIG (exploration floor, unsub
--     ceiling, min sample, enable flag) operators can tune without a deploy, plus
--     the COMPUTED weight stores the job writes and the assembler reads, plus the
--     latest recommendations snapshot the admin console surfaces (AC4).
--
-- Additive + idempotent.

BEGIN;

-- ── Issue provenance dimensions ──────────────────────────────────────────────
ALTER TABLE public.newsletter_issues
  ADD COLUMN IF NOT EXISTS pillar        text,   -- content pillar (topic family)
  ADD COLUMN IF NOT EXISTS angle         text,   -- topic angle within the pillar
  ADD COLUMN IF NOT EXISTS subject_style text,   -- subject-line style used (benefit/curiosity/…)
  ADD COLUMN IF NOT EXISTS send_hour     smallint; -- UTC hour (0–23) the issue was scheduled to send

ALTER TABLE public.newsletter_issues
  DROP CONSTRAINT IF EXISTS newsletter_issues_send_hour_check;
ALTER TABLE public.newsletter_issues
  ADD CONSTRAINT newsletter_issues_send_hour_check
  CHECK (send_hour IS NULL OR (send_hour >= 0 AND send_hour <= 23));

COMMENT ON COLUMN public.newsletter_issues.pillar IS
  'US-928: content pillar this issue used — the topic dimension the self-tuning loop weights.';
COMMENT ON COLUMN public.newsletter_issues.subject_style IS
  'US-928: subject-line style used — the dimension subject-variant generation is nudged toward.';
COMMENT ON COLUMN public.newsletter_issues.send_hour IS
  'US-928: UTC send hour — the dimension send-time optimization consumes.';

-- Index the topic dimension so the analysis job can scan recently-sent issues by topic cheaply.
CREATE INDEX IF NOT EXISTS newsletter_issues_pillar_idx
  ON public.newsletter_issues (pillar);

-- ── Per-recipient engagement signals ─────────────────────────────────────────
ALTER TABLE public.newsletter_issue_recipients
  ADD COLUMN IF NOT EXISTS opened_at       timestamptz,
  ADD COLUMN IF NOT EXISTS clicked_at      timestamptz,
  ADD COLUMN IF NOT EXISTS unsubscribed_at timestamptz;

COMMENT ON COLUMN public.newsletter_issue_recipients.opened_at IS
  'US-928: when this recipient opened the issue (engagement signal aggregated by the self-tuning job).';

-- ── Tuning config + computed weight stores (settings registry) ───────────────
-- Config: operators tune these in /admin/ops/settings without a deploy.
INSERT INTO public.system_settings (key, value, value_type, default_value, category, description)
VALUES
  (
    'newsletter_tuning_enabled',
    'true'::jsonb, 'bool', 'true'::jsonb, 'marketing',
    'US-928: when true, the newsletter self-tuning analysis job recomputes topic/subject/send-hour weights from engagement, and the assembler biases selection by them. Off freezes the current weights.'
  ),
  (
    'newsletter_tuning_min_sample',
    to_jsonb(50), 'number', to_jsonb(50), 'marketing',
    'US-928: minimum sends before a topic/subject-style/hour rate is trusted for winner selection (below it the dimension only earns exploration airtime).'
  ),
  (
    'newsletter_tuning_exploration_floor',
    to_jsonb(0.15::numeric), 'number', to_jsonb(0.15::numeric), 'marketing',
    'US-928: fraction (0–1) of selection weight always reserved across non-paused topics so under-tested ones keep airtime (prevents runaway narrowing).'
  ),
  (
    'newsletter_tuning_unsub_ceiling',
    to_jsonb(0.005::numeric), 'number', to_jsonb(0.005::numeric), 'marketing',
    'US-928: unsubscribe rate above which a sufficiently-sampled topic is PAUSED (weight 0) in the next selection.'
  ),
  -- Computed stores: written by the analysis job, read by the assembler. Seeded empty.
  (
    'newsletter_topic_weights',
    '{}'::jsonb, 'json', '{}'::jsonb, 'marketing',
    'US-928: computed topic-id → selection weight (0–100) the assembler reads to bias topic selection. Written by the newsletter-tuning job.'
  ),
  (
    'newsletter_subject_style_weights',
    '{}'::jsonb, 'json', '{}'::jsonb, 'marketing',
    'US-928: computed subject-style → weight the assembler reads to nudge subject-variant generation toward winning styles.'
  ),
  (
    'newsletter_send_hour_stats',
    '{}'::jsonb, 'json', '{}'::jsonb, 'marketing',
    'US-928: computed { bestHour, scores[] } per-hour engagement the assembler reads for send-time optimization.'
  ),
  (
    'newsletter_tuning_recommendations',
    '{}'::jsonb, 'json', '{}'::jsonb, 'marketing',
    'US-928: latest self-tuning recommendations snapshot (per-topic/style/hour scores + paused topics + computedAt) the admin console surfaces for transparency/override.'
  )
ON CONFLICT (key) DO NOTHING;

COMMIT;

-- US-1108: self-record this migration's version so the edge schema-version
-- guard (US-778) stays in sync regardless of apply method.
INSERT INTO public.applied_migrations (version) VALUES ('00281')
ON CONFLICT (version) DO NOTHING;


-- ════════════════════════════════════════════════════════════════════════════
-- VERIFY: must print 00281
-- ════════════════════════════════════════════════════════════════════════════
SELECT public.latest_schema_migration() AS now_at;
