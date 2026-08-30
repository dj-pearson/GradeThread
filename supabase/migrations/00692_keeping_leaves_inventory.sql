-- US-3007, second half: derive the write-off from the status the seller already
-- sets, instead of asking them to say it twice.
--
-- 00690 gave inventory_items a removed_on/removed_reason pair and taught
-- take_inventory_snapshot to honour it. Nothing wrote those columns, so the
-- accounting was correct and unreachable.
--
-- THE APP ALREADY HAD THE VOCABULARY. item_status carries keeping, wearing,
-- returned and archived, and src/lib/constants.ts calls two of them
-- "personal-use statuses". They are filtered out of the Kanban and were NOT
-- filtered out of the books. So a seller who marked something Keeping months ago
-- had already said it left inventory, and the snapshot kept counting it.
--
-- ⚠ ONLY 'keeping' LEAVES. This is the owner's ruling (2026-08-29) and it
-- corrects the obvious-looking mapping, which is why it is written down here
-- rather than left to read off the code:
--
--   keeping   LEAVES inventory. The seller has taken it for themselves; it is a
--             personal-use withdrawal and reduces Schedule C line 36.
--   wearing   STAYS. They are wearing it and still intend to sell it. It is
--             still stock, so it belongs in ending inventory.
--   returned  STAYS, and comes BACK. A buyer sent it back; it returns to
--             inventory to be sold again.
--   archived  AMBIGUOUS - lost, damaged, donated, or sold off-platform - so the
--             trigger will not guess. It needs a prompt, which is UI work and
--             is not done here.
--
-- ⚠ DO NOT CONFUSE item_status 'returned' WITH removed_reason
-- 'returned_to_consignor'. They sound alike and mean opposite things: the status
-- is a buyer return (stock comes back), the reason is goods handed back to a
-- consignor (stock leaves). The reason stays in the CHECK list and is only ever
-- set by hand.
--
-- A HAND-SET REASON ALWAYS WINS. The trigger only fills a reason that is NULL,
-- and only clears the one it set itself ('personal_use'). A seller who recorded
-- an item as lost keeps that record whatever the status does afterwards.

CREATE OR REPLACE FUNCTION public.sync_item_removal_from_status()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  -- Taken for personal use. Fill the pair only if nothing was recorded by hand.
  IF NEW.status = 'keeping' AND NEW.removed_reason IS NULL THEN
    NEW.removed_on     := coalesce(NEW.removed_on, current_date);
    NEW.removed_reason := 'personal_use';

  -- Came back into stock. Clear ONLY the derived reason: an item the seller
  -- explicitly wrote off as lost or donated stays written off.
  ELSIF TG_OP = 'UPDATE'
        AND OLD.status = 'keeping'
        AND NEW.status <> 'keeping'
        AND NEW.removed_reason = 'personal_use'
        AND NEW.removed_reason IS NOT DISTINCT FROM OLD.removed_reason
        AND NEW.removed_on IS NOT DISTINCT FROM OLD.removed_on
  THEN
    NEW.removed_on     := NULL;
    NEW.removed_reason := NULL;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_sync_item_removal_from_status ON public.inventory_items;
CREATE TRIGGER trg_sync_item_removal_from_status
  BEFORE INSERT OR UPDATE OF status, removed_on, removed_reason
  ON public.inventory_items
  FOR EACH ROW
  EXECUTE FUNCTION public.sync_item_removal_from_status();

-- BACKFILL. Every item already sitting in 'keeping' left inventory at some
-- point and the books never noticed.
--
-- ⚠ THE DATE IS APPROXIMATE AND THAT IS THE OWNER'S CALL (2026-08-29): use
-- updated_at, which is when the row last changed for ANY reason, not
-- necessarily when the item was taken. Nothing in the schema records the
-- transition itself, so this is the closest thing that exists. It is stated
-- here rather than buried because an approximate date inside a tax figure
-- should be visible to whoever reads the return.
--
-- Idempotent: only rows with no reason recorded are touched, so re-running
-- changes nothing and a hand-set reason is never overwritten.
--
-- Snapshots already taken are NOT rewritten (US-3007 AC5). This affects
-- snapshots taken from here on; a closed year is corrected through period close
-- (US-2995), never by editing history.
UPDATE public.inventory_items
   SET removed_on     = updated_at::date,
       removed_reason = 'personal_use'
 WHERE status = 'keeping'
   AND removed_reason IS NULL;

COMMENT ON FUNCTION public.sync_item_removal_from_status() IS
  'US-3007: keeping => a personal-use withdrawal dated today. wearing and returned deliberately stay IN inventory; archived is ambiguous and needs a prompt. Only fills a NULL reason, only clears the one it set.';

insert into public.applied_migrations (version) values ('00692') on conflict do nothing;
