-- Duplicate-SKU merge (atomic).
--
-- Scenario: a sheet import created an inventory row with SKU "X"; later the
-- user catalogs/AutoLists the same physical garment as a NEW row (no SKU) and
-- then types "X" into the editor. The partial unique index
-- idx_inventory_items_user_sku (user_id, sku) rejects the save with 23505.
-- Instead of a dead-end error, the UI now offers to MERGE the two rows into
-- one. This RPC is the atomic backend for that merge:
--
--   • p_survivor_id — the row that remains (the item currently being edited;
--     its values are treated as the most up-to-date by default).
--   • p_duplicate_id — the pre-existing row that holds the SKU; it is absorbed
--     and DELETED.
--   • p_sku — the contested SKU, written onto the survivor in the same
--     transaction so it can never end up unassigned.
--
-- Field-level conflict resolution for user-editable fields (title, brand,
-- price, measurements, …) happens in the UI BEFORE this call and is persisted
-- by the normal client-side UPDATE right after — this function deliberately
-- does not touch those columns. What it DOES own:
--
--   1. Re-pointing every child/reference row from the duplicate to the
--      survivor. All ON DELETE CASCADE tables would silently lose data if we
--      just deleted the duplicate (listings, sales, item_photos,
--      flipdesk_grading_submissions, listing_generation_jobs,
--      repricing_suggestions, repricing_rules), and the SET NULL references
--      would lose their linkage (ai_enrichment_log, grade_outcomes,
--      flipdesk_ebay_listings.matched_item_id,
--      flipdesk_ebay_orphan_sales.matched_item_id).
--   2. Coalescing NON-UI columns the editor never shows (grade linkage,
--      eBay taxonomy, consignment, location_bin, …): survivor's value wins
--      when present, otherwise the duplicate's value is carried over.
--   3. Deleting the duplicate and assigning the SKU — all in one transaction.
--
-- Tenant safety (US-268 pattern): both rows are locked FOR UPDATE, must belong
-- to the SAME user_id, and the caller must be that owner or a workspace member
-- at listing_manager+ (merging is a listing-workflow write; data is
-- consolidated, not destroyed, so it doesn't require the admin rank that raw
-- inventory DELETE does). SECURITY DEFINER because the repoint touches tables
-- whose RLS delete/update policies are stricter than the merge semantics need.

