-- US-2176: make listings.is_active a derived mirror of listing_status.
--
-- is_active was an independently-writable second source of truth that defaults
-- to TRUE on every row, so a never-published draft was born is_active=true and
-- guards had to distrust the column (see the delete guard in flipdesk-listings.ts
-- and the ai-listing.ts:1687 workaround). The authoritative answer to "is this
-- listing live" is listing_status IN ('active','relisted') — the same set the
-- read paths already use (flipdesk-listings.ts:766, the .in(['active','relisted'])
-- queries in flipdesk-ebay.ts / jobs-credentials-refresh.ts).
--
-- A TRIGGER keeps is_active in lockstep rather than a GENERATED column: many code
-- paths still write is_active explicitly (marketplace adapters, order webhooks,
-- moderation), and a generated column would ERROR on those writes. The trigger
-- simply overrides them to the derived value, so it is backward-compatible while
-- making the column no longer independently writable.

create or replace function public.listings_sync_is_active()
returns trigger
language plpgsql
as $$
begin
  new.is_active := (new.listing_status in ('active', 'relisted'));
  return new;
end;
$$;

-- Fires on INSERT (always) and on any UPDATE that touches listing_status or
-- is_active, so an attempt to write is_active independently is overridden.
drop trigger if exists trg_listings_sync_is_active on public.listings;
create trigger trg_listings_sync_is_active
  before insert or update of listing_status, is_active on public.listings
  for each row execute function public.listings_sync_is_active();

-- Backfill rows where the two disagree (e.g. drafts born is_active=true) and log
-- the count so the apply run records how much drift existed.
do $$
declare
  corrected integer;
begin
  update public.listings
     set is_active = (listing_status in ('active', 'relisted'))
   where is_active is distinct from (listing_status in ('active', 'relisted'));
  get diagnostics corrected = row_count;
  raise notice 'US-2176 backfill: corrected % listings.is_active row(s) to match listing_status', corrected;
end $$;

insert into public.applied_migrations (version) values ('00504') on conflict do nothing;
