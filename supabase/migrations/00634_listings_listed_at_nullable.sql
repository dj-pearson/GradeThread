-- listings.listed_at becomes nullable (US-2727).
--
-- US-1877 drew the line between PREFILLED and PUBLISHED: the extension filling
-- a marketplace form is not a live listing, so the row it writes is a draft and
-- must not carry a listed_at -- a date there is what made phantom rows look
-- like real, dateable cross-listings in the pipeline.
--
-- The code has written `listed_at: null` for a draft ever since. The column has
-- been `NOT NULL DEFAULT now()` since 00002 and no migration ever changed it,
-- so every INSERT down that path has failed with 23502 on every environment.
-- Found in production 2026-08-20 on a real Poshmark cross-post: the form was
-- filled, the seller had a listing in front of them, and FlipDesk recorded
-- nothing.
--
-- The rest of the codebase already agrees the column is nullable -- the public
-- API types it `listed_at: string | null` (lib/api-listings.ts) and the OpenAPI
-- spec declares `nullable: true`. The database was the piece out of step.
--
-- The DEFAULT now() stays. Dropping NOT NULL is what unblocks an explicit null;
-- removing the default would silently change every other writer that omits the
-- column, which is a separate decision and not this one.
--
-- Views that read this column (items_full, the finances dashboard) already
-- guard with `WHEN l.listed_at IS NOT NULL`, so a null is the case they were
-- written for.

ALTER TABLE public.listings
  ALTER COLUMN listed_at DROP NOT NULL;

COMMENT ON COLUMN public.listings.listed_at IS
  'When this listing went live on its marketplace. NULL for a draft -- a row '
  'the extension prefilled but the seller has not published (US-1877). Never '
  'backfill it: a date here means the listing is real and dateable.';

-- US-1108: self-record the applied version so the edge boot guard stays truthful.
insert into public.applied_migrations (version) values ('00634') on conflict do nothing;
