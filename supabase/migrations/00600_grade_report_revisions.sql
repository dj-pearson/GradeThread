-- US-2569: a regraded certificate is revised, not vanished.
--
-- 00150 gave grade_reports a `superseded_at`, and regradeSubmission nulls the
-- old row's `certificate_id` at the same moment. Every public read filters on
-- `certificate_id IS NOT NULL`, so from that instant the old GT number resolves
-- to nothing: /cert/<id> 404s, /verify says not found, and the QR on a hangtag
-- a buyer is holding stops working.
--
-- For a PSA-style trust model that is worse than the alternative it replaces. A
-- certificate that says "revised on 2026-08-14, the current grade is GT-XXXXXXX"
-- keeps the promise the number made; one that 404s teaches buyers the number
-- cannot be relied on, which is the only thing the product is selling.
--
-- The pattern already exists here: support_kb_revisions (00183) and
-- pricing_plan_revisions (00486) are both append-only edit histories.
--
-- ⚠ TWO-PHASE BY NECESSITY. A regrade supersedes the old report BEFORE the new
-- one exists — the pipeline is re-kicked and the replacement report is written
-- minutes later, or never, if the regrade fails. So a row is INSERTed with the
-- superseded half filled and the superseding half NULL, then resolved exactly
-- once when the replacement lands. The trigger below makes the historical half
-- immutable and allows that single transition and nothing else; an unresolved
-- row is a truthful state ("revised, new grade pending") rather than a gap.

CREATE TABLE IF NOT EXISTS public.grade_report_revisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- The submission whose grade was revised. Not a foreign key, for the same
  -- reason grade_credit_transactions.user_id stopped being one in 00595: this is
  -- a public-facing durable record, and a cascade that erased it would make a
  -- live certificate URL start 404ing again.
  submission_id uuid NOT NULL,

  -- ── The retired grade, captured before certificate_id is nulled ──────────
  superseded_report_id          uuid NOT NULL,
  superseded_certificate_id     uuid,
  superseded_certificate_number text,
  superseded_overall_score      numeric(3,1),
  superseded_grade_tier         text,

  -- ── The replacement, filled in when it lands (see the trigger) ───────────
  superseding_report_id          uuid,
  superseding_certificate_id     uuid,
  superseding_certificate_number text,
  superseding_overall_score      numeric(3,1),
  superseding_grade_tier         text,

  reason        text,
  superseded_at timestamptz NOT NULL DEFAULT now(),
  resolved_at   timestamptz
);

COMMENT ON TABLE public.grade_report_revisions IS
  'US-2569: append-only history of superseded certificates. One row per '
  'supersede. The superseded_* half is immutable; the superseding_* half is '
  'filled exactly once when the replacement grade lands. Read by the public '
  'certificate and verify endpoints so a revised certificate resolves to its '
  'successor instead of 404ing.';

-- One row per retired report. A second supersede of the same report is a bug,
-- not a second revision.
CREATE UNIQUE INDEX IF NOT EXISTS grade_report_revisions_superseded_report_idx
  ON public.grade_report_revisions (superseded_report_id);

-- The two public lookups: by retired certificate id (/cert/:id) and by retired
-- number (/verify). Partial, because a report can be superseded before it was
-- ever certified.
CREATE INDEX IF NOT EXISTS grade_report_revisions_superseded_cert_idx
  ON public.grade_report_revisions (superseded_certificate_id)
  WHERE superseded_certificate_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS grade_report_revisions_superseded_number_idx
  ON public.grade_report_revisions (superseded_certificate_number)
  WHERE superseded_certificate_number IS NOT NULL;

-- Walking a chain forward: given a report, what replaced it.
CREATE INDEX IF NOT EXISTS grade_report_revisions_superseding_report_idx
  ON public.grade_report_revisions (superseding_report_id)
  WHERE superseding_report_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS grade_report_revisions_submission_idx
  ON public.grade_report_revisions (submission_id, superseded_at);

ALTER TABLE public.grade_report_revisions ENABLE ROW LEVEL SECURITY;
-- No policies: deny-all for anon and authenticated. The public certificate
-- endpoint reads it through the service-role client, which applies the same
-- withhold rules (isCertificateWithheld) it applies to a live certificate — a
-- revision must not become a way to read around a moderation hold.

-- ── Immutability, with exactly one permitted transition ──────────────────
--
-- "Append-only" here cannot mean "no UPDATE ever", because the replacement grade
-- does not exist when the row is written. It means the HISTORY cannot be
-- rewritten: the superseded half is frozen, and the resolution can be set once.
CREATE OR REPLACE FUNCTION public.guard_grade_report_revision()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION
      'grade_report_revisions is append-only: a certificate''s revision history '
      'cannot be deleted.'
      USING ERRCODE = 'restrict_violation';
  END IF;

  -- The historical half is frozen. IS DISTINCT FROM, not <>, so a NULL on either
  -- side is compared rather than yielding NULL and silently passing the check.
  IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW.submission_id IS DISTINCT FROM OLD.submission_id
    OR NEW.superseded_report_id IS DISTINCT FROM OLD.superseded_report_id
    OR NEW.superseded_certificate_id IS DISTINCT FROM OLD.superseded_certificate_id
    OR NEW.superseded_certificate_number IS DISTINCT FROM OLD.superseded_certificate_number
    OR NEW.superseded_overall_score IS DISTINCT FROM OLD.superseded_overall_score
    OR NEW.superseded_grade_tier IS DISTINCT FROM OLD.superseded_grade_tier
    OR NEW.superseded_at IS DISTINCT FROM OLD.superseded_at
  THEN
    RAISE EXCEPTION
      'grade_report_revisions: the superseded half of a revision is immutable.'
      USING ERRCODE = 'restrict_violation';
  END IF;

  -- The resolution may be filled ONCE. Re-pointing a resolved revision at a
  -- different successor would rewrite what a buyer was already shown.
  IF OLD.superseding_report_id IS NOT NULL
    AND NEW.superseding_report_id IS DISTINCT FROM OLD.superseding_report_id
  THEN
    RAISE EXCEPTION
      'grade_report_revisions: this revision is already resolved to report %.',
      OLD.superseding_report_id
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.guard_grade_report_revision() IS
  'US-2569: freezes the superseded half of a revision and allows the '
  'superseding half to be set exactly once. Refuses DELETE outright.';

DROP TRIGGER IF EXISTS grade_report_revisions_guard ON public.grade_report_revisions;
CREATE TRIGGER grade_report_revisions_guard
  BEFORE UPDATE OR DELETE ON public.grade_report_revisions
  FOR EACH ROW EXECUTE FUNCTION public.guard_grade_report_revision();

-- US-1108: self-record so the edge schema-version boot guard stays truthful.
INSERT INTO public.applied_migrations (version) VALUES ('00600') ON CONFLICT DO NOTHING;
