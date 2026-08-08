-- US-1855: the public Showcase / "Finds" feed.
--
-- A visitor-facing feed of graded finds: photo + grade + optional seller-stated
-- value + a link to the certificate and (when the seller has one) their verified
-- profile. Three pieces:
--
--   1. Per-submission CONSENT (`submissions.showcase_*`). Nothing appears in the
--      feed unless the owner turned it on for that specific item. This mirrors
--      `users.verified_show_listings` (the storefront opt-in) rather than
--      inheriting it: a public profile is consent to be FOUND, not consent to
--      have a particular garment reposted into a browsable feed.
--   2. `showcase_reactions` — one upvote per signed-in user per find.
--   3. `public_showcase_finds` — the PII-free public projection the feed reads.
--
-- WHY A DEDICATED VIEW rather than extending `public_grade_reports`. The
-- certificate view is the two-read-path surface (edge CERT_REPORT_COLUMNS + the
-- view) and every column added to it is a new public certificate field. The feed
-- needs submission-side columns (title, brand, category, the consent flag) that
-- have no business on a certificate payload, so this follows the 00257 passport
-- precedent: a small dedicated view, big view untouched.
--
-- The row-visibility predicate is copied from public_grade_reports (00356) so a
-- find can never be shown that the certificate itself would withhold: certified,
-- review_status approved/modified, and not moderation-withheld. Consent is an
-- ADDITIONAL gate on top, never a replacement.

-- ── 1. Per-submission consent ───────────────────────────────────────────────
ALTER TABLE public.submissions
  ADD COLUMN IF NOT EXISTS showcase_opt_in       boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS showcase_opted_in_at  timestamptz,
  -- Optional, SELLER-STATED value in cents. Deliberately not an inferred comp:
  -- the feed labels it as the seller's own number, so it must not be silently
  -- populated from pricing data the seller never agreed to publish.
  ADD COLUMN IF NOT EXISTS showcase_value_cents  integer;

ALTER TABLE public.submissions
  DROP CONSTRAINT IF EXISTS submissions_showcase_value_cents_check;
ALTER TABLE public.submissions
  ADD CONSTRAINT submissions_showcase_value_cents_check
  CHECK (
    showcase_value_cents IS NULL
    OR (showcase_value_cents >= 0 AND showcase_value_cents <= 100000000)
  );

COMMENT ON COLUMN public.submissions.showcase_opt_in IS
  'US-1855: the owner consented to THIS item appearing in the public Showcase feed. Per-item, defaults false, independent of users.verified_show_listings.';
COMMENT ON COLUMN public.submissions.showcase_opted_in_at IS
  'US-1855: when consent was last granted. Also the feed''s recency key, so re-consenting resurfaces a find rather than reviving its original grade date.';
COMMENT ON COLUMN public.submissions.showcase_value_cents IS
  'US-1855: optional seller-STATED value in cents shown beside the grade. Never inferred from comps.';

-- Backs the feed's "newest consented finds" scan.
CREATE INDEX IF NOT EXISTS idx_submissions_showcase_recent
  ON public.submissions (showcase_opted_in_at DESC)
  WHERE showcase_opt_in;

-- ── 2. Reactions ────────────────────────────────────────────────────────────
-- One upvote per signed-in user per find. Anonymous reactions were rejected on
-- purpose: without an account there is no key that makes "unique" mean anything
-- except an IP or a cookie, and the feed's trending rank would then be a number
-- anybody could inflate for free.
CREATE TABLE IF NOT EXISTS public.showcase_reactions (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  grade_report_id  uuid NOT NULL REFERENCES public.grade_reports(id) ON DELETE CASCADE,
  user_id          uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  created_at       timestamptz NOT NULL DEFAULT now()
);

-- One reaction per person per find (the toggle upserts/deletes against this).
CREATE UNIQUE INDEX IF NOT EXISTS uq_showcase_reactions_user_report
  ON public.showcase_reactions (user_id, grade_report_id);
-- Counting + trending both scan by report, newest first.
CREATE INDEX IF NOT EXISTS idx_showcase_reactions_report
  ON public.showcase_reactions (grade_report_id, created_at DESC);

ALTER TABLE public.showcase_reactions ENABLE ROW LEVEL SECURITY;

