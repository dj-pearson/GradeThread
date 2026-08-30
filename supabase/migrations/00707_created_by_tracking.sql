-- US-3023: who CREATED an item or a listing, as opposed to who sourced it.
--
-- inventory_items.sourced_by answers "whose pick was this". Nothing answered
-- "who did the work", because every row is owned by the workspace OWNER --
-- user_id is the tenant key, not the actor -- and no client writes an actor.
--
-- Filled by a TRIGGER rather than by client code, deliberately. The alternative
-- is editing every insert path in the browser SPA, iOS, Android, the CSV
-- importer, the Sheets sync and the edge service, then keeping all of them in
-- step forever. One BEFORE INSERT trigger reading auth.uid() captures all of
-- them today and captures the next client for free.
--
-- ⚠ THIS REPORTS FORWARD ONLY. Existing rows are NOT backfilled and stay NULL,
-- because the information to backfill them does not exist anywhere -- no table
-- has ever recorded which member performed an insert. Any report on this column
-- must say so rather than showing a workspace an empty chart.
--
-- Service-role and job inserts (AutoLister, the server-side importer, the
-- Sheets projection) have no auth.uid(). They leave created_by NULL, which is
-- correct and is not an error: "a background job made this" is a true answer.
--
-- COLUMN-ALLOWLIST CHECK (US-3023 AC5), answered against the live database
-- rather than inferred: the deny-by-default self-update guard from 00526 is on
-- public.users ONLY (guard_users_protected_columns). inventory_items and
-- listings carry plain row-level UPDATE policies with no column list, so
-- created_by needs no allowlist entry -- and, for the same reason, nothing
-- stopped a later UPDATE from rewriting it. The immutability trigger below
-- exists because of that finding: an attribution column any client can
-- overwrite is not attribution.

-- ══════════════════════════════════════════════════════════
-- COLUMNS
-- ══════════════════════════════════════════════════════════

ALTER TABLE public.inventory_items
  ADD COLUMN IF NOT EXISTS created_by uuid REFERENCES public.users(id) ON DELETE SET NULL;

ALTER TABLE public.listings
  ADD COLUMN IF NOT EXISTS created_by uuid REFERENCES public.users(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.inventory_items.created_by IS
  'US-3023: the workspace member whose session inserted this row, set by a BEFORE INSERT trigger from auth.uid(). NULL for service-role and background-job inserts, and NULL for every row created before 00707 applied -- this is not backfilled.';
COMMENT ON COLUMN public.listings.created_by IS
  'US-3023: the workspace member whose session inserted this row, set by a BEFORE INSERT trigger from auth.uid(). NULL for service-role and background-job inserts, and NULL for every row created before 00707 applied -- this is not backfilled.';

-- (user_id, created_by): the throughput report always scopes to one tenant
-- first and then groups by member, so the tenant key leads.
CREATE INDEX IF NOT EXISTS idx_inventory_items_user_created_by
  ON public.inventory_items(user_id, created_by);
CREATE INDEX IF NOT EXISTS idx_listings_user_created_by
  ON public.listings(user_id, created_by);

-- ══════════════════════════════════════════════════════════
-- STAMP ON INSERT
-- ══════════════════════════════════════════════════════════

-- coalesce, not an unconditional assignment: a caller that already knows the
-- actor (a future edge route acting on a member's behalf) may pass it, and this
-- must not clobber that. When auth.uid() is NULL and nothing was passed, the
-- column stays NULL and the insert proceeds.
CREATE OR REPLACE FUNCTION public.set_created_by()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  NEW.created_by := coalesce(NEW.created_by, auth.uid());
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.set_created_by() IS
  'US-3023: stamps created_by from auth.uid() on insert. Leaves it NULL for service-role and job inserts, which is a true answer rather than a failure.';

DROP TRIGGER IF EXISTS set_inventory_items_created_by ON public.inventory_items;
CREATE TRIGGER set_inventory_items_created_by
  BEFORE INSERT ON public.inventory_items
  FOR EACH ROW EXECUTE FUNCTION public.set_created_by();

DROP TRIGGER IF EXISTS set_listings_created_by ON public.listings;
CREATE TRIGGER set_listings_created_by
  BEFORE INSERT ON public.listings
  FOR EACH ROW EXECUTE FUNCTION public.set_created_by();

-- ══════════════════════════════════════════════════════════
-- KEEP IT HONEST
-- ══════════════════════════════════════════════════════════

-- Attribution that a later UPDATE can rewrite is not attribution, and the
-- allowlist check above found nothing standing in the way of one. This is not
-- primarily about a malicious teammate: the ordinary way it would break is a
-- client that reads a whole row, changes one field and writes the whole object
-- back, carrying a stale or absent created_by with it.
--
-- Service-role keeps the ability to correct a row -- the guard checks
-- auth.role() the same way guard_users_protected_columns does, so an operator
-- script and a SECURITY DEFINER path can still fix a mistake.
CREATE OR REPLACE FUNCTION public.guard_created_by_immutable()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF coalesce(auth.role(), '') = 'service_role' THEN
    RETURN NEW;
  END IF;
  -- Silently pin rather than raise. A whole-row write-back is a normal client
  -- pattern here, and failing those updates would break saving an item to
  -- protect a reporting column.
  NEW.created_by := OLD.created_by;
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.guard_created_by_immutable() IS
  'US-3023: created_by is set once, at insert. An authenticated UPDATE cannot change it -- the old value is pinned back silently, because whole-row write-back is a normal client pattern and failing the save would be worse than ignoring the field. Service-role may still correct it.';

DROP TRIGGER IF EXISTS guard_inventory_items_created_by ON public.inventory_items;
CREATE TRIGGER guard_inventory_items_created_by
  BEFORE UPDATE ON public.inventory_items
  FOR EACH ROW
  WHEN (OLD.created_by IS DISTINCT FROM NEW.created_by)
  EXECUTE FUNCTION public.guard_created_by_immutable();

DROP TRIGGER IF EXISTS guard_listings_created_by ON public.listings;
CREATE TRIGGER guard_listings_created_by
  BEFORE UPDATE ON public.listings
  FOR EACH ROW
  WHEN (OLD.created_by IS DISTINCT FROM NEW.created_by)
  EXECUTE FUNCTION public.guard_created_by_immutable();

-- US-1108: self-record the applied version so the edge boot guard stays truthful.
insert into public.applied_migrations (version) values ('00707') on conflict do nothing;
