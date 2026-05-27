-- Blog & Social Content Super-Module (US-226).
--
-- An admin-only content engine that produces SEO-targeted blog articles
-- and short-and-long social posts driving traffic to GradeThread and
-- FlipDesk. See plan: clever-singing-flurry.md.
--
-- Surfaces      : blog, social
-- Product focus : gradethread, flipdesk (or both)
-- Lifecycle     : draft → scheduled → published → (archived) | failed
-- Bank          : content_topics queues titles per (surface, product_focus)
-- Memory        : content_knowledge (CLAUDE.md-style) + content_history_index
-- Autonomy      : edge /api/content/scheduler/tick callable by Make.com cron
--
-- All tables admin-only (uses public.is_admin() from 00003). Public
-- blog_posts (status='published') and blog_post_tags get an additional
-- anon SELECT policy so the Cloudflare Pages SSR worker can read them
-- with the anon key.

-- ══════════════════════════════════════════════════════════
-- ENUMS
-- ══════════════════════════════════════════════════════════

CREATE TYPE public.content_surface AS ENUM ('blog', 'social');

CREATE TYPE public.content_product AS ENUM ('gradethread', 'flipdesk', 'both');

CREATE TYPE public.content_status AS ENUM (
  'draft', 'scheduled', 'published', 'archived', 'failed'
);

CREATE TYPE public.topic_status AS ENUM (
  'queued', 'assigned', 'used', 'rejected'
);

CREATE TYPE public.content_generated_by AS ENUM ('ai', 'human');

CREATE TYPE public.content_topic_source AS ENUM (
  'research', 'manual', 'history_derived'
);

-- ══════════════════════════════════════════════════════════
-- TABLES
-- ══════════════════════════════════════════════════════════

