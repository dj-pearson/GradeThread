-- US-2481: queue extension work from mobile, drain it on the desktop.
--
-- Extension-mechanism channels (Poshmark/Mercari/Grailed/Vinted/Facebook) can
-- only be acted on from the seller's own logged-in browser — see
-- vault/60-decisions/adr-no-server-side-marketplace-automation.md. The cost of
-- that decision is that a seller sourcing with only a phone cannot cross-list,
-- and a delist after a sale waits until the desktop next opens.
--
-- This table is the honest answer: the phone records WHAT to do, the desktop
-- extension drains it. It is deliberately NOT the cloud-session model — read the
-- payload constraint below, which is the ADR's first bright line written as SQL.
--
-- Process for adding a channel: vault/30-platform/closing-a-coverage-gap.md.

-- Does this document carry a key that looks like a way IN, anywhere inside it?
--
-- WHY A FUNCTION AND NOT `payload ?| ARRAY[...]`. The array operator was the
-- first version of this and it was weaker than the sentence above it claimed:
-- `?|` tests TOP-LEVEL keys only, and case-sensitively. So `{"session_cookie":…}`
-- and `{"auth":{"cookie":…}}` both sailed through a constraint whose whole
-- purpose was to stop exactly those. A guard that is narrower than its comment
-- is worse than no guard, because it is read as covering the case it misses.
--
-- This walks the whole document, normalises each key the same way
-- lib/extension-queue.ts does (lowercase, strip separators) and matches on the
-- SUFFIX so renaming `cookie` to `poshmarkCookie` is not a bypass. Depth-capped
-- at 8, which is deeper than any real instruction and stops a pathological
-- document from making an INSERT expensive.
CREATE OR REPLACE FUNCTION public.jsonb_has_credential_key(doc jsonb)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  WITH RECURSIVE walk(node, depth) AS (
    SELECT doc, 0
    UNION ALL
    SELECT c.child, walk.depth + 1
      FROM walk
      CROSS JOIN LATERAL (
        -- The CASE guards are load-bearing: jsonb_each errors on a non-object
        -- and jsonb_array_elements on a non-array, and a WHERE clause would not
        -- stop the function being evaluated first.
        SELECT e.value AS child
          FROM jsonb_each(
            CASE WHEN jsonb_typeof(walk.node) = 'object' THEN walk.node ELSE '{}'::jsonb END
          ) AS e
        UNION ALL
        SELECT a.value
          FROM jsonb_array_elements(
            CASE WHEN jsonb_typeof(walk.node) = 'array' THEN walk.node ELSE '[]'::jsonb END
          ) AS a
      ) AS c
     WHERE walk.depth < 8
  )
  SELECT EXISTS (
    SELECT 1
      FROM walk
      CROSS JOIN LATERAL jsonb_object_keys(
        CASE WHEN jsonb_typeof(walk.node) = 'object' THEN walk.node ELSE '{}'::jsonb END
      ) AS k(key)
     WHERE regexp_replace(lower(k.key), '[^a-z]', '', 'g') ~
       '(password|passwd|pass|pwd|cookies|cookie|sessioncookie|sessionid|session|credentials|credential|authtoken|accesstoken|refreshtoken|bearer|csrf|apikey|secret)$'
  );
$$;

COMMENT ON FUNCTION public.jsonb_has_credential_key(jsonb) IS
  'US-2481: true when a jsonb document carries a credential-shaped key at any '
  'depth. Backs the extension_work_queue payload constraint — GradeThread never '
  'stores a marketplace password or session cookie.';

