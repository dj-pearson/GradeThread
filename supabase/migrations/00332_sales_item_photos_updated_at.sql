-- US-1515: give `sales` and `item_photos` an `updated_at` column + trigger so the
-- iOS SyncWatermark can delta them on EDITS, not just inserts.
--
-- The iOS delta sync cursors sales / item_photos / flipdesk_expenses. Only
-- flipdesk_expenses (00019) had an `updated_at` bumped on edit; `sales` (00002)
-- and `item_photos` (00008) had ONLY `created_at`. A created_at cursor never
-- moves when a row is EDITED, so:
--   • a sale corrected on web (price/fees/date) left iOS Money wrong indefinitely,
--   • photos retagged / reordered on web stayed stale on iOS.
-- The code comment claimed realtime covered it, but RealtimeService subscribes
-- ONLY to inventory_items and full backfills effectively never recur.
--
-- Fix: add `updated_at timestamptz NOT NULL DEFAULT now()`, backfill it to
-- `created_at` so the historical timeline is sensible, and attach the shared
-- `set_updated_at()` BEFORE UPDATE trigger (00001) so every future edit bumps it.
-- Idempotent (ADD COLUMN IF NOT EXISTS; DROP TRIGGER IF EXISTS before CREATE).
--
-- iOS SyncWatermark then deltas these on `updated_at` and bumps its schemaVersion
-- so existing installs do a ONE-TIME full backfill onto the new cursor.

-- ── sales ───────────────────────────────────────────────────────────
ALTER TABLE public.sales
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

-- Backfill so updated_at starts at the row's creation time (not the migration
-- clock), so the first delta pull doesn't treat every historical row as "just
-- edited". Only touches rows where the two still coincide with the fresh default.
UPDATE public.sales
  SET updated_at = created_at
  WHERE updated_at >= created_at AND updated_at > now() - interval '1 minute';

DROP TRIGGER IF EXISTS set_sales_updated_at ON public.sales;
CREATE TRIGGER set_sales_updated_at
  BEFORE UPDATE ON public.sales
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ── item_photos ─────────────────────────────────────────────────────
ALTER TABLE public.item_photos
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

UPDATE public.item_photos
  SET updated_at = created_at
  WHERE updated_at >= created_at AND updated_at > now() - interval '1 minute';

DROP TRIGGER IF EXISTS set_item_photos_updated_at ON public.item_photos;
CREATE TRIGGER set_item_photos_updated_at
  BEFORE UPDATE ON public.item_photos
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- Delta-cursor indexes so the `> watermark ORDER BY updated_at` scans stay cheap.
CREATE INDEX IF NOT EXISTS idx_sales_updated_at ON public.sales(updated_at);
CREATE INDEX IF NOT EXISTS idx_item_photos_updated_at ON public.item_photos(updated_at);

-- US-1108: self-record this migration's version so the edge schema-version guard
-- (US-778) stays in sync regardless of apply method.
INSERT INTO public.applied_migrations (version) VALUES ('00332') ON CONFLICT DO NOTHING;
