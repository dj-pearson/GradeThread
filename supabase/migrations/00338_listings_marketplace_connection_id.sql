-- US-1507: thread the eBay connection per listing.
--
-- Every publish/revise/end/price/negotiation call used to resolve the CURRENT
-- PRIMARY eBay connection (marketplace_connections ordered by is_primary DESC),
-- because `listings` carried no connection id. Publish under store A, switch the
-- primary to B, then End/Revise on the A-listing ran as B — revise failed
-- confusingly and End's 4xx matched isOfferAlreadyEndedError, flipping the local
-- row "ended" while A's listing stayed live. This adds the missing link so an
-- operation acts via the SAME account that owns the listing.
--
-- Nullable + ON DELETE SET NULL: existing rows stay null and the edge token
-- resolver falls back to the primary connection for them (unchanged behavior);
-- newly-published FlipDesk listings persist their connection id. No backfill —
-- historical rows don't reliably know which account published them.

alter table public.listings
  add column if not exists marketplace_connection_id uuid
    references public.marketplace_connections(id) on delete set null;

comment on column public.listings.marketplace_connection_id is
  'US-1507: the eBay marketplace_connections row that published/owns this listing, '
  'so revise/end/price act via that account''s token instead of the current primary. '
  'Null on legacy + imported rows → the edge falls back to the primary connection.';

create index if not exists idx_listings_marketplace_connection_id
  on public.listings (marketplace_connection_id)
  where marketplace_connection_id is not null;

-- US-1108 self-record footer.
insert into public.applied_migrations (version) values ('00338') on conflict do nothing;