-- ── content_topics ────────────────────────────────────────
-- The bank. Self-refilling pool of titles partitioned by
-- (surface, product_focus). Scheduler pulls oldest 'queued'.
CREATE TABLE public.content_topics (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  surface              public.content_surface NOT NULL,
  product_focus        public.content_product NOT NULL,
  title                text NOT NULL,
  angle                text,
  primary_keyword      text NOT NULL,
  secondary_keywords   text[] NOT NULL DEFAULT '{}',
  search_intent        text,
  status               public.topic_status NOT NULL DEFAULT 'queued',
  used_by_post_id      uuid,
  generated_by         public.content_generated_by NOT NULL DEFAULT 'ai',
  source               public.content_topic_source NOT NULL DEFAULT 'research',
  notes                text,
  created_at           timestamptz NOT NULL DEFAULT now(),
  used_at              timestamptz,
  updated_at           timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_content_topics_surface_product_status
  ON public.content_topics(surface, product_focus, status);

-- Hot path: scheduler picks oldest queued for a (surface, product_focus).
CREATE INDEX idx_content_topics_queued_created_at
  ON public.content_topics(surface, product_focus, created_at)
  WHERE status = 'queued';

-- Dedup gate: lookup by primary_keyword.
CREATE INDEX idx_content_topics_primary_keyword
  ON public.content_topics(lower(primary_keyword));

CREATE TRIGGER set_content_topics_updated_at
  BEFORE UPDATE ON public.content_topics
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ── blog_posts ────────────────────────────────────────────
CREATE TABLE public.blog_posts (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug                text NOT NULL UNIQUE,
  title               text NOT NULL,
  excerpt             text,
  body_html           text NOT NULL DEFAULT '',
  body_json           jsonb NOT NULL DEFAULT '{}'::jsonb, -- Tiptap doc
  product_focus       public.content_product NOT NULL DEFAULT 'both',
  status              public.content_status NOT NULL DEFAULT 'draft',
  hero_image_url      text,
  hero_image_path     text,
  hero_prompt         text,
  seo_title           text,
  seo_description     text,
  primary_keyword     text,
  secondary_keywords  text[] NOT NULL DEFAULT '{}',
  jsonld              jsonb,
  reading_time_min    integer,
  scheduled_for       timestamptz,
  published_at        timestamptz,
  topic_id            uuid REFERENCES public.content_topics(id) ON DELETE SET NULL,
  generated_by        public.content_generated_by NOT NULL DEFAULT 'human',
  model_used          text,
  prompt_tokens       integer,
  completion_tokens   integer,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

-- Deferred back-FK now that blog_posts exists.
ALTER TABLE public.content_topics
  ADD CONSTRAINT content_topics_used_by_post_id_fkey
  FOREIGN KEY (used_by_post_id) REFERENCES public.blog_posts(id) ON DELETE SET NULL;

CREATE INDEX idx_blog_posts_status_published_at
  ON public.blog_posts(status, published_at DESC);
CREATE INDEX idx_blog_posts_product_focus
  ON public.blog_posts(product_focus);
CREATE INDEX idx_blog_posts_primary_keyword
  ON public.blog_posts(lower(primary_keyword))
  WHERE primary_keyword IS NOT NULL;

CREATE TRIGGER set_blog_posts_updated_at
  BEFORE UPDATE ON public.blog_posts
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ── blog_post_tags ────────────────────────────────────────
-- Lightweight tagging; tag pages are derived (no separate tag table).
CREATE TABLE public.blog_post_tags (
  post_id  uuid NOT NULL REFERENCES public.blog_posts(id) ON DELETE CASCADE,
  tag      text NOT NULL,
  PRIMARY KEY (post_id, tag)
);

CREATE INDEX idx_blog_post_tags_tag ON public.blog_post_tags(tag);

-- ── social_posts ──────────────────────────────────────────
-- One row covers both long (LinkedIn/Facebook) and short (X/Threads)
-- formats so they stay paired editorially. Webhook fires once per format.
CREATE TABLE public.social_posts (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_focus       public.content_product NOT NULL DEFAULT 'gradethread',
  status              public.content_status NOT NULL DEFAULT 'draft',
  long_body           text NOT NULL DEFAULT '',
  short_body          text NOT NULL DEFAULT '',
  hashtags            text[] NOT NULL DEFAULT '{}',
  cta_url             text,
  scheduled_for       timestamptz,
  published_at        timestamptz,
  topic_id            uuid REFERENCES public.content_topics(id) ON DELETE SET NULL,
  asset_image_url     text,
  asset_image_path    text,
  generated_by        public.content_generated_by NOT NULL DEFAULT 'human',
  model_used          text,
  prompt_tokens       integer,
  completion_tokens   integer,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_social_posts_status_published_at
  ON public.social_posts(status, published_at DESC);
CREATE INDEX idx_social_posts_product_focus
  ON public.social_posts(product_focus);

CREATE TRIGGER set_social_posts_updated_at
  BEFORE UPDATE ON public.social_posts
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ── content_knowledge ─────────────────────────────────────
-- Curated reference docs (CLAUDE.md-style) loaded into every AI prompt
-- to keep voice/style consistent without per-prompt tuning.
CREATE TABLE public.content_knowledge (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key              text NOT NULL UNIQUE,
  title            text NOT NULL,
  body_md          text NOT NULL DEFAULT '',
  token_count_est  integer NOT NULL DEFAULT 0,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER set_content_knowledge_updated_at
  BEFORE UPDATE ON public.content_knowledge
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ── content_history_index ─────────────────────────────────
-- Token-efficient distilled history of every published piece. Drives
-- dedup and "what have we already covered" prompt context. We never
-- paste full post bodies into prompts — just these rows.
CREATE TABLE public.content_history_index (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  surface             public.content_surface NOT NULL,
  product_focus       public.content_product NOT NULL,
  post_id             uuid, -- nullable: may reference blog_posts OR social_posts
  title               text NOT NULL,
  primary_keyword     text,
  secondary_keywords  text[] NOT NULL DEFAULT '{}',
  summary_one_line    text,
  published_at        timestamptz NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_content_history_surface_product
  ON public.content_history_index(surface, product_focus, published_at DESC);
CREATE INDEX idx_content_history_primary_keyword
  ON public.content_history_index(lower(primary_keyword))
  WHERE primary_keyword IS NOT NULL;

-- ── content_webhook_log ───────────────────────────────────
-- Auditability + retry tracking for publish-time fan-out to Make.com.
CREATE TABLE public.content_webhook_log (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event           text NOT NULL,            -- blog.published | social.published
  format          text,                     -- 'long' | 'short' | null
  target_url      text NOT NULL,
  payload         jsonb NOT NULL,
  attempt_no      integer NOT NULL DEFAULT 1,
  http_status     integer,
  response_body   text,
  succeeded       boolean NOT NULL DEFAULT false,
  error           text,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_content_webhook_log_event_created_at
  ON public.content_webhook_log(event, created_at DESC);
CREATE INDEX idx_content_webhook_log_succeeded
  ON public.content_webhook_log(succeeded, created_at DESC);

-- ── content_settings ──────────────────────────────────────
-- Single-row table. We enforce that via a CHECK on a fixed id.
CREATE TABLE public.content_settings (
  id                            integer PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  make_webhook_blog             text,
  make_webhook_social_long      text,
  make_webhook_social_short     text,
  auto_publish_blog             boolean NOT NULL DEFAULT false,
  auto_publish_social           boolean NOT NULL DEFAULT false,
  default_blog_model            text NOT NULL DEFAULT 'claude-sonnet-4-6',
  default_social_model          text NOT NULL DEFAULT 'claude-sonnet-4-6',
  default_research_model        text NOT NULL DEFAULT 'claude-haiku-4-5-20251001',
  default_image_model           text NOT NULL DEFAULT 'gpt-image-1',
  min_topics_in_bank            integer NOT NULL DEFAULT 3,
  topics_refill_batch           integer NOT NULL DEFAULT 10,
  post_cadence_per_day_blog     integer NOT NULL DEFAULT 1,
  post_cadence_per_day_social   integer NOT NULL DEFAULT 2,
  public_site_url               text NOT NULL DEFAULT 'https://gradethread.com',
  created_at                    timestamptz NOT NULL DEFAULT now(),
  updated_at                    timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER set_content_settings_updated_at
  BEFORE UPDATE ON public.content_settings
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- Seed the singleton.
INSERT INTO public.content_settings (id) VALUES (1)
ON CONFLICT (id) DO NOTHING;

-- ══════════════════════════════════════════════════════════
-- ROW LEVEL SECURITY
-- ══════════════════════════════════════════════════════════
--
-- All content tables are admin-only. blog_posts(status='published')
-- and blog_post_tags get an additional anon SELECT policy so the
-- public SSR worker can read with the anon key.

ALTER TABLE public.content_topics         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.blog_posts             ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.blog_post_tags         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.social_posts           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.content_knowledge      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.content_history_index  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.content_webhook_log    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.content_settings       ENABLE ROW LEVEL SECURITY;

-- ── Admin-all policies (loop via DO block to keep things terse) ──
DO $$
DECLARE
  t text;
  cmd text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'content_topics', 'blog_posts', 'blog_post_tags', 'social_posts',
    'content_knowledge', 'content_history_index', 'content_webhook_log',
    'content_settings'
  ] LOOP
    cmd := format(
      'CREATE POLICY %I ON public.%I FOR ALL USING (public.is_admin()) WITH CHECK (public.is_admin())',
      'admins manage ' || t, t
    );
    EXECUTE cmd;
  END LOOP;
END $$;

-- ── Public read policies for the SSR blog ──────────────────
-- The SSR worker reads with the anon key (not service role) so it
-- benefits from RLS. Only published posts and their tags are visible.
CREATE POLICY "anon read published blog posts"
  ON public.blog_posts FOR SELECT
  TO anon
  USING (status = 'published');

CREATE POLICY "anon read tags of published posts"
  ON public.blog_post_tags FOR SELECT
  TO anon
  USING (
    EXISTS (
      SELECT 1 FROM public.blog_posts
      WHERE blog_posts.id = blog_post_tags.post_id
        AND blog_posts.status = 'published'
    )
  );

-- ══════════════════════════════════════════════════════════
-- STORAGE BUCKET
-- ══════════════════════════════════════════════════════════
-- Hero + inline images for blog/social. Public read so OG cards work.
-- Writes are gated to admins via the service-role client in the edge
-- functions (no per-user folder convention here — admins only).

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'content-images',
  'content-images',
  true,
  20971520, -- 20 MB (hero images can be larger than item photos)
  ARRAY['image/jpeg', 'image/png', 'image/webp', 'image/gif']
)
ON CONFLICT (id) DO NOTHING;

CREATE POLICY "content-images public read"
  ON storage.objects FOR SELECT
  USING (bucket_id = 'content-images');

-- Authenticated admin write/update/delete. Non-admins can't even
-- traverse the bucket (no fallback policy). Service-role bypasses RLS.
CREATE POLICY "content-images admin insert"
  ON storage.objects FOR INSERT
  TO authenticated
  WITH CHECK (bucket_id = 'content-images' AND public.is_admin());

CREATE POLICY "content-images admin update"
  ON storage.objects FOR UPDATE
  TO authenticated
  USING (bucket_id = 'content-images' AND public.is_admin());

CREATE POLICY "content-images admin delete"
  ON storage.objects FOR DELETE
  TO authenticated
  USING (bucket_id = 'content-images' AND public.is_admin());

-- ══════════════════════════════════════════════════════════
-- SEED KNOWLEDGE DOCS
-- ══════════════════════════════════════════════════════════
-- Six baseline reference docs. Admin can edit them in the dashboard.
-- These are the only context (besides the history index) loaded into
-- AI prompts at generation time.

INSERT INTO public.content_knowledge (key, title, body_md, token_count_est) VALUES

('brand.voice',
 'Brand Voice & Persona',
 E'# GradeThread Brand Voice\n\n'
 '## Persona\nWe write like a seasoned reseller who also happens to be a fabric nerd. '
 'Direct, evidence-led, never hypey. We respect the reader''s time.\n\n'
 '## Tone\n- Plain English; short sentences when possible.\n- "We" and "you", not "the user".\n'
 '- Confident, never apologetic. No "in this article we will explore".\n- Concrete numbers > vague claims.\n\n'
 '## Banned phrases\n- "game-changer", "revolutionize", "synergy", "in today''s fast-paced world", '
 '"unlock the power of", "elevate your", "supercharge".\n- Em-dash overuse. Em-dashes are fine — used sparingly.\n\n'
 '## Always\n- Lead with a specific scenario or stat.\n- Cite eBay/Mercari/etc. mechanics when relevant.\n'
 '- End with a clear, low-pressure CTA.\n',
 320),

('blog.gradethread.style',
 'Blog Style — GradeThread (condition grading)',
 E'# Blog Articles: GradeThread Focus\n\n'
 '## What GradeThread is\nAI-powered, standardized condition grading for pre-owned clothing on a 1.0–10.0 '
 'scale. Outputs a numerical grade, a detailed condition report, and a shareable certificate buyers can verify.\n\n'
 '## Target reader\nResellers on eBay/Poshmark/Mercari/Whatnot, thrift-store flippers, vintage and denim sellers, '
 'consignment shops. Skewing intermediate-to-advanced: they already list, they want fewer returns and higher trust.\n\n'
 '## Article shape\n- 1500–2200 words.\n- One H1 (= title). 4–7 H2s. Use H3s sparingly.\n- Open with a specific '
 'reseller pain (returns over "not as described", low price realization on Excellent items, etc.).\n'
 '- Include at least one numbered list or comparison table.\n- Close with a CTA to try GradeThread on a single garment.\n\n'
 '## Pillar topic clusters\n1. Condition vocabulary (NWT/NWOT/Excellent/Good — what each really means)\n'
 '2. Category-specific grading (denim, knits, leather, vintage tees, suits, shoes)\n'
 '3. Defect taxonomy (pilling, fading, fabric integrity, seam wear, odor)\n'
 '4. Trust & buyer psychology (why standardized grades reduce returns)\n'
 '5. Photography for accurate grading\n'
 '6. Pricing strategy by grade tier\n\n'
 '## Keyword strategy\nOne primary keyword per post, 3–5 secondary. Primary should be a specific buyer-intent '
 'phrase ("how to grade a vintage band tee"), not a head term ("clothing grading").\n',
 480),

('blog.flipdesk.style',
 'Blog Style — FlipDesk (reseller management)',
 E'# Blog Articles: FlipDesk Focus\n\n'
 '## What FlipDesk is\nThe reseller-management surface inside GradeThread. Handles the full eBay lifecycle: '
 'source → catalog → measure → photograph → grade → comp → draft → list → sell → ship → reconcile. '
 'Built for solo and small-team flippers who outgrew spreadsheets.\n\n'
 '## Target reader\nFull-time and serious side-hustle resellers, mostly on eBay (also Poshmark/Mercari/Whatnot/Shopify), '
 'doing 50–2000 items/month. They care about throughput, accurate P&L, and not letting cogs slip through the cracks.\n\n'
 '## Article shape\n- 1500–2200 words.\n- Open with a workflow problem ("Why your eBay drafts pile up at 47 unposted items").\n'
 '- Include screenshots/mockup placeholders where workflow steps are described.\n'
 '- Numbered checklists are gold for this audience.\n- Close with a CTA to try the relevant FlipDesk module.\n\n'
 '## Pillar topic clusters\n1. eBay listing optimization (titles, item specifics, photos, store strategy)\n'
 '2. Thrift sourcing (route planning, ROI per stop, category mixing)\n'
 '3. Reseller finances (P&L per item, cost basis, taxes, 1099-K)\n'
 '4. Inventory operations (SKU systems, location bins, throughput math)\n'
 '5. Multi-platform crosslisting (Posh ↔ Mercari ↔ eBay rules)\n'
 '6. Tooling & automation (when to upgrade from spreadsheets)\n'
 '7. Returns & reconciliation\n\n'
 '## Keyword strategy\nLong-tail buyer-intent phrases ("how to track eBay COGS across 500 items"). Avoid head terms.\n',
 520),

('social.long.style',
 'Social Style — Long format (LinkedIn / Facebook)',
 E'# Long-Format Social Posts (LinkedIn, Facebook)\n\n'
 '## Audience\nLinkedIn skews to "I''m turning my reselling into a business" — small operators with B2B-adjacent mindsets.\n'
 'Facebook skews to reseller-group communities; more peer-to-peer, less polished.\n\n'
 '## Shape\n- 800–1500 characters.\n- Open with a hook line on its own (one short sentence, no greeting).\n'
 '- One blank line between paragraphs.\n- Story or specific example in the middle.\n- One concrete takeaway.\n'
 '- End with one CTA line that includes the cta_url.\n- 3–5 hashtags max, on their own line.\n\n'
 '## Voice\nFirst-person ("I helped a reseller..."). Specific numbers. No corporate-speak.\n'
 'No emoji bullets. Real punctuation only. No "🚀✨💯" — sparingly, one max if at all.\n\n'
 '## Anti-patterns\n- Don''t lead with "Excited to share...".\n- Don''t end with "What do you think?" unless genuinely asking.\n'
 '- Don''t list 15 hashtags.\n',
 380),

('social.short.style',
 'Social Style — Short format (X / Threads)',
 E'# Short-Format Social Posts (X, Threads)\n\n'
 '## Audience\nResellers, sneakerheads, vintage flippers. Skews to fast-takes and witty observations. Pro-banter.\n\n'
 '## Shape\n- ≤280 characters including the link.\n- One thought. No threading in v1.\n'
 '- Hook + sharp insight + link.\n- 1–2 hashtags max, often zero.\n\n'
 '## Voice\nPunchy, opinionated, true. Reads like a person, not a brand.\n'
 'A specific number beats an adjective. A real example beats a claim.\n\n'
 '## Anti-patterns\n- No "🧵" thread starters in v1.\n- No "Day 1/30" gimmicks.\n- No clickbait — the link should deliver.\n',
 240),

('seo.pillars',
 'SEO Pillar Topic Map',
 E'# Pillar Topic Map\n\n'
 'Use this as the canonical map of "territory we cover". When researching new topics, '
 'pick subtopics that ladder up to one of these pillars. Avoid horizontal sprawl.\n\n'
 '## GradeThread pillars\n- **condition-vocabulary** — what NWT/NWOT/Excellent/etc. mean by category\n'
 '- **category-grading** — denim, knits, leather, vintage tees, suits, shoes, outerwear\n'
 '- **defect-taxonomy** — pilling, fading, fabric integrity, seam wear, odor\n'
 '- **trust-psychology** — buyer trust, return rates, standardized grades\n'
 '- **grading-photography** — lighting, angles, defect shots, label shots\n'
 '- **price-by-grade** — pricing strategy per condition tier\n\n'
 '## FlipDesk pillars\n- **ebay-listing-optimization** — titles, item specifics, photos, store strategy\n'
 '- **thrift-sourcing** — route planning, ROI per stop, category mixing\n'
 '- **reseller-finances** — P&L per item, cost basis, taxes, 1099-K\n'
 '- **inventory-ops** — SKU systems, location bins, throughput math\n'
 '- **crosslisting** — Posh ↔ Mercari ↔ eBay rules and economics\n'
 '- **tooling-automation** — when to graduate from spreadsheets\n'
 '- **returns-reconciliation** — payout matching, partial refunds, INR handling\n\n'
 '## Rules\n- Every new blog topic must declare a pillar in its `angle` field.\n'
 '- Aim for ~40/60 split between condition-vocabulary and category-grading on the GT side.\n'
 '- Aim for ~30/30/20/20 across ebay-listing / thrift-sourcing / reseller-finances / inventory-ops on the FD side.\n',
 380)

ON CONFLICT (key) DO NOTHING;
