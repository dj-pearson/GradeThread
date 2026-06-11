-- Google Sheets 2-way live sync (US-147).
--
-- Field-level conflict detection needs a third copy of the data: the value each
-- writable field had at the LAST sync ("base"). Comparing sheet vs DB alone
-- can't tell "the sheet edited this" from "FlipDesk edited this and the sheet
-- is stale". With the base value:
--
--   sheet == base, db != base  → FlipDesk changed it       → push to sheet
--   sheet != base, db == base  → the sheet changed it      → pull into FlipDesk
--   both differ from base AND from each other → CONFLICT   → FlipDesk wins,
--     row flagged in the sheet's Conflicts tab with both values.
--
-- One row per (user, tab, flipdesk row). `snapshot` holds ONLY the
-- writable-from-Sheets fields (normalized strings), so the table stays small:
-- read-only tabs (Listings / Sales / Sources) never need a snapshot.

CREATE TABLE IF NOT EXISTS public.google_sheet_sync_state (
  user_id     uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  tab         text NOT NULL,                 -- 'Inventory' (only writable tab today)
  flipdesk_id uuid NOT NULL,                 -- joins to the hidden sheet column A
  snapshot    jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, tab, flipdesk_id)
);

ALTER TABLE public.google_sheet_sync_state ENABLE ROW LEVEL SECURITY;
-- No policies: sync state is read/written only by the service-role edge client.
