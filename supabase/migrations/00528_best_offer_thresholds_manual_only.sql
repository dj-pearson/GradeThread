-- US-2405: Best Offer auto-accept / auto-decline become MANUAL-ONLY, and every
-- existing value is cleared.
--
-- 00158 stored these as "overrides": NULL meant "derive from the comp band"
-- (price_range_high_cents -> accept, price_range_low_cents -> decline). Two
-- things then combined badly. The composer resolved that default at SAVE time
-- and wrote the resolved number into these columns, so a seller who never
-- touched the fields still ended up with fixed numbers in them. And nothing
-- re-derived them when the price changed. A shirt repriced from $24 to $298 kept
-- a $27.50 auto-accept and a $16 auto-decline, so a $28 offer on a ~$300 item
-- would have been accepted automatically, with no seller involved.
--
-- The code half of this change removes the comp fallback everywhere, so from
-- here NULL means exactly one thing: no threshold, the offer waits for the
-- seller. This backfill makes the stored data agree with that meaning.
--
-- IT CLEARS EVERY VALUE, including any a seller typed by hand. That is
-- deliberate: nothing recorded whether a number was typed or auto-filled, and
-- there is no way to tell them apart after the fact. Clearing a hand-typed
-- threshold costs one field to re-enter; keeping an auto-filled one costs a sale
-- at the wrong price.
--
-- NOTE FOR THE OPERATOR: this only changes GradeThread's copy. A listing already
-- live on eBay keeps its old auto-accept terms until that listing is revised —
-- the next publish/revise from FlipDesk sends the cleared (absent) terms.

do $$
declare
  cleared integer;
begin
  update public.listings
     set best_offer_auto_accept_cents  = null,
         best_offer_auto_decline_cents = null
   where best_offer_auto_accept_cents is not null
      or best_offer_auto_decline_cents is not null;
  get diagnostics cleared = row_count;
  raise notice 'US-2405: cleared best-offer thresholds on % listing(s)', cleared;
end $$;

comment on column public.listings.best_offer_auto_accept_cents is
  'US-562/US-2405: per-listing best-offer auto-ACCEPT threshold in cents, set by the seller BY HAND. An offer at or above this auto-accepts. NULL = no threshold; the offer waits for the seller. Never derived from comps. Clamped below the listing price at publish.';
comment on column public.listings.best_offer_auto_decline_cents is
  'US-562/US-2405: per-listing best-offer auto-DECLINE threshold in cents, set by the seller BY HAND. An offer at or below this auto-declines. NULL = no threshold; the offer waits for the seller. Never derived from comps. Clamped below the accept threshold at publish.';

insert into public.applied_migrations (version) values ('00528') on conflict do nothing;
