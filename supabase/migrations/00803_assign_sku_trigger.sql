-- US-3415: fill a blank SKU from the tenant's counter, at the one place every
-- client already goes through.
--
-- WHY A TRIGGER AND NOT A HELPER. Inventory items are created from thirteen
-- call sites: composer.tsx, intake.tsx, bulk-intake.tsx, snap-catalog.tsx,
-- ebay-sku-match.tsx, use-reconcile-commit.ts and persist-groups-as-items.ts on
-- the web; closet-import-run.ts, buyer-closet.ts, flipdesk-google-sync.ts,
-- flipdesk-import.ts and flipdesk-scout.ts on the edge; plus the iOS and
-- Android capture paths. A TypeScript helper would need thirteen edits, a Swift
-- port and a Kotlin port, and the one call site somebody forgets fails silently
-- and invisibly. A BEFORE INSERT trigger covers all of them, covers every path
-- added later, and is the only option that is atomic without a second round
-- trip. Nothing in the application changes.
--
-- THE TENANT IS NEW.user_id, NOT auth.uid(). workspace.ts:24-27 establishes
-- that inventory_items.user_id is the workspace OWNER's id, never the acting
-- member's: "tenant writes should use this, not userId". On a solo account the
-- two are the same person, which is exactly why a fixture that only tests a
-- solo account cannot tell a correct trigger from a broken one. The check
-- script inserts as a MEMBER of somebody else's workspace for that reason.
--
-- WHAT IT WILL NOT DO. It never overwrites a SKU the caller supplied, under any
-- setting. It never issues a value another row in the tenant already holds. It
-- never fails an insert -- see the exhaustion note below.

create or replace function public.flipdesk_assign_sku()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  seqrow public.flipdesk_sku_sequences%rowtype;
  stamp  text;
  c      integer[];
  nxt    integer[];
  cand   text;
  tries  int  := 0;
  today  date := (now() at time zone 'UTC')::date;
begin
  -- A SKU the caller supplied is never overwritten, under any setting.
  if new.sku is not null and btrim(new.sku) <> '' then
    return new;
  end if;

  -- SELECT ... FOR UPDATE rather than a single UPDATE ... RETURNING: the
  -- collision skip below may advance more than once, so the final counters are
  -- only known after the loop. Both shapes take the same row lock; this one
  -- holds it ACROSS the loop, which is what makes the skip safe under
  -- concurrency. The lock is on the tenant's single sequence row and is held
  -- for microseconds.
  select * into seqrow
    from public.flipdesk_sku_sequences
   where user_id = new.user_id
     for update;

  if not found or not seqrow.enabled or seqrow.exhausted then
    return new;
  end if;

  stamp := public.flipdesk_sku_render_date(seqrow.pattern, today);
  c     := seqrow.counters;

  -- The period rolled over (a new year, a new month). Start again at the floor.
  -- Only when the tenant asked for it: a pattern carrying a year that does NOT
  -- reset is still a legitimate choice, it just keeps counting across January.
  if seqrow.reset_on_date_change
     and seqrow.date_stamp is not null
     and seqrow.date_stamp <> stamp then
    c := public.flipdesk_sku_floor(seqrow.pattern);
  end if;

  loop
    tries := tries + 1;
    cand  := public.flipdesk_sku_render(seqrow.pattern, c, today);
    exit when cand is not null
          and not exists (select 1 from public.inventory_items
                           where user_id = new.user_id and sku = cand);

    -- Taken, almost always by a SKU the seller typed by hand before turning
    -- numbering on. Walk past it rather than raising 23505 at somebody in the
    -- middle of a photo session. This is also why there is deliberately no
    -- "advance the counter when a seller types a SKU" rule anywhere: that would
    -- be a second place for the same invariant to live, and it buys nothing
    -- this loop does not already guarantee.
    c := public.flipdesk_sku_advance(seqrow.pattern, c);

    -- 1000 is far past any realistic run of hand-typed SKUs, and still bounded
    -- enough that a pathological pattern cannot spin holding the row lock.
    if c is null or tries > 1000 then
      update public.flipdesk_sku_sequences
         set exhausted = true, updated_at = now()
       where user_id = new.user_id;
      -- THE ITEM STILL SAVES, with a NULL sku. Raising here would stop a seller
      -- dead, mid session, with an error they cannot diagnose, and an unsaved
      -- item is worse than an unnumbered one. The cost is that a blank SKU can
      -- appear silently, which is why US-3417 and US-3418 both surface the
      -- exhausted flag: on the settings screen and on the inventory page.
      return new;
    end if;
  end loop;

  new.sku := cand;

  -- counters holds the NEXT value to issue, so the row is advanced past the one
  -- just handed out. When that was the last possible value, nxt is NULL: pin
  -- the counters where they are and flag the row, so nothing can reissue it.
  nxt := public.flipdesk_sku_advance(seqrow.pattern, c);

  update public.flipdesk_sku_sequences
     set counters   = coalesce(nxt, c),
         exhausted  = (nxt is null),
         date_stamp = stamp,
         updated_at = now()
   where user_id = new.user_id;

  return new;
end;
$$;

comment on function public.flipdesk_assign_sku() is
  'US-3415: BEFORE INSERT on inventory_items. Fills a blank sku from flipdesk_sku_sequences, skipping values already taken inside the tenant. Never overwrites a supplied sku. On exhaustion it flags the sequence and leaves sku NULL rather than failing the insert.';

-- The NAME matters. BEFORE triggers fire in alphabetical order, and this one
-- sorts before set_created_by (US-3023), which is already on this table. The
-- two write different columns so the order is not load-bearing today -- but a
-- third trigger landing between them would be, and the ordering is invisible
-- unless somebody writes it down. This is that.
drop trigger if exists assign_sku_on_insert on public.inventory_items;
create trigger assign_sku_on_insert
  before insert on public.inventory_items
  for each row execute function public.flipdesk_assign_sku();

-- US-1108: self-record the applied version so the edge boot guard stays truthful.
insert into public.applied_migrations (version) values ('00803') on conflict do nothing;
