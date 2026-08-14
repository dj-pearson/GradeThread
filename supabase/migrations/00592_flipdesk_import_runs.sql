-- US-2518 — durable, reversible CSV inventory import.
--
-- The importer ran entirely in the browser and told the seller "Don't close
-- this tab". A closed tab, a lost connection or a sleeping laptop left the
-- catalog half-imported with no record of what had landed, and a bad column
-- mapping was permanent.
--
-- Two tables: the run (the job, with its payload and progress counters) and one
-- effect row per change the run made, which is what makes an undo possible.
-- Contract details for the worker live in the durable-jobs skill.

CREATE TABLE IF NOT EXISTS public.flipdesk_import_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- The workspace OWNER the rows belong to (US-268 tenant scope).
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  -- The member who started it, when a workspace seat did.
  created_by uuid REFERENCES public.users(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'running', 'completed', 'failed', 'undone')),
  -- Where the rows came from, for the run history.
  origin text NOT NULL DEFAULT 'csv'
    CHECK (origin IN ('csv', 'sheet', 'paste')),
  total_rows integer NOT NULL DEFAULT 0,
  processed_rows integer NOT NULL DEFAULT 0,
  inserted_count integer NOT NULL DEFAULT 0,
  updated_count integer NOT NULL DEFAULT 0,
  skipped_count integer NOT NULL DEFAULT 0,
  failed_count integer NOT NULL DEFAULT 0,
  -- The mapped rows, exactly as the browser resolved them. The worker reads
  -- these instead of the file, so the tab is free to close.
  payload jsonb NOT NULL DEFAULT '[]'::jsonb,
  errors jsonb NOT NULL DEFAULT '[]'::jsonb,
  attempts integer NOT NULL DEFAULT 0,
  error text,
  undone_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS flipdesk_import_runs_user_created_idx
  ON public.flipdesk_import_runs (user_id, created_at DESC);
-- The reclaim sweep looks for open runs that stopped being touched.
CREATE INDEX IF NOT EXISTS flipdesk_import_runs_open_idx
  ON public.flipdesk_import_runs (status, updated_at)
  WHERE status IN ('pending', 'running');

CREATE TABLE IF NOT EXISTS public.flipdesk_import_effects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL REFERENCES public.flipdesk_import_runs(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  -- 1-based row number in the uploaded file, for the seller's error list.
  row_number integer,
  -- 'inserted' created the item; 'filled' wrote into blank columns on an
  -- existing item matched by SKU (the US-1082 fill-only rule).
  action text NOT NULL CHECK (action IN ('inserted', 'filled')),
  inventory_item_id uuid REFERENCES public.inventory_items(id) ON DELETE SET NULL,
  listing_id uuid REFERENCES public.listings(id) ON DELETE SET NULL,
  sale_id uuid REFERENCES public.sales(id) ON DELETE SET NULL,
  -- For 'filled': the values those columns held BEFORE the import, so an undo
  -- restores them instead of blanking them. Null for 'inserted'.
  previous jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS flipdesk_import_effects_run_idx
  ON public.flipdesk_import_effects (run_id);

DROP TRIGGER IF EXISTS set_flipdesk_import_runs_updated_at
  ON public.flipdesk_import_runs;
CREATE TRIGGER set_flipdesk_import_runs_updated_at
  BEFORE UPDATE ON public.flipdesk_import_runs
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.flipdesk_import_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.flipdesk_import_effects ENABLE ROW LEVEL SECURITY;

-- Sellers may READ their own runs. Every write goes through the edge service on
-- the service-role client, which is also what stops a client from forging an
-- effect row and undoing something it never imported.
DROP POLICY IF EXISTS "Users read own import runs" ON public.flipdesk_import_runs;
CREATE POLICY "Users read own import runs"
  ON public.flipdesk_import_runs FOR SELECT
  USING ((select auth.uid()) = user_id);

DROP POLICY IF EXISTS "Users read own import effects" ON public.flipdesk_import_effects;
CREATE POLICY "Users read own import effects"
  ON public.flipdesk_import_effects FOR SELECT
  USING ((select auth.uid()) = user_id);

COMMENT ON TABLE public.flipdesk_import_runs IS
  'US-2518: one durable CSV inventory import. payload holds the mapped rows so the worker survives the browser closing; the counters are derived by re-reading effect rows, never trusted from memory.';
COMMENT ON TABLE public.flipdesk_import_effects IS
  'US-2518: one row per change an import made, which is what an undo replays in reverse. previous holds the pre-import values of columns a fill-only re-import wrote.';

-- US-1108 self-record footer.
insert into public.applied_migrations (version) values ('00592') on conflict do nothing;
