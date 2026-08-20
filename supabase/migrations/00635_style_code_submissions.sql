-- 00635 — what the person holding the garment says it is (US-2749)
--
-- The reseller who looks up a code we cannot name is the best evidence in the
-- world for that code: they are holding the tag. Today the lookup tells them we
-- do not know and the conversation ends there.
--
-- ── WHY A SEPARATE TABLE AND NOT A style_code_names ROW ─────────────────────
--
-- record_style_code_name upserts on (brand_key, style_code_norm, source) and
-- OVERWRITES name and supporting. That is right for a source with one opinion
-- — a consensus recomputed, a seller correcting themselves — and wrong for
-- anonymous submissions, where the second submission may DISAGREE with the
-- first. Through that RPC, disagreement silently replaces agreement and the
-- count resets, so two people saying "Scuba Hoodie" and one saying something
-- else could leave the wrong answer standing with no trace of the two.
--
-- So submissions are counted per (code, NAME), and a name is promoted into
-- style_code_names only once enough people independently said the same thing.
-- Dissent stays visible rather than overwriting.
--
-- ── WHAT IS NOT STORED ──────────────────────────────────────────────────────
--
-- No account, no session, no IP, no user agent. A submitter needs no login,
-- because requiring one would exclude exactly the person this exists for, and
-- recording who they were buys nothing the counter does not already give. Abuse
-- is handled at the route by the same rate limiter the other public write
-- surfaces use, not by identifying strangers.
--
-- Same class of aggregate reference data as 00503, 00627 and 00628: brand,
-- code, name, counter. Deny-all RLS.

CREATE TABLE IF NOT EXISTS public.style_code_submissions (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_key         text NOT NULL DEFAULT '',
  -- Canonical style number — the same key style_code_names uses (US-2714).
  style_code_norm   text NOT NULL,
  -- What the submitter typed, kept verbatim for display and for debugging a
  -- canonicalization that got it wrong.
  style_code_raw    text NOT NULL,
  -- Comparable form of the name: lowercased, punctuation collapsed. Two people
  -- writing "Scuba Oversized Half-Zip" and "scuba oversized half zip" agree,
  -- and counting them separately would mean nobody ever reaches the bar.
  name_norm         text NOT NULL CHECK (btrim(name_norm) <> ''),
  -- The first spelling submitted, shown if this name wins.
  name              text NOT NULL CHECK (btrim(name) <> ''),
  submissions       integer NOT NULL DEFAULT 1 CHECK (submissions > 0),
  first_seen_at     timestamptz NOT NULL DEFAULT now(),
  last_seen_at      timestamptz NOT NULL DEFAULT now(),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

-- Plain-column unique key so PostgREST upsert can target it (the
-- garment_baselines lesson: onConflict cannot name an expression index).
CREATE UNIQUE INDEX IF NOT EXISTS style_code_submissions_key_idx
  ON public.style_code_submissions (brand_key, style_code_norm, name_norm);

-- The promotion read: every name offered for one code, best-supported first.
CREATE INDEX IF NOT EXISTS style_code_submissions_lookup_idx
  ON public.style_code_submissions (brand_key, style_code_norm, submissions DESC);

ALTER TABLE public.style_code_submissions ENABLE ROW LEVEL SECURITY;
-- No policies, deliberately: the edge service-role client is the only reader
-- and writer. A public SELECT policy would publish the losing answers too,
-- which is a map of what the crowd guessed wrong.

DROP TRIGGER IF EXISTS set_style_code_submissions_updated_at
  ON public.style_code_submissions;
CREATE TRIGGER set_style_code_submissions_updated_at
  BEFORE UPDATE ON public.style_code_submissions
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- Count-or-insert in one statement. Two people submitting the same name for the
-- same code must not race a count away, and the caller is a public endpoint.
CREATE OR REPLACE FUNCTION public.record_style_code_submission(
  p_brand_key text,
  p_style_code_norm text,
  p_style_code_raw text,
  p_name_norm text,
  p_name text
) RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count integer;
BEGIN
  INSERT INTO public.style_code_submissions AS s
    (brand_key, style_code_norm, style_code_raw, name_norm, name)
  VALUES (
    coalesce(btrim(p_brand_key), ''),
    p_style_code_norm,
    p_style_code_raw,
    p_name_norm,
    btrim(p_name)
  )
  ON CONFLICT (brand_key, style_code_norm, name_norm) DO UPDATE SET
    submissions = s.submissions + 1,
    last_seen_at = now(),
    updated_at = now()
    -- `name` is NOT updated: the first spelling submitted is the display form,
    -- so a later submitter cannot restyle an answer other people agreed to.
  RETURNING s.submissions INTO v_count;
  RETURN v_count;
END;
$$;

-- ⚠ DELIBERATELY NO REVOKE HERE, and that is not an oversight.
--
-- US-2403: on this Postgres image a DENIED function call from `anon` or
-- `authenticated` SEGFAULTS the backend and restarts the whole database,
-- because supautils appends a GRANT hint to the error. `anon` is the key that
-- ships in the browser bundle, so a revoke here creates a crash surface any
-- visitor can reach. That is why 00527 is parked as .BLOCKED, and why 00609,
-- 00627 and 00628 carry this same note.
--
-- US-2282 AC4: this function is invoked ONLY by the edge through the
-- service-role client, so service_role is the whole of its intended audience.
GRANT EXECUTE ON FUNCTION public.record_style_code_submission(
  text, text, text, text, text
) TO service_role;

-- US-2749: `public` joins the source vocabulary, ranked BELOW consensus in
-- lib/style-code-names.ts. An anonymous stranger must never outrank a seller
-- holding the garment or an admin who checked by hand.
ALTER TABLE public.style_code_names
  DROP CONSTRAINT IF EXISTS style_code_names_source_check;
ALTER TABLE public.style_code_names
  ADD CONSTRAINT style_code_names_source_check
  CHECK (source IN ('consensus', 'seller', 'admin', 'official', 'public'));

-- US-1108: self-record the applied version so the edge boot guard stays truthful.
insert into public.applied_migrations (version) values ('00635') on conflict do nothing;