-- The owner of the reaction manages their own row. PUBLIC counts are NOT read
-- through this table by the client — they come from the service-role edge, which
-- returns aggregates only. So there is deliberately no "anyone can read" policy:
-- who reacted to what is not public information, only how many did.
--
-- US-1927: (select auth.uid()) so the planner hoists it to one InitPlan instead
-- of re-evaluating per row.
DROP POLICY IF EXISTS "Users read own showcase reactions" ON public.showcase_reactions;
CREATE POLICY "Users read own showcase reactions"
  ON public.showcase_reactions FOR SELECT
  USING ((select auth.uid()) = user_id);

DROP POLICY IF EXISTS "Users insert own showcase reactions" ON public.showcase_reactions;
CREATE POLICY "Users insert own showcase reactions"
  ON public.showcase_reactions FOR INSERT
  WITH CHECK ((select auth.uid()) = user_id);

DROP POLICY IF EXISTS "Users delete own showcase reactions" ON public.showcase_reactions;
CREATE POLICY "Users delete own showcase reactions"
  ON public.showcase_reactions FOR DELETE
  USING ((select auth.uid()) = user_id);

COMMENT ON TABLE public.showcase_reactions IS
  'US-1855: one upvote per signed-in user per showcased find. Owner-scoped RLS; public feed counts are aggregated server-side, never read row-by-row by a client.';

-- ── 3. The public projection ────────────────────────────────────────────────
-- PII-free by construction: no user id, no email, no submission id, no private
-- grading internals. The only identity that leaves is the seller's OWN public
-- verified handle, and only when their profile is enabled — otherwise the find
-- is anonymous and simply has no seller link.
--
-- security_invoker is OFF (the public_grade_reports / passport precedent): the
-- view runs as its owner so anon can read the projection without being granted
-- anything on the base tables.
CREATE OR REPLACE VIEW public.public_showcase_finds AS
SELECT
  gr.id                        AS grade_report_id,
  gr.certificate_id,
  gr.overall_score,
  gr.grade_tier,
  gr.created_at                AS graded_at,
  COALESCE(s.showcase_opted_in_at, gr.created_at) AS showcased_at,
  s.title,
  s.brand,
  -- Stable, URL-safe brand key so a brand facet page can be a real path
  -- (/finds/b/<slug>) that PostgREST can filter on with a plain equality —
  -- rather than a query string nothing can index. Mirrored in TS by
  -- brandSlug() (services/edge-functions/src/lib/showcase.ts), which a test
  -- pins to these same rules.
  NULLIF(
    trim(BOTH '-' FROM regexp_replace(lower(COALESCE(s.brand, '')), '[^a-z0-9]+', '-', 'g')),
    ''
  )                            AS brand_slug,
  s.garment_category::text     AS category,
  s.garment_type::text         AS garment_type,
  s.showcase_value_cents       AS value_cents,
  -- Seller identity ONLY when they run a public verified profile.
  CASE WHEN u.verified_enabled THEN u.verified_handle ELSE NULL END AS seller_handle,
  CASE WHEN u.verified_enabled
       THEN COALESCE(u.verified_display_name, u.verified_handle)
       ELSE NULL END           AS seller_display_name
FROM public.grade_reports gr
JOIN public.submissions s ON s.id = gr.submission_id
LEFT JOIN public.users u ON u.id = s.user_id
WHERE s.showcase_opt_in = true
  -- Everything below mirrors public_grade_reports (00356) verbatim in intent:
  -- a find can never be more visible than its own certificate.
  AND gr.certificate_id IS NOT NULL
  AND gr.review_status IN ('approved', 'modified')
  AND s.status IS DISTINCT FROM 'pending_review'
  AND (s.flagged IS NOT TRUE OR s.moderation_status = 'approved');

COMMENT ON VIEW public.public_showcase_finds IS
  'US-1855: public, PII-free projection of SELLER-CONSENTED graded finds for the /finds Showcase feed. Consent (submissions.showcase_opt_in) is an additional gate on top of the public_grade_reports visibility rules, never a replacement for them.';

GRANT SELECT ON public.public_showcase_finds TO anon, authenticated;

-- US-1108: self-record this migration's version so the edge schema-version
-- guard (US-778) stays in sync regardless of apply method.
INSERT INTO public.applied_migrations (version) VALUES ('00546')
ON CONFLICT (version) DO NOTHING;
