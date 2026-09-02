-- US-3073: per-user widget-board layouts.
--
-- One row per (user, surface). `layout` holds the ordered widget document the
-- board renders: {"version": 1, "widgets": [{"id": "grading.usage", "size": "lg"}]}.
-- `version` mirrors the document version as a column so a future migration can
-- select the rows it has to rewrite without digging through jsonb.
--
-- The BROWSER owns this table. It reads and upserts through supabase-js under
-- RLS; there is no edge route and the service role never writes here. The
-- client also tolerates the table being absent (a read error resolves to the
-- persona default), so the frontend can deploy before this SQL applies.

CREATE TABLE IF NOT EXISTS public.dashboard_layouts (
  user_id    uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  -- Which overview this layout belongs to. 'ios-home' is the mobile home tab;
  -- it shares the registry so a layout saved on one client is honored on both.
  surface    text NOT NULL CHECK (surface IN ('grading', 'flipdesk', 'ios-home')),
  layout     jsonb NOT NULL DEFAULT '{"version": 1, "widgets": []}'::jsonb,
  version    integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, surface)
);

ALTER TABLE public.dashboard_layouts ENABLE ROW LEVEL SECURITY;

-- Owner-only, all four verbs. A layout is a personal preference: nobody else
-- reads it, and the seller must be able to drop back to the default by
-- deleting the row.
DROP POLICY IF EXISTS "Users read own dashboard layouts"
  ON public.dashboard_layouts;
CREATE POLICY "Users read own dashboard layouts"
  ON public.dashboard_layouts FOR SELECT
  USING ((select auth.uid()) = user_id);

DROP POLICY IF EXISTS "Users insert own dashboard layouts"
  ON public.dashboard_layouts;
CREATE POLICY "Users insert own dashboard layouts"
  ON public.dashboard_layouts FOR INSERT
  WITH CHECK ((select auth.uid()) = user_id);

DROP POLICY IF EXISTS "Users update own dashboard layouts"
  ON public.dashboard_layouts;
CREATE POLICY "Users update own dashboard layouts"
  ON public.dashboard_layouts FOR UPDATE
  USING ((select auth.uid()) = user_id)
  WITH CHECK ((select auth.uid()) = user_id);

DROP POLICY IF EXISTS "Users delete own dashboard layouts"
  ON public.dashboard_layouts;
CREATE POLICY "Users delete own dashboard layouts"
  ON public.dashboard_layouts FOR DELETE
  USING ((select auth.uid()) = user_id);

DROP TRIGGER IF EXISTS set_dashboard_layouts_updated_at
  ON public.dashboard_layouts;
CREATE TRIGGER set_dashboard_layouts_updated_at
  BEFORE UPDATE ON public.dashboard_layouts
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

COMMENT ON TABLE public.dashboard_layouts IS
  'US-3073: the widget board a user arranged, one row per (user, surface). Written by the browser under RLS; no edge route reads or writes it.';

COMMENT ON COLUMN public.dashboard_layouts.layout IS
  'Ordered widget document: {"version": n, "widgets": [{"id": text, "size": "sm"|"md"|"lg"}]}. Unknown ids and disallowed sizes are dropped or clamped on read by src/lib/dashboard-layout.ts.';

insert into public.applied_migrations (version) values ('00722') on conflict do nothing;
