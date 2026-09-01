-- 00708 — RN/CA lookup-demand counters (US-9036)
--
-- A NUMBER SOMEBODY TYPED IS NOT A NUMBER WE SAW. This is deliberately a
-- separate table from registered_number_sightings (00501) rather than a second
-- column on it. A sighting is a claim that our OCR read the number off a real
-- garment tag, and /rn/:number prints that count as the one line a mirror site
-- cannot print. Folding typed lookups into it would inflate the number that
-- carries the page's whole credibility, and 00501's own CHECK (sighting_count
-- > 0) makes a lookup-only row impossible to represent there honestly anyway.
--
-- What this measures instead: which numbers people ASK for and we cannot
-- answer. That is the seeder's work queue, ranked by real demand rather than by
-- our guess at which brands matter. See vault/40-growth/rn-lookup.md.
--
-- AGGREGATE ONLY: one row per registry number, no owner column and no request
-- identity, so a row cannot say who looked a number up. Deny-all RLS; written
-- and read by the service-role edge client only.

CREATE TABLE IF NOT EXISTS public.registered_number_lookups (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Canonical comparable form from registeredNumberKey(): 'RN:87370' / 'CA:32054'.
  registry_key  text NOT NULL,
  kind          text NOT NULL CHECK (kind IN ('RN', 'CA')),
  digits        text NOT NULL,
  lookup_count  integer NOT NULL DEFAULT 1 CHECK (lookup_count > 0),
  -- Flipped when a registry row answers the number, so the queue drains the
  -- same way 00501's does and a resolved number stops being re-searched.
  resolved      boolean NOT NULL DEFAULT false,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS registered_number_lookups_key_idx
  ON public.registered_number_lookups (registry_key);

-- The work queue: unanswered, most-asked first.
CREATE INDEX IF NOT EXISTS registered_number_lookups_queue_idx
  ON public.registered_number_lookups (resolved, lookup_count DESC);

ALTER TABLE public.registered_number_lookups ENABLE ROW LEVEL SECURITY;
-- No policies, deliberately: non-tenant aggregate counters, same class as 00501.

DROP TRIGGER IF EXISTS set_registered_number_lookups_updated_at
  ON public.registered_number_lookups;
CREATE TRIGGER set_registered_number_lookups_updated_at
  BEFORE UPDATE ON public.registered_number_lookups
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- Increment-or-insert in ONE statement, mirroring 00501's RPC: two concurrent
-- lookups of the same number must not lose a count to a read-modify-write race.
-- Returns nothing — the caller is fire-and-forget and must never make somebody
-- wait on bookkeeping for an answer we already have.
--
-- ── NO REVOKE, AND NOT SECURITY DEFINER (US-2403) ──────────────────────────
--
-- 00501's RPC is SECURITY DEFINER with a REVOKE on anon and authenticated, and
-- copying that pair here would have been a database-restart bug. On this
-- Postgres image supautils decorates a permission-denied error with a GRANT
-- hint for any role in `supautils.hint_roles`, and building that hint SEGFAULTS
-- the backend on a FUNCTION denial, killing every other session with it. `anon`
-- is the role behind the key that ships in the browser bundle, so a revoked
-- function is one HTTP call away from restarting prod. 00501 pre-dates the
-- finding and is tolerated for that reason; a new file may not repeat it.
--
-- So authorization comes from the table instead of from EXECUTE. The function
-- is SECURITY INVOKER, which is the DEFAULT and is stated here only because the
-- migration it was modelled on says otherwise. registered_number_lookups has
-- RLS on and no policies, so the service-role client the edge uses bypasses it
-- and writes, while anon or authenticated hit an ordinary row-level-security
-- refusal on the INSERT. That is a TABLE denial, not a function-EXECUTE denial,
-- so it takes the normal 42501 path every deny-all table in this schema already
-- uses, and nothing builds a hint.
CREATE OR REPLACE FUNCTION public.record_registered_number_lookup(
  p_registry_key text,
  p_kind text,
  p_digits text
) RETURNS void
LANGUAGE sql
SET search_path = public
AS $$
  INSERT INTO public.registered_number_lookups AS l
    (registry_key, kind, digits)
  VALUES (p_registry_key, p_kind, p_digits)
  ON CONFLICT (registry_key) DO UPDATE SET
    lookup_count = l.lookup_count + 1,
    last_seen_at = now(),
    updated_at = now();
$$;

-- US-1108: self-record the applied version so the edge boot guard stays truthful.
insert into public.applied_migrations (version) values ('00708') on conflict do nothing;
