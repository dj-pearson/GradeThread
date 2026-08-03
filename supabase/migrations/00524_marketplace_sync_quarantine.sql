-- US-2324 AC3: stop retrying a record that fails every time, forever.
--
-- The Etsy and Depop syncs keep NO CURSOR: every run re-reads the provider's
-- recent window from the start. US-2324 gave each record its own try/catch so a
-- poison record no longer kills the tail behind it — but it is still re-attempted
-- on every single run, and the failure is only ever a line in a log nobody reads.
-- This table is where a repeat offender goes so the loop can skip it and an
-- operator can see it.
--
-- COLUMN NAME `owner_user_id`, not `user_id`, and it is not a style choice:
-- rls-guard_test discovers TENANT tables by looking for the literal string
-- `user_id` in the CREATE TABLE block, and this is an OPERATOR table with no
-- browser reader. The migrations skill calls this out.

CREATE TABLE IF NOT EXISTS public.marketplace_sync_failures (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Whose connection the record belongs to. ON DELETE CASCADE: a deleted account
  -- has no records left to quarantine, unlike a cost or audit row.
  owner_user_id  uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  marketplace    text NOT NULL,
  -- The provider's own id for the record (an Etsy receipt id, a Depop order id).
  -- Text because the two providers do not agree on a shape.
  external_id    text NOT NULL,
  attempts       integer NOT NULL DEFAULT 1 CHECK (attempts > 0),
  last_error     text,
  first_failed_at timestamptz NOT NULL DEFAULT now(),
  last_failed_at  timestamptz NOT NULL DEFAULT now(),
  -- Set when an operator has looked at it. A quarantined row stays skipped until
  -- this is cleared, so clearing it is the "try again" action.
  quarantined_at timestamptz,
  UNIQUE (owner_user_id, marketplace, external_id)
);

COMMENT ON TABLE public.marketplace_sync_failures IS
  'US-2324: per-record sync failures for the cursorless Etsy/Depop syncs. A record that fails repeatedly is quarantined so the loop skips it instead of retrying it every run forever.';

-- The loop reads this per (owner, marketplace) on every pass, so the lookup has
-- to be cheap. The UNIQUE above already covers it; this partial index serves the
-- operator view — "what is currently quarantined" — without scanning the rest.
CREATE INDEX IF NOT EXISTS idx_marketplace_sync_failures_quarantined
  ON public.marketplace_sync_failures (marketplace, last_failed_at DESC)
  WHERE quarantined_at IS NOT NULL;

ALTER TABLE public.marketplace_sync_failures ENABLE ROW LEVEL SECURITY;

-- DENY-ALL, deliberately: zero policies, so the browser (anon/authenticated)
-- can neither read nor write. Only the service-role client, which bypasses RLS,
-- touches this. Reading it from the browser would show a seller the raw provider
-- error text for their own orders; writing it would let them clear their own
-- quarantine and re-poison the sync.
REVOKE ALL ON public.marketplace_sync_failures FROM anon, authenticated;

insert into public.applied_migrations (version) values ('00524') on conflict do nothing;
