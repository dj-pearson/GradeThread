-- US-917: Newsletter knowledge base + evergreen educational topic bank.
--
-- The autonomous newsletter teaches something useful every issue. US-918 already
-- seeded the email knowledge docs (email.voice / email.structure / email.value_props,
-- editable at /admin/content/knowledge). This migration adds the EVERGREEN topic
-- bank the assembler draws educational angles from — a curated, reusable set of
-- lessons across the content pillars (grading benefits, listing accuracy, condition
-- standards, pricing/comps, photography, reseller workflow, trust/authenticity).
--
-- Unlike content_topics (one-shot blog/social titles consumed once), email angles
-- are EVERGREEN: a row is reused over time, rate-limited only by a dedup window so
-- the same lesson isn't repeated too soon. The assembler dedups a candidate against
-- the bank's own last_used_at + recently-sent issues + content_history_index, and a
-- refill cron tops the bank up with fresh evergreen angles (Haiku) when it runs low.
--
-- email_topic_bank is an operator surface (no tenant owner column): RLS enabled,
-- deny-all, read/written ONLY by the edge service-role client.
--
-- Additive + idempotent.

BEGIN;

-- ── email_topic_bank ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.email_topic_bank (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pillar         text NOT NULL,
  angle          text NOT NULL,
  label          text NOT NULL,
  summary        text NOT NULL DEFAULT '',
  key_points     text[] NOT NULL DEFAULT '{}',
  product_focus  public.content_product NOT NULL DEFAULT 'both',
  status         text NOT NULL DEFAULT 'active',   -- active | retired
  source         text NOT NULL DEFAULT 'seed',     -- seed | ai_refill | manual
  last_used_at   timestamptz,
  use_count      integer NOT NULL DEFAULT 0,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  -- A (pillar, angle) pair is the evergreen identity — makes seeding + refill
  -- inserts idempotent and gives the dedup pass a stable key.
  CONSTRAINT email_topic_bank_pillar_angle_key UNIQUE (pillar, angle),
  CONSTRAINT email_topic_bank_status_check CHECK (status IN ('active', 'retired'))
);

CREATE INDEX IF NOT EXISTS email_topic_bank_status_idx
  ON public.email_topic_bank (status, last_used_at);

CREATE TRIGGER set_email_topic_bank_updated_at
  BEFORE UPDATE ON public.email_topic_bank
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- Operator surface: deny-all to anon/auth; all access via the service-role client.
ALTER TABLE public.email_topic_bank ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.email_topic_bank FROM anon, authenticated;

-- Link an assembled issue back to the bank row it drew its angle from, so the
-- dedup pass can exclude recently-used angles precisely and engagement can be
-- attributed. ON DELETE SET NULL — retiring an angle never orphans a sent issue.
ALTER TABLE public.newsletter_issues
  ADD COLUMN IF NOT EXISTS topic_bank_id uuid;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'newsletter_issues_topic_bank_id_fkey'
      AND table_name = 'newsletter_issues'
  ) THEN
    ALTER TABLE public.newsletter_issues
      ADD CONSTRAINT newsletter_issues_topic_bank_id_fkey
      FOREIGN KEY (topic_bank_id) REFERENCES public.email_topic_bank(id) ON DELETE SET NULL;
  END IF;
END $$;

