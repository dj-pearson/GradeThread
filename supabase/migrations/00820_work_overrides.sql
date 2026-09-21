-- What the seller says, when they disagree with the planner (US-3182).
--
-- TWO TABLES BECAUSE THEY ARE TWO DIFFERENT FACTS. An override is an opinion
-- about a number and has to keep what it replaced. A suppression is a
-- preference about attention and has to expire. Folding them into one row
-- with nullable columns for both would mean every read carries the other's
-- shape and every constraint has to say "unless".
--
-- ⚠ THESE ARE PLANNER-ONLY AND MUST STAY THAT WAY. A seller saying "I think
-- this is worth $40 for planning" does NOT change inventory_items.target_price,
-- a grade report or anything the books read. Those have their own screens,
-- their own audit trails and their own consequences; a planner correction that
-- quietly repriced a live listing would be the worst defect this feature could
-- ship. Nothing outside the planner routes reads these tables, and
-- src/lib/work-overrides.ts carries the same warning at the top.
--
-- Deny-all RLS on both, service-role only, registered in SERVICE_ROLE_ONLY in
-- rls-guard_test.ts. A readable row names one of the seller's items and a
-- number they typed, which is theirs; a WRITABLE one would let a caller
-- suppress another tenant's shipping obligation, which is a row that makes a
-- seller miss a deadline.