CREATE OR REPLACE FUNCTION public.merge_inventory_items(
  p_survivor_id  uuid,
  p_duplicate_id uuid,
  p_sku          text
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_survivor  public.inventory_items%ROWTYPE;
  v_duplicate public.inventory_items%ROWTYPE;
BEGIN
  IF p_survivor_id IS NULL OR p_duplicate_id IS NULL THEN
    RAISE EXCEPTION 'merge_inventory_items: both item ids are required';
  END IF;
  IF p_survivor_id = p_duplicate_id THEN
    RAISE EXCEPTION 'merge_inventory_items: cannot merge an item into itself';
  END IF;
  IF p_sku IS NULL OR btrim(p_sku) = '' THEN
    RAISE EXCEPTION 'merge_inventory_items: a SKU is required';
  END IF;

  -- Lock both rows in a deterministic order (by id) so two concurrent merges
  -- of the same pair can't deadlock.
  FOR v_survivor IN
    SELECT * FROM public.inventory_items
    WHERE id IN (p_survivor_id, p_duplicate_id)
    ORDER BY id
    FOR UPDATE
  LOOP
    IF v_survivor.id = p_duplicate_id THEN
      v_duplicate := v_survivor;
    END IF;
  END LOOP;

  SELECT * INTO v_survivor FROM public.inventory_items WHERE id = p_survivor_id;
  IF v_survivor.id IS NULL OR v_duplicate.id IS NULL THEN
    RAISE EXCEPTION 'merge_inventory_items: item not found';
  END IF;

  IF v_survivor.user_id IS DISTINCT FROM v_duplicate.user_id THEN
    RAISE EXCEPTION 'merge_inventory_items: items belong to different workspaces';
  END IF;

  IF NOT public.is_workspace_member_with_role(v_survivor.user_id, 'listing_manager') THEN
    RAISE EXCEPTION 'merge_inventory_items: not authorized';
  END IF;

  -- ── 1. Re-point children ──────────────────────────────────────────
  -- sales has a partial unique index (inventory_item_id, platform_order_id):
  -- if BOTH rows recorded the same marketplace order, the duplicate's copy IS
  -- the same sale — drop it rather than fail the repoint.
  DELETE FROM public.sales d
  WHERE d.inventory_item_id = p_duplicate_id
    AND d.platform_order_id IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM public.sales s
      WHERE s.inventory_item_id = p_survivor_id
        AND s.platform_order_id = d.platform_order_id
    );

  UPDATE public.sales
    SET inventory_item_id = p_survivor_id
    WHERE inventory_item_id = p_duplicate_id;
  UPDATE public.listings
    SET inventory_item_id = p_survivor_id
    WHERE inventory_item_id = p_duplicate_id;
  UPDATE public.item_photos
    SET inventory_item_id = p_survivor_id
    WHERE inventory_item_id = p_duplicate_id;
  UPDATE public.flipdesk_grading_submissions
    SET inventory_item_id = p_survivor_id
    WHERE inventory_item_id = p_duplicate_id;
  UPDATE public.listing_generation_jobs
    SET inventory_item_id = p_survivor_id
    WHERE inventory_item_id = p_duplicate_id;
  UPDATE public.repricing_suggestions
    SET inventory_item_id = p_survivor_id
    WHERE inventory_item_id = p_duplicate_id;
  UPDATE public.repricing_rules
    SET inventory_item_id = p_survivor_id
    WHERE inventory_item_id = p_duplicate_id;
  UPDATE public.ai_enrichment_log
    SET inventory_item_id = p_survivor_id
    WHERE inventory_item_id = p_duplicate_id;
  UPDATE public.grade_outcomes
    SET inventory_item_id = p_survivor_id
    WHERE inventory_item_id = p_duplicate_id;
  UPDATE public.flipdesk_ebay_listings
    SET matched_item_id = p_survivor_id
    WHERE matched_item_id = p_duplicate_id;
  UPDATE public.flipdesk_ebay_orphan_sales
    SET matched_item_id = p_survivor_id
    WHERE matched_item_id = p_duplicate_id;

  -- ── 2. Coalesce non-UI columns (survivor wins when present) ──────
  UPDATE public.inventory_items s
  SET submission_id          = COALESCE(s.submission_id, v_duplicate.submission_id),
      grade_report_id        = COALESCE(s.grade_report_id, v_duplicate.grade_report_id),
      grade_value            = COALESCE(s.grade_value, v_duplicate.grade_value),
      grade_label            = COALESCE(s.grade_label, v_duplicate.grade_label),
      certificate_url        = COALESCE(s.certificate_url, v_duplicate.certificate_url),
      source_id              = COALESCE(s.source_id, v_duplicate.source_id),
      acquired_source        = COALESCE(s.acquired_source, v_duplicate.acquired_source),
      location_bin           = COALESCE(s.location_bin, v_duplicate.location_bin),
      garment_type           = COALESCE(s.garment_type, v_duplicate.garment_type),
      garment_category       = COALESCE(s.garment_category, v_duplicate.garment_category),
      ebay_category_id       = COALESCE(s.ebay_category_id, v_duplicate.ebay_category_id),
      ebay_aspects           = COALESCE(s.ebay_aspects, v_duplicate.ebay_aspects),
      consignor_id           = COALESCE(s.consignor_id, v_duplicate.consignor_id),
      consignment_split_pct  = COALESCE(s.consignment_split_pct, v_duplicate.consignment_split_pct)
  WHERE s.id = p_survivor_id;

  -- ── 3. Delete the duplicate, then claim its SKU ───────────────────
  -- Order matters: the unique index frees the SKU only once the duplicate row
  -- is gone. If a THIRD item somehow holds p_sku, the final UPDATE raises
  -- 23505 and the whole merge rolls back — nothing is lost.
  DELETE FROM public.inventory_items WHERE id = p_duplicate_id;

  UPDATE public.inventory_items
    SET sku = btrim(p_sku)
    WHERE id = p_survivor_id;

  RETURN p_survivor_id;
END;
$$;

REVOKE ALL ON FUNCTION public.merge_inventory_items(uuid, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.merge_inventory_items(uuid, uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.merge_inventory_items(uuid, uuid, text) TO service_role;