-- ── Seed the evergreen educational angles ────────────────────────────────────
-- Across the seven required pillars. The eight (pillar, angle) pairs that match
-- the static tuning catalog (newsletter-tuning.ts) are included verbatim so the
-- self-tuning engine keeps attributing engagement to them; the rest are additive
-- (unknown ids are simply un-biased until they earn data). ON CONFLICT keeps any
-- operator edit / refilled row from being clobbered on a re-run.
INSERT INTO public.email_topic_bank (pillar, angle, label, summary, key_points, product_focus, source) VALUES
  ('grading', 'education', 'How condition grading works',
   'A plain walkthrough of turning a garment inspection into a defensible 1.0–10.0 grade.',
   ARRAY['GradeThread scores five factors: Fabric, Structural, Cosmetic, Functional, Odor/Cleanliness', 'Grades map to tiers NWT/NWOT/Excellent/Very Good/Good/Fair/Poor'], 'gradethread', 'seed'),
  ('grading', 'mistakes', 'Common grading mistakes to avoid',
   'The handful of errors that make a grade inconsistent or indefensible — and how to dodge them.',
   ARRAY['Photograph the actual defects, not just hero shots', 'Low-confidence grades route to human review'], 'both', 'seed'),
  ('grading', 'benefits', 'Why consistent grading raises sell-through',
   'How a standardized condition grade builds buyer confidence and reduces back-and-forth.',
   ARRAY['A shared grading vocabulary sets accurate buyer expectations', 'A buyer-verifiable certificate backs every graded item'], 'both', 'seed'),
  ('grading', 'standards', 'The 1.0–10.0 condition scale, decoded',
   'What each half-point on the GradeThread scale actually means for a listing.',
   ARRAY['Scale runs 1.0–10.0 in half-points', 'Tiers: NWT 10, NWOT 9, Excellent 8, Very Good 7, Good 6, Fair 5, Poor 3–4'], 'gradethread', 'seed'),
  ('listing', 'accuracy', 'Condition descriptions buyers trust',
   'Writing the condition section of a listing so it matches the item and survives scrutiny.',
   ARRAY['Describe defects in the same terms the grade uses', 'Link the shareable certificate so buyers can verify'], 'flipdesk', 'seed'),
  ('listing', 'measurements', 'Measurements that cut returns',
   'The flat measurements that matter most and how to capture them consistently.',
   ARRAY['Consistent measurements reduce "fit" returns', 'FlipDesk captures measurements in the catalog → measure step'], 'flipdesk', 'seed'),
  ('pricing', 'comps', 'Reading comps without guessing',
   'Using sold comparables to price pre-owned clothing with evidence, not vibes.',
   ARRAY['FlipDesk pulls Browse comps in the comp step', 'Anchor price on sold comps for the same condition tier'], 'flipdesk', 'seed'),
  ('reselling', 'pricing', 'Pricing pre-owned clothing right',
   'A repeatable way to set a fair, profitable price for graded inventory.',
   ARRAY['Condition tier should move the price, not just brand', 'Re-check price against fresh comps before relisting'], 'flipdesk', 'seed'),
  ('reselling', 'sourcing', 'Sourcing inventory that sells',
   'Choosing pieces whose condition and demand justify the time to list them.',
   ARRAY['Grade-friendly items photograph and describe faster', 'Sourcing feeds the FlipDesk source → catalog pipeline'], 'flipdesk', 'seed'),
  ('photography', 'basics', 'Photos that show true condition',
   'Lighting and framing that surface real condition instead of hiding it.',
   ARRAY['Front/back/label plus a detail shot are the grading baseline', 'Show defects clearly — honest photos reduce disputes'], 'both', 'seed'),
  ('photography', 'flatlay', 'Flat-lay vs on-model for pre-owned',
   'When a clean flat-lay beats a model shot for condition-led listings.',
   ARRAY['Flat-lays make measurements and defects legible', 'Use item-photos imagery for listings, never grading labels'], 'flipdesk', 'seed'),
  ('workflow', 'intake', 'A repeatable intake routine',
   'Turning a pile of finds into listed inventory without skipping steps.',
   ARRAY['FlipDesk: source → catalog → measure → photograph → grade → comp → draft → list', 'A consistent routine keeps grades and listings accurate'], 'flipdesk', 'seed'),
  ('platform', 'workflow', 'Get more from GradeThread',
   'Underused features that speed up grading and listing day to day.',
   ARRAY['Certificates are shareable and buyer-verifiable', 'Low-confidence grades are flagged for review automatically'], 'both', 'seed'),
  ('market', 'trends', 'What''s selling right now',
   'Reading demand signals so you list what buyers are actually searching for.',
   ARRAY['Comp velocity is a stronger signal than list price', 'Match sourcing to categories that move'], 'flipdesk', 'seed'),
  ('authenticity', 'spotting-fakes', 'Spotting fakes & misreps',
   'Practical checks that catch counterfeits and misrepresented items before they cost you.',
   ARRAY['Inconsistent labels/stitching are early red flags', 'Document your authentication so buyers trust the listing'], 'both', 'seed'),
  ('trust', 'certificates', 'Turn a grade into buyer trust',
   'Using the shareable certificate to close the credibility gap with cautious buyers.',
   ARRAY['Each graded item gets a buyer-verifiable certificate', 'A public certificate is independent proof of condition'], 'both', 'seed'),
  ('trust', 'authentication-process', 'A consistent authentication check',
   'A short, repeatable verification pass that makes your listings more defensible.',
   ARRAY['Apply the same checks to every item', 'Record what you checked so disputes are easy to answer'], 'both', 'seed'),
  ('sustainability', 'circular-fashion', 'The case for secondhand',
   'Why accurate grading is what makes circular fashion actually work at scale.',
   ARRAY['Trustworthy condition data keeps clothing in use longer', 'Accurate grades reduce wasteful returns'], 'both', 'seed')
ON CONFLICT (pillar, angle) DO NOTHING;

-- ── Topic-bank settings (registry-backed; operator-retunable) ─────────────────
INSERT INTO public.system_settings (key, value, value_type, default_value, description, category)
VALUES
  (
    'newsletter_topic_dedup_window_days',
    to_jsonb(60), 'number', to_jsonb(60),
    'US-917: how recently (days) an evergreen email topic may have been used (bank last_used_at, a sent issue, or content_history_index) before it is excluded from selection.',
    'marketing'
  ),
  (
    'newsletter_topic_bank_min',
    to_jsonb(12), 'number', to_jsonb(12),
    'US-917: minimum active rows in email_topic_bank; the refill job tops the bank up toward the target once it drops below this.',
    'marketing'
  ),
  (
    'newsletter_topic_bank_target',
    to_jsonb(24), 'number', to_jsonb(24),
    'US-917: target active-row count the refill job grows email_topic_bank toward when below the minimum.',
    'marketing'
  ),
  (
    'newsletter_topic_refill_enabled',
    'true'::jsonb, 'bool', 'true'::jsonb,
    'US-917: master toggle for the AI refill of email_topic_bank. When false the refill job is a no-op (seeded angles still serve).',
    'marketing'
  )
ON CONFLICT (key) DO NOTHING;

COMMIT;

-- US-1108: self-record this migration's version so the edge schema-version
-- guard (US-778) stays in sync regardless of apply method.
INSERT INTO public.applied_migrations (version) VALUES ('00290')
ON CONFLICT (version) DO NOTHING;