CREATE TABLE IF NOT EXISTS public.extension_work_queue (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,

  -- WHAT to do. Three verbs, matching the three things the extension can run.
  kind              text NOT NULL CHECK (kind IN ('list', 'delist', 'share')),
  platform          text NOT NULL,

  -- WHICH thing to do it to. Both nullable because a share run targets the
  -- seller's whole closet rather than one row.
  inventory_item_id uuid REFERENCES public.inventory_items(id) ON DELETE CASCADE,
  listing_id        uuid REFERENCES public.listings(id) ON DELETE CASCADE,

  -- The instruction. An item id, a locale key, a share count — never a way IN.
  --
  -- THE CONSTRAINT BELOW IS THE ADR'S FIRST BRIGHT LINE, IN SQL. GradeThread's
  -- servers never hold a marketplace password or session cookie for a no-API
  -- channel. Written as prose in an ADR that is a promise; written here it is
  -- enforced, and a future feature that "just needs to stash the session for a
  -- moment" fails its INSERT instead of quietly becoming the cloud model this
  -- whole design exists to refuse.
  payload           jsonb NOT NULL DEFAULT '{}'::jsonb
    CONSTRAINT extension_work_queue_no_credentials
      CHECK (NOT public.jsonb_has_credential_key(payload)),

  status            text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'claimed', 'done', 'failed', 'expired')),

  -- Which extension install took it, and when. Claiming is what stops two open
  -- browsers running the same share job twice.
  claimed_at        timestamptz,
  claimed_by        text,
  attempts          integer NOT NULL DEFAULT 0,

  completed_at      timestamptz,
  -- What happened, as the extension reported it. Bounded by the edge.
  result            jsonb,

  -- US-2481 AC6: queued work EXPIRES and is reported. A job that sits forever is
  -- worse than one that fails: the seller believes it is pending, and for a
  -- delist that belief is what turns into a double sale. The sweep flips these
  -- to 'expired' and the seller is shown them.
  expires_at        timestamptz NOT NULL DEFAULT (now() + interval '7 days'),

  -- Where it was queued from, so the UI can say "queued from your phone".
  source            text NOT NULL DEFAULT 'mobile'
    CHECK (source IN ('mobile', 'web', 'ios', 'android')),

  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

-- The drain query: one tenant's runnable work, oldest first.
CREATE INDEX IF NOT EXISTS idx_extension_work_queue_drain
  ON public.extension_work_queue (user_id, status, created_at);

-- The expiry sweep, and the "what is still outstanding" read.
CREATE INDEX IF NOT EXISTS idx_extension_work_queue_expiry
  ON public.extension_work_queue (status, expires_at)
  WHERE status IN ('queued', 'claimed');

DROP TRIGGER IF EXISTS set_extension_work_queue_updated_at
  ON public.extension_work_queue;
CREATE TRIGGER set_extension_work_queue_updated_at
  BEFORE UPDATE ON public.extension_work_queue
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- Re-assert the constraint on a re-run. `CREATE TABLE IF NOT EXISTS` skips the
-- whole block when the table already exists, so a table created by an earlier
-- version of this file would keep the earlier, weaker check. Migrations are
-- re-run wholesale by apply-prod-migrations.sh, and "idempotent" has to mean
-- converges-to-this, not does-nothing-the-second-time.
ALTER TABLE public.extension_work_queue
  DROP CONSTRAINT IF EXISTS extension_work_queue_no_credentials;
ALTER TABLE public.extension_work_queue
  ADD CONSTRAINT extension_work_queue_no_credentials
  CHECK (NOT public.jsonb_has_credential_key(payload));

-- RLS: a seller sees and manages only their own queued work. The edge uses the
-- service-role client and bypasses this, which is why every edge query is also
-- explicitly scoped (US-268) and covered in tenant-isolation_test.ts — RLS here
-- is the second lock, not the only one.
ALTER TABLE public.extension_work_queue ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS extension_work_queue_select_own ON public.extension_work_queue;
CREATE POLICY extension_work_queue_select_own
  ON public.extension_work_queue FOR SELECT
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS extension_work_queue_insert_own ON public.extension_work_queue;
CREATE POLICY extension_work_queue_insert_own
  ON public.extension_work_queue FOR INSERT
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS extension_work_queue_update_own ON public.extension_work_queue;
CREATE POLICY extension_work_queue_update_own
  ON public.extension_work_queue FOR UPDATE
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS extension_work_queue_delete_own ON public.extension_work_queue;
CREATE POLICY extension_work_queue_delete_own
  ON public.extension_work_queue FOR DELETE
  USING (auth.uid() = user_id);

COMMENT ON TABLE public.extension_work_queue IS
  'US-2481: extension work queued from mobile, drained by the desktop Lister. '
  'Stores WHAT to do only — never a marketplace credential or session cookie '
  '(enforced by extension_work_queue_no_credentials).';

-- US-1108 self-record footer.
insert into public.applied_migrations (version) values ('00588') on conflict do nothing;
