-- Fix: the "bring your own sheet" mapped sync (00433) keys snapshot rows by the
-- seller's SKU — an arbitrary string like "286" — but
-- google_sheet_sync_state.flipdesk_id was uuid (the classic sync stores the
-- inventory item's UUID there). Writing a SKU threw 22P02 "invalid input syntax
-- for type uuid: 286", so the mapped sync's snapshot save (the 3-way-merge
-- conflict-detection base) always failed and surfaced the whole run as an error.
--
-- flipdesk_id is really a generic row key: a UUID in classic mode, a SKU in
-- mapped mode. Widen it to text — it losslessly holds both (every existing uuid
-- casts to its canonical text form), and the classic sync already treats it as a
-- string key in JS. The primary key (user_id, tab, flipdesk_id) stays valid on
-- a text column. Guarded so a re-run (after the type is already text) is a no-op.

do $$
begin
  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'google_sheet_sync_state'
      and column_name = 'flipdesk_id'
      and data_type = 'uuid'
  ) then
    alter table public.google_sheet_sync_state
      alter column flipdesk_id type text using flipdesk_id::text;
  end if;
end $$;

-- US-1108: self-record so the edge schema-version boot guard (US-778) stays
-- truthful regardless of how the SQL was applied.
INSERT INTO public.applied_migrations (version) VALUES ('00435') ON CONFLICT DO NOTHING;
