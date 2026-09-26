-- US-3532: a retried /api/grade/submit returns the first submission.
--
-- The server derives its charge key from the submission id it creates, so a
-- client that lost the 201 (a phone dropping off wifi) and pressed Submit again
-- got a SECOND submission and a SECOND charge. The client now sends an
-- Idempotency-Key header per submit; the edge stores it here, and a repeat for
-- the same owner answers with the existing submission instead of creating one.
-- The unique index is what makes two concurrent retries safe: the loser's
-- insert gets 23505 and reads the winner back.

ALTER TABLE public.submissions
  ADD COLUMN IF NOT EXISTS idempotency_key text;

CREATE UNIQUE INDEX IF NOT EXISTS submissions_owner_idempotency_key
  ON public.submissions (user_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

COMMENT ON COLUMN public.submissions.idempotency_key IS
  'US-3532: client Idempotency-Key for /api/grade/submit; unique per owner.';

-- US-1108: self-record this migration's version so the edge schema-version guard
-- (US-778) stays in sync regardless of apply method.
INSERT INTO public.applied_migrations (version) VALUES ('00842') ON CONFLICT DO NOTHING;
