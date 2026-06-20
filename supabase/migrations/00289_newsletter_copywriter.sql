-- US-918: AI newsletter copywriter ("content-ai-email").
--
-- The autonomous copywriter (lib/content-ai-email.ts) generates a complete weekly
-- newsletter issue and persists it to newsletter_issues as a `draft`. This
-- migration adds the columns that draft needs beyond US-930's substrate, seeds
-- the curated email knowledge docs the prompt loads, extends content_surface so
-- the issue's history can be deduped, and installs a trigger that appends the
-- chosen topic + distilled summary to content_history_index ON SEND (AC5) — for
-- EVERY send path, so future issues don't repeat the topic.
--
-- Additive + idempotent.

-- ── content_surface enum: add 'email' ────────────────────────────────────────
-- ALTER TYPE ... ADD VALUE must run OUTSIDE the transaction block below (the new
-- value must be committed before the trigger function that uses it is created and
-- validated). Idempotent via IF NOT EXISTS.
ALTER TYPE public.content_surface ADD VALUE IF NOT EXISTS 'email';

BEGIN;

-- ── newsletter_issues: copywriter columns ────────────────────────────────────
-- intro / footer_note carry the lede + sign-off the copywriter produces; the
-- generation provenance (model_used, prompt_version, prompt_tokens,
-- completion_tokens) makes each issue auditable + feeds AI-spend reporting; and
-- generated_topic / generated_summary are the dedup payload the send trigger
-- appends to content_history_index.
ALTER TABLE public.newsletter_issues
  ADD COLUMN IF NOT EXISTS intro              text,
  ADD COLUMN IF NOT EXISTS footer_note        text,
  ADD COLUMN IF NOT EXISTS model_used         text,
  ADD COLUMN IF NOT EXISTS prompt_version     text,
  ADD COLUMN IF NOT EXISTS prompt_tokens      integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS completion_tokens  integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS generated_topic    text,
  ADD COLUMN IF NOT EXISTS generated_summary  text;

-- ── Seed the email knowledge docs ────────────────────────────────────────────
-- The copywriter loads these three keys into every issue prompt (the email
-- analogues of brand.voice / blog.*.style / seo.pillars). Seeded once; admins can
-- refine them in /admin/content/knowledge. ON CONFLICT DO NOTHING keeps an admin
-- edit from being clobbered on a re-run.
INSERT INTO public.content_knowledge (key, title, body_md, token_count_est) VALUES
('email.voice',
 'Newsletter Voice & Persona',
 E'# GradeThread Newsletter Voice\n\n'
 'We write like a seasoned reseller who is also a fabric nerd, emailing a smart peer. Plain English, '
 'short sentences, "we" and "you" (never "the user"). Teach first, sell second — earn the click. '
 'Concrete numbers beat vague claims. No hype, no fake urgency, no exclamation stacking.\n\n'
 '## Banned\n"game-changer", "revolutionize", "supercharge", "unlock", "seamless", "leverage" (verb), '
 '"in today''s fast-paced world", "act now". No fabricated stats, features, or customer counts.\n\n'
 '## Always\nLead with one specific, useful idea. Make every section skimmable. Close with a single, '
 'low-pressure call to action that points at a real page.',
 90),
('email.structure',
 'Weekly Newsletter Structure',
 E'# Weekly Issue Shape\n\n'
 '1. **Subject** (<=60 chars) + 2-3 distinct A/B variants + **preheader** (<=110 chars) that complements '
 '(does not repeat) the subject.\n'
 '2. **Intro** — one short paragraph framing this week''s focus.\n'
 '3. **What''s new** — ONLY when there are real product updates in the inputs; otherwise skip it entirely '
 '(never invent news).\n'
 '4. **Teach something** — one genuinely useful, actionable idea about the week''s topic.\n'
 '5. **Quick tip** — a single concrete tip the reader can apply today.\n'
 '6. **CTA** — one low-pressure call to action linking a real gradethread.com page.\n'
 '7. **Footer note** — a brief, human sign-off above the legal/unsubscribe footer.\n\n'
 'Keep total reading time under two minutes. Bodies are short HTML (<p>/<ul>/<li>/<strong>/<em>/<a> only).',
 120),
('email.value_props',
 'Newsletter Value Props',
 E'# What We May Credibly Claim\n\n'
 '- Standardized 1.0-10.0 condition grades with a detailed condition report.\n'
 '- A shareable, buyer-verifiable certificate per graded item.\n'
 '- Consistent grading vocabulary (tiers NWT/NWOT/Excellent/Very Good/Good/Fair/Poor; factors Fabric '
 'Condition, Structural Integrity, Cosmetic Appearance, Functional Elements, Odor & Cleanliness).\n'
 '- FlipDesk runs the full reselling lifecycle: source -> catalog -> measure -> photograph -> grade -> '
 'comp -> draft -> list -> sell -> ship -> reconcile.\n\n'
 'Do NOT claim specific results, savings percentages, dispute-reduction numbers, or customer counts unless '
 'they appear verbatim in the issue inputs.',
 110)
ON CONFLICT (key) DO NOTHING;

-- ── Dedup-on-send trigger (AC5) ──────────────────────────────────────────────
-- When an issue transitions to `sent`, append the chosen topic + the distilled
-- summary to content_history_index (surface 'email') so the copywriter's history
-- context excludes it next week. Covers BOTH the plain dispatch and the A/B
-- finalize send paths without touching their (heavily tested) code. Best-effort:
-- a bookkeeping failure must never block a send.
CREATE OR REPLACE FUNCTION public.newsletter_issue_history_on_send()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_focus public.content_product;
BEGIN
  IF NEW.status = 'sent' AND COALESCE(OLD.status, '') <> 'sent' THEN
    v_focus := CASE
      WHEN NEW.product_focus IN ('gradethread', 'flipdesk', 'both')
        THEN NEW.product_focus::public.content_product
      ELSE 'both'::public.content_product
    END;
    BEGIN
      INSERT INTO public.content_history_index
        (surface, product_focus, post_id, title, primary_keyword,
         secondary_keywords, summary_one_line, published_at)
      VALUES
        ('email'::public.content_surface, v_focus, NULL,
         COALESCE(NULLIF(NEW.generated_topic, ''), NULLIF(NEW.title, ''), 'Newsletter issue'),
         NULLIF(NEW.pillar, ''),
         '{}',
         COALESCE(NULLIF(NEW.generated_summary, ''), NULLIF(NEW.preheader, '')),
         COALESCE(NEW.sent_at, now()));
    EXCEPTION WHEN OTHERS THEN
      -- Never block a send on history bookkeeping.
      NULL;
    END;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_newsletter_issue_history_on_send ON public.newsletter_issues;
CREATE TRIGGER trg_newsletter_issue_history_on_send
  AFTER UPDATE OF status ON public.newsletter_issues
  FOR EACH ROW EXECUTE FUNCTION public.newsletter_issue_history_on_send();

COMMIT;

-- US-1108: self-record this migration's version so the edge schema-version
-- guard (US-778) stays in sync regardless of apply method.
INSERT INTO public.applied_migrations (version) VALUES ('00289')
ON CONFLICT (version) DO NOTHING;