CREATE TABLE IF NOT EXISTS public.flipdesk_work_overrides (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- The workspace owner. Every read and write is scoped on this (US-268).
  owner_user_id     uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  -- ON DELETE CASCADE rather than SET NULL: an override for a garment that no
  -- longer exists is not history worth keeping, unlike a work session, which
  -- is a record of an hour the seller really spent.
  inventory_item_id uuid NOT NULL REFERENCES public.inventory_items(id) ON DELETE CASCADE,
  -- NULL means the override applies to the item rather than to one task on it.
  -- A value range is about the garment; a duration is about the job.
  action_key        text,
  kind              text NOT NULL,
  -- The corrected figures. Which columns are used depends on `kind`, and the
  -- CHECK below is what stops a half-filled row.
  amount_minutes    integer,
  amount_cents      bigint,
  low_cents         bigint,
  high_cents        bigint,
  -- WHAT IT REPLACED (AC2). Without this "reset to our estimate" has nothing
  -- to reset to, and a seller who overrode a number in March has no way back.
  original_json     jsonb,
  source            text NOT NULL DEFAULT 'seller',
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.flipdesk_work_overrides
  DROP CONSTRAINT IF EXISTS flipdesk_work_overrides_kind_check;
ALTER TABLE public.flipdesk_work_overrides
  ADD CONSTRAINT flipdesk_work_overrides_kind_check
  CHECK (kind IN ('task_minutes', 'value_range', 'remaining_cost'));

-- A row has to carry the figures its own kind needs and no others. Without
-- this a `task_minutes` row with only `low_cents` filled reads as a valid
-- override and silently does nothing.
ALTER TABLE public.flipdesk_work_overrides
  DROP CONSTRAINT IF EXISTS flipdesk_work_overrides_shape_check;
ALTER TABLE public.flipdesk_work_overrides
  ADD CONSTRAINT flipdesk_work_overrides_shape_check
  CHECK (
    (kind = 'task_minutes'
      AND amount_minutes IS NOT NULL AND amount_minutes > 0
      AND amount_cents IS NULL AND low_cents IS NULL AND high_cents IS NULL)
    OR (kind = 'remaining_cost'
      AND amount_cents IS NOT NULL AND amount_cents >= 0
      AND amount_minutes IS NULL AND low_cents IS NULL AND high_cents IS NULL)
    OR (kind = 'value_range'
      AND low_cents IS NOT NULL AND high_cents IS NOT NULL
      AND low_cents >= 0 AND high_cents >= low_cents
      AND amount_minutes IS NULL AND amount_cents IS NULL)
  );

-- One override per owner, item, action and kind. A second correction REPLACES
-- the first (the route upserts on this), which is what a seller means when
-- they type a new number -- not a second opinion sitting beside the old one.
--
-- ⚠ NULLS NOT DISTINCT, AND PLAIN COLUMNS RATHER THAN coalesce(action_key,'').
-- Two reasons, and the second was measured rather than reasoned about:
--   1. NULL action_key means "this applies to the item, not to one task", and
--      Postgres treats NULLs as distinct by default -- so without this clause
--      the same item could carry two item-level overrides of the same kind and
--      the constraint would allow it.
--   2. PostgREST's upsert names COLUMNS in its ON CONFLICT, and an expression
--      index cannot be named that way. The first version used
--      coalesce(action_key, '') and every write failed with 42P10, "there is
--      no unique or exclusion constraint matching the ON CONFLICT
--      specification". The index was correct and unusable.
-- NULLS NOT DISTINCT is Postgres 15+; prod is 17.
CREATE UNIQUE INDEX IF NOT EXISTS uq_work_overrides_scope
  ON public.flipdesk_work_overrides (owner_user_id, inventory_item_id, action_key, kind)
  NULLS NOT DISTINCT;

CREATE INDEX IF NOT EXISTS idx_work_overrides_owner
  ON public.flipdesk_work_overrides (owner_user_id, inventory_item_id);

CREATE TABLE IF NOT EXISTS public.flipdesk_work_suppressions (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id     uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  inventory_item_id uuid NOT NULL REFERENCES public.inventory_items(id) ON DELETE CASCADE,
  action_key        text,
  kind              text NOT NULL,
  -- skip_session applies to ONE session and no other. A skip carried into
  -- tomorrow's plan would silently become a dismissal.
  session_id        uuid REFERENCES public.flipdesk_work_sessions(id) ON DELETE CASCADE,
  -- snooze only. A NULL here on a snooze row means it never expires, which is
  -- a dismissal nobody asked for -- the shape check below refuses it.
  until             timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.flipdesk_work_suppressions
  DROP CONSTRAINT IF EXISTS flipdesk_work_suppressions_kind_check;
ALTER TABLE public.flipdesk_work_suppressions
  ADD CONSTRAINT flipdesk_work_suppressions_kind_check
  CHECK (kind IN ('skip_session', 'snooze', 'dismiss'));

ALTER TABLE public.flipdesk_work_suppressions
  DROP CONSTRAINT IF EXISTS flipdesk_work_suppressions_shape_check;
ALTER TABLE public.flipdesk_work_suppressions
  ADD CONSTRAINT flipdesk_work_suppressions_shape_check
  CHECK (
    (kind = 'skip_session' AND session_id IS NOT NULL AND until IS NULL)
    OR (kind = 'snooze' AND until IS NOT NULL AND session_id IS NULL)
    OR (kind = 'dismiss' AND until IS NULL AND session_id IS NULL)
  );

-- Same treatment, and here BOTH nullable columns matter: action_key is null
-- for an item-level suppression and session_id is null for everything but a
-- skip. See the note above for why this is not a coalesce.
CREATE UNIQUE INDEX IF NOT EXISTS uq_work_suppressions_scope
  ON public.flipdesk_work_suppressions
    (owner_user_id, inventory_item_id, action_key, kind, session_id)
  NULLS NOT DISTINCT;

CREATE INDEX IF NOT EXISTS idx_work_suppressions_owner
  ON public.flipdesk_work_suppressions (owner_user_id, inventory_item_id);

-- Deny-all RLS on both. The seller reads and writes through an authenticated
-- edge route that scopes by owner; a policy here would add a second path to
-- the same rows with its own drift.
ALTER TABLE public.flipdesk_work_overrides ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.flipdesk_work_overrides FROM anon, authenticated;

ALTER TABLE public.flipdesk_work_suppressions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.flipdesk_work_suppressions FROM anon, authenticated;

DROP TRIGGER IF EXISTS set_work_overrides_updated_at ON public.flipdesk_work_overrides;
CREATE TRIGGER set_work_overrides_updated_at
  BEFORE UPDATE ON public.flipdesk_work_overrides
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS set_work_suppressions_updated_at ON public.flipdesk_work_suppressions;
CREATE TRIGGER set_work_suppressions_updated_at
  BEFORE UPDATE ON public.flipdesk_work_suppressions
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- US-1108: self-record the applied version so the edge boot guard stays truthful.
insert into public.applied_migrations (version) values ('00820') on conflict do nothing;
