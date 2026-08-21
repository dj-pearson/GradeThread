-- 00640: the 13 SECURITY DEFINER functions that never got a body guard (US-2282).
--
-- Measured against production 2026-08-21: 96 SECURITY DEFINER functions, 55
-- reachable by anon, 40 already guarded by 00514 and 00611-00617. These are the
-- rest. Full measurement and the per-function triage:
-- vault/20-domain/security-definer-exposure.md
--
-- WHY A BODY CHECK AND NEVER A REVOKE. A revoke makes the call permission-denied,
-- and a denied call segfaults this Postgres image and restarts the database
-- (US-2403). 00527 is parked .BLOCKED permanently for that reason. A body check
-- raises an ordinary 42501 instead. This file adds no GRANT and no REVOKE.
--
-- WHY service_role FOR SOME AND authenticated FOR OTHERS. Decided by who
-- actually calls each function, which is the only thing that can decide it. Ten
-- are reached only by the edge through supabaseAdmin. Three are called from the
-- browser (get_or_create_source, merge_inventory_items, community_benchmarks) and
-- a service-role guard on those would break the app.
--
-- The bodies below are the EXISTING bodies, re-emitted mechanically from the
-- migrations that last defined them, with one guard call added. They were not
-- retyped.

-- The guard. Deliberately NOT security definer: it only reads auth.role() /
-- auth.uid() and calls is_admin(), all of which an ordinary caller may do. That
-- keeps this file from adding a fourteenth privileged function.
--
-- VOLATILE so no planner can fold it away: it exists for its side effect of
-- raising, and a guard that can be optimised out is not a guard.
CREATE OR REPLACE FUNCTION public.gt_require_role(p_fn text, p_need text)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SET search_path = public
AS $gt_guard$
BEGIN
  -- The edge calls every one of these through the service-role client. An admin
  -- acting through the browser is admitted too, matching the shape 00514 settled
  -- on: a bare is_admin() would refuse the edge itself, because a service-role
  -- JWT carries no sub and auth.uid() is therefore NULL.
  IF auth.role() = 'service_role' OR public.is_admin() THEN
    RETURN true;
  END IF;

  -- The role is checked, NOT merely auth.uid(). A first draft used
  -- auth.uid() IS NOT NULL and admitted a caller whose JWT said role=anon but
  -- still carried a sub, which is a shape a client controls. Requiring the role
  -- claim as well means the anon key cannot reach these however its token is
  -- decorated.
  IF p_need = 'authenticated'
     AND auth.role() = 'authenticated'
     AND auth.uid() IS NOT NULL THEN
    RETURN true;
  END IF;

  -- Note the fall-through: this raises when the conditions above are UNKNOWN,
  -- not only when they are false. The shape 00615 uses -- IF NOT (auth.role() =
  -- 'service_role' OR public.is_admin()) -- evaluates to NULL when auth.role()
  -- is NULL, and an IF on NULL does not fire, so that guard FAILS OPEN for a
  -- caller carrying no JWT claims at all. Verified locally: under psql with no
  -- claims set, grant_grade_credits sails past its own check and fails later on
  -- business validation instead. Production always has claims so it has never
  -- mattered there, but the safe direction costs nothing here.
  RAISE EXCEPTION '%: % required', p_fn, p_need USING ERRCODE = '42501';
END;
$gt_guard$;

GRANT EXECUTE ON FUNCTION public.gt_require_role(text, text) TO anon, authenticated, service_role;


-- claim_grade_lease -> service_role
-- plpgsql: guard is the first statement in the outer block
-- body from 00161_grading_durability.sql, unchanged apart from the guard.
CREATE OR REPLACE FUNCTION public.claim_grade_lease(
  p_submission_id uuid,
  p_lease_seconds integer,
  p_max_attempts integer
) RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_claimed uuid;
  v_status public.submission_status;
  v_attempts integer;
  v_has_active_report boolean;
BEGIN
  PERFORM public.gt_require_role('claim_grade_lease', 'service_role');
  UPDATE public.submissions s
  SET status              = 'processing',
      -- Stamp the first-ever start once; resumes keep the original.
      grading_started_at  = COALESCE(s.grading_started_at, now()),
      grading_lease_until = now() + make_interval(secs => p_lease_seconds),
      grading_attempts    = s.grading_attempts + 1
  WHERE s.id = p_submission_id
    AND s.status IN ('pending', 'processing')
    AND (s.grading_lease_until IS NULL OR s.grading_lease_until < now())
    AND s.grading_attempts < p_max_attempts
    -- Never re-grade a submission that already produced an active report. The
    -- finalize path (claim returns 'done') wires up the terminal state instead.
    AND NOT EXISTS (
      SELECT 1 FROM public.grade_reports gr
      WHERE gr.submission_id = s.id AND gr.superseded_at IS NULL
    )
  RETURNING s.id INTO v_claimed;

  IF v_claimed IS NOT NULL THEN
    RETURN 'claimed';
  END IF;

  -- Didn't claim — diagnose why so the caller can finalize / wait / give up.
  SELECT s.status, s.grading_attempts,
         EXISTS (SELECT 1 FROM public.grade_reports gr
                 WHERE gr.submission_id = s.id AND gr.superseded_at IS NULL)
    INTO v_status, v_attempts, v_has_active_report
  FROM public.submissions s
  WHERE s.id = p_submission_id;

  IF NOT FOUND THEN
    RETURN 'gone';
  END IF;
  IF v_has_active_report THEN
    RETURN 'done';
  END IF;
  IF v_status NOT IN ('pending', 'processing') THEN
    RETURN 'gone';
  END IF;
  IF v_attempts >= p_max_attempts THEN
    RETURN 'exhausted';
  END IF;
  RETURN 'leased';
END;
$$;


-- increment_ai_actions -> service_role
-- plpgsql: guard is the first statement in the outer block
-- body from 00024_ai_enrichment.sql, unchanged apart from the guard.
CREATE OR REPLACE FUNCTION public.increment_ai_actions(p_user_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM public.gt_require_role('increment_ai_actions', 'service_role');
  UPDATE public.users
  SET
    ai_actions_used_this_month = CASE
      WHEN date_trunc('month', ai_actions_reset_at) < date_trunc('month', now())
        THEN 1
      ELSE ai_actions_used_this_month + 1
    END,
    ai_actions_reset_at = CASE
      WHEN date_trunc('month', ai_actions_reset_at) < date_trunc('month', now())
        THEN now()
      ELSE ai_actions_reset_at
    END,
    updated_at = now()
  WHERE id = p_user_id;
END;
$$;


-- reserve_ai_action -> service_role
-- plpgsql: guard is the first statement in the outer block
-- body from 00087_autolister_reliability.sql, unchanged apart from the guard.
CREATE OR REPLACE FUNCTION public.reserve_ai_action(p_user_id uuid, p_limit int)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_used  int;
  v_reset timestamptz;
  v_rolled boolean;
BEGIN
  PERFORM public.gt_require_role('reserve_ai_action', 'service_role');
  SELECT ai_actions_used_this_month, ai_actions_reset_at
    INTO v_used, v_reset
    FROM public.users
    WHERE id = p_user_id
    FOR UPDATE;
  IF NOT FOUND THEN
    RETURN false;
  END IF;

  -- Month rollover: if the counter is from a prior month, it's effectively 0.
  v_rolled := date_trunc('month', v_reset) < date_trunc('month', now());
  IF v_rolled THEN
    v_used := 0;
  END IF;

  -- Cap check (-1 = unlimited). Persist any rollover even on refusal so the
  -- stored counter stays correct.
  IF p_limit <> -1 AND v_used >= p_limit THEN
    UPDATE public.users
      SET ai_actions_used_this_month = v_used,
          ai_actions_reset_at = CASE WHEN v_rolled THEN now() ELSE ai_actions_reset_at END
      WHERE id = p_user_id;
    RETURN false;
  END IF;

  UPDATE public.users
    SET ai_actions_used_this_month = v_used + 1,
        ai_actions_reset_at = CASE WHEN v_rolled THEN now() ELSE ai_actions_reset_at END
    WHERE id = p_user_id;
  RETURN true;
END;
$$;


-- reserve_buyer_meter -> service_role
-- plpgsql: guard is the first statement in the outer block
-- body from 00413_buyer_metering.sql, unchanged apart from the guard.
CREATE OR REPLACE FUNCTION public.reserve_buyer_meter(p_user_id uuid, p_meter text, p_limit int)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_usage  jsonb;
  v_reset  timestamptz;
  v_used   int;
  v_rolled boolean;
BEGIN
  PERFORM public.gt_require_role('reserve_buyer_meter', 'service_role');
  INSERT INTO public.buyer_meter_usage(user_id) VALUES (p_user_id)
    ON CONFLICT (user_id) DO NOTHING;

  SELECT usage, reset_at INTO v_usage, v_reset
    FROM public.buyer_meter_usage WHERE user_id = p_user_id FOR UPDATE;

  -- Month rollover: a counter from a prior month is effectively empty.
  v_rolled := v_reset IS NULL OR date_trunc('month', v_reset) < date_trunc('month', now());
  IF v_rolled THEN
    v_usage := '{}'::jsonb;
  END IF;

  v_used := COALESCE((v_usage ->> p_meter)::int, 0);

  IF p_limit <> -1 AND v_used >= p_limit THEN
    UPDATE public.buyer_meter_usage
      SET usage = v_usage,
          reset_at = CASE WHEN v_rolled THEN now() ELSE reset_at END,
          updated_at = now()
      WHERE user_id = p_user_id;
    RETURN false;
  END IF;

  UPDATE public.buyer_meter_usage
    SET usage = jsonb_set(v_usage, ARRAY[p_meter], to_jsonb(v_used + 1)),
        reset_at = CASE WHEN v_rolled THEN now() ELSE reset_at END,
        updated_at = now()
    WHERE user_id = p_user_id;
  RETURN true;
END;
$$;


-- record_style_code_submission -> service_role
-- plpgsql: guard is the first statement in the outer block
-- body from 00635_style_code_submissions.sql, unchanged apart from the guard.
CREATE OR REPLACE FUNCTION public.record_style_code_submission(
  p_brand_key text,
  p_style_code_norm text,
  p_style_code_raw text,
  p_name_norm text,
  p_name text
) RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count integer;
BEGIN
  PERFORM public.gt_require_role('record_style_code_submission', 'service_role');
  INSERT INTO public.style_code_submissions AS s
    (brand_key, style_code_norm, style_code_raw, name_norm, name)
  VALUES (
    coalesce(btrim(p_brand_key), ''),
    p_style_code_norm,
    p_style_code_raw,
    p_name_norm,
    btrim(p_name)
  )
  ON CONFLICT (brand_key, style_code_norm, name_norm) DO UPDATE SET
    submissions = s.submissions + 1,
    last_seen_at = now(),
    updated_at = now()
    -- `name` is NOT updated: the first spelling submitted is the display form,
    -- so a later submitter cannot restyle an answer other people agreed to.
  RETURNING s.submissions INTO v_count;
  RETURN v_count;
END;
$$;


-- get_or_create_source -> authenticated
-- plpgsql: guard is the first statement in the outer block
-- body from 00009_tracking_fields.sql, unchanged apart from the guard.
CREATE OR REPLACE FUNCTION public.get_or_create_source(
  p_user_id uuid,
  p_name text,
  p_source_type public.flipdesk_source_type DEFAULT 'other'
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id uuid;
BEGIN
  PERFORM public.gt_require_role('get_or_create_source', 'authenticated');
  IF p_name IS NULL OR length(trim(p_name)) = 0 THEN
    RETURN NULL;
  END IF;

  SELECT id INTO v_id
  FROM public.sources
  WHERE user_id = p_user_id AND lower(name) = lower(trim(p_name))
  LIMIT 1;

  IF v_id IS NOT NULL THEN
    RETURN v_id;
  END IF;

  INSERT INTO public.sources (user_id, name, source_type)
  VALUES (p_user_id, trim(p_name), p_source_type)
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;


-- merge_inventory_items -> authenticated
-- plpgsql: guard is the first statement in the outer block
-- body from 00119_merge_inventory_items.sql, unchanged apart from the guard.
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
  PERFORM public.gt_require_role('merge_inventory_items', 'authenticated');
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


-- record_style_code_name -> service_role
-- was LANGUAGE sql returning void (DML); becomes plpgsql
-- body from 00628_style_code_names.sql, unchanged apart from the guard.
CREATE OR REPLACE FUNCTION public.record_style_code_name(
  p_brand_key text,
  p_style_code_norm text,
  p_style_code_raw text,
  p_name text,
  p_source text,
  p_supporting integer DEFAULT 1,
  p_confidence numeric DEFAULT 0.5,
  p_evidence_url text DEFAULT NULL
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM public.gt_require_role('record_style_code_name', 'service_role');

  INSERT INTO public.style_code_names AS n
    (brand_key, style_code_norm, style_code_raw, name, source, supporting,
     confidence, evidence_url)
  VALUES (
    coalesce(btrim(p_brand_key), ''),
    p_style_code_norm,
    p_style_code_raw,
    btrim(p_name),
    p_source,
    greatest(coalesce(p_supporting, 1), 1),
    least(greatest(coalesce(p_confidence, 0.5), 0), 1),
    p_evidence_url
  )
  ON CONFLICT (brand_key, style_code_norm, source) DO UPDATE SET
    style_code_raw = EXCLUDED.style_code_raw,
    name = EXCLUDED.name,
    supporting = EXCLUDED.supporting,
    confidence = EXCLUDED.confidence,
    evidence_url = coalesce(EXCLUDED.evidence_url, n.evidence_url),
    rejected_at = CASE
      WHEN n.name IS DISTINCT FROM EXCLUDED.name THEN NULL
      ELSE n.rejected_at
    END,
    updated_at = now();
END;
$$;


-- increment_certificate_view -> service_role
-- was LANGUAGE sql returning void (DML); becomes plpgsql
-- body from 00121_certificate_view_count.sql, unchanged apart from the guard.
CREATE OR REPLACE FUNCTION public.increment_certificate_view(p_certificate_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM public.gt_require_role('increment_certificate_view', 'service_role');

  UPDATE public.grade_reports
     SET view_count = view_count + 1
   WHERE certificate_id = p_certificate_id
     AND certificate_id IS NOT NULL;
END;
$$;


-- channel_attribution -> service_role
-- was LANGUAGE sql; becomes plpgsql so the guard runs before the query and the body's own ORDER BY is preserved
-- body from 00492_utm_attribution.sql, unchanged apart from the guard.
CREATE OR REPLACE FUNCTION public.channel_attribution()
RETURNS TABLE (
  utm_source text,
  utm_medium text,
  utm_campaign text,
  users bigint
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM public.gt_require_role('channel_attribution', 'service_role');
  RETURN QUERY
SELECT
    utm_first_touch ->> 'utm_source'   AS utm_source,
    utm_first_touch ->> 'utm_medium'   AS utm_medium,
    utm_first_touch ->> 'utm_campaign' AS utm_campaign,
    count(*)                           AS users
  FROM public.users
  WHERE utm_first_touch IS NOT NULL
  GROUP BY 1, 2, 3
  ORDER BY users DESC;
END;
$$;


-- style_code_sweep_candidates -> service_role
-- was LANGUAGE sql; becomes plpgsql so the guard runs before the query and the body's own ORDER BY is preserved
-- body from 00627_style_code_sweeps.sql, unchanged apart from the guard.
CREATE OR REPLACE FUNCTION public.style_code_sweep_candidates(
  p_limit integer DEFAULT 20000
) RETURNS TABLE (brand text, style_code text)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM public.gt_require_role('style_code_sweep_candidates', 'service_role');
  RETURN QUERY
SELECT DISTINCT
    coalesce(btrim(i.brand), '') AS brand,
    btrim(i.attributes->>'style_code') AS style_code
  FROM public.inventory_items i
  WHERE i.attributes->>'style_code' IS NOT NULL
    AND btrim(i.attributes->>'style_code') <> ''
  LIMIT greatest(coalesce(p_limit, 20000), 0);
END;
$$;


-- buyer_growth_metrics -> service_role
-- LANGUAGE sql scalar; the expression is gated in place
-- body from 00537_buyer_growth_metrics.sql, unchanged apart from the guard.
CREATE OR REPLACE FUNCTION public.buyer_growth_metrics(p_days integer DEFAULT 30)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT CASE WHEN public.gt_require_role('buyer_growth_metrics', 'service_role')
    THEN (WITH win AS (
  SELECT
    greatest(1, least(coalesce(p_days, 30), 365)) AS days,
    date_trunc('day', now())
      - ((greatest(1, least(coalesce(p_days, 30), 365)) - 1) || ' days')::interval
      AS since
),
-- Every account that holds (or has ever held) the buyer product. `is_buyer`
-- (00401) is the persisted role flag — account_type is signup metadata, not a
-- column. A seller who got the buyer tier folded in from their FlipDesk plan
-- (US-1887) never sets is_buyer, which is why the subscription columns are also
-- checked: they are a buyer for measurement purposes.
buyer_users AS (
  SELECT u.*
  FROM public.users u
  WHERE u.is_buyer
     OR u.buyer_subscription_status <> 'none'
     OR u.buyer_plan <> 'free'
),
-- Buyers who did at least one buyer thing. "Signed up" is not "activated", and
-- the gap between the two is the number the funnel exists to show.
activated AS (
  SELECT DISTINCT b.id
  FROM buyer_users b
  WHERE EXISTS (SELECT 1 FROM public.saved_searches s WHERE s.user_id = b.id)
     OR EXISTS (SELECT 1 FROM public.closet_items c WHERE c.user_id = b.id)
     OR EXISTS (SELECT 1 FROM public.ingested_listings i WHERE i.user_id = b.id)
     OR EXISTS (SELECT 1 FROM public.buyer_wants w WHERE w.user_id = b.id)
     OR EXISTS (SELECT 1 FROM public.grade_outcomes o WHERE o.buyer_user_id = b.id)
),
plans AS (
  SELECT
    b.buyer_plan::text                        AS plan,
    coalesce(b.buyer_interval, 'none')        AS interval,
    b.buyer_subscription_status::text         AS status,
    count(*)                                  AS users
  FROM buyer_users b
  GROUP BY 1, 2, 3
),
-- Daily series. Both sides are pre-seeded from generate_series so a quiet day is
-- a zero rather than a missing point — a gap would let the correlation the route
-- computes silently drop a day off one side and not the other.
days AS (
  SELECT generate_series((SELECT since FROM win), date_trunc('day', now()), '1 day')::date AS d
),
demand AS (
  SELECT d.d AS day, (
      (SELECT count(*) FROM public.ingested_listings i
        WHERE i.created_at >= d.d AND i.created_at < d.d + 1)
    + (SELECT count(*) FROM public.saved_searches s
        WHERE s.created_at >= d.d AND s.created_at < d.d + 1)
    + (SELECT count(*) FROM public.buyer_wants w
        WHERE w.created_at >= d.d AND w.created_at < d.d + 1)
  ) AS n
  FROM days d
),
grades AS (
  SELECT d.d AS day, (
    SELECT count(*) FROM public.submissions s
     WHERE s.created_at >= d.d AND s.created_at < d.d + 1
  ) AS n
  FROM days d
),
-- Acquisition bucket per buyer, resolved once and reused by the revenue rollup.
attributed AS (
  SELECT
    b.id,
    -- Aliased buyer_plan, never bare `plan`: `users.plan` is the frozen legacy
    -- column (US-2398) and a `plan <> 'free'` in a migration is what the
    -- legacy-user-plan-readers guard is looking for.
    b.buyer_plan::text                 AS buyer_plan,
    b.buyer_interval                   AS interval,
    b.buyer_subscription_status::text  AS status,
    coalesce(
      b.utm_first_touch ->> 'utm_source',
      CASE WHEN EXISTS (
        SELECT 1 FROM public.affiliate_clicks ac WHERE ac.converted_user_id = b.id
      ) THEN 'affiliate' END,
      'direct'
    )                                  AS source,
    b.utm_first_touch ->> 'utm_medium'   AS medium,
    b.utm_first_touch ->> 'utm_campaign' AS campaign
  FROM buyer_users b
),
attribution AS (
  SELECT
    a.source,
    a.medium,
    a.campaign,
    count(*)                                                              AS buyers,
    count(*) FILTER (
      WHERE a.buyer_plan <> 'free' AND a.status IN ('active', 'trialing')
    )                                                                     AS paid_buyers,
    -- Plan × interval, not plan and interval separately: MRR needs the CROSS
    -- (a yearly Guard bills a twelfth of the yearly price), and two marginal
    -- counts cannot be recombined into it without assuming they are independent.
    count(*) FILTER (
      WHERE a.buyer_plan = 'guard' AND a.interval = 'monthly'
        AND a.status IN ('active', 'trialing')
    )                                                                     AS guard_monthly,
    count(*) FILTER (
      WHERE a.buyer_plan = 'guard' AND a.interval = 'yearly'
        AND a.status IN ('active', 'trialing')
    )                                                                     AS guard_yearly,
    count(*) FILTER (
      WHERE a.buyer_plan = 'connoisseur' AND a.interval = 'monthly'
        AND a.status IN ('active', 'trialing')
    )                                                                     AS connoisseur_monthly,
    count(*) FILTER (
      WHERE a.buyer_plan = 'connoisseur' AND a.interval = 'yearly'
        AND a.status IN ('active', 'trialing')
    )                                                                     AS connoisseur_yearly,
    coalesce(sum(
      coalesce((m.usage ->> 'extension_checks')::int, 0)
      + coalesce((m.usage ->> 'authenticity_credits')::int, 0)
      + coalesce((m.usage ->> 'video_grades')::int, 0)
    ), 0)                                                                 AS metered_units
  FROM attributed a
  LEFT JOIN public.buyer_meter_usage m ON m.user_id = a.id
  GROUP BY 1, 2, 3
)
SELECT jsonb_build_object(
  'window_days', (SELECT days FROM win),
  'since',       (SELECT since FROM win),
  'funnel', jsonb_build_object(
    'buyer_accounts', (SELECT count(*) FROM buyer_users),
    'new_accounts',   (SELECT count(*) FROM buyer_users b
                        WHERE b.created_at >= (SELECT since FROM win)),
    'activated',      (SELECT count(*) FROM activated),
    'paid',           (SELECT count(*) FROM buyer_users b
                        WHERE b.buyer_plan <> 'free'
                          AND b.buyer_subscription_status IN ('active', 'trialing')),
    'active_recent',  (SELECT count(*) FROM buyer_users b
                        WHERE b.last_active_at >= (SELECT since FROM win))
  ),
  'plans', coalesce((
    SELECT jsonb_agg(jsonb_build_object(
      'plan', p.plan, 'interval', p.interval, 'status', p.status, 'users', p.users
    ) ORDER BY p.plan, p.interval)
    FROM plans p
  ), '[]'::jsonb),
  'adoption', jsonb_build_object(
    'extension_check', (SELECT jsonb_build_object(
        'users', count(DISTINCT i.user_id), 'events', count(*))
      FROM public.ingested_listings i WHERE i.created_at >= (SELECT since FROM win)),
    'alerts', (SELECT jsonb_build_object(
        'users', count(DISTINCT s.user_id), 'events', count(*))
      FROM public.saved_searches s WHERE s.created_at >= (SELECT since FROM win)),
    'confirmations', (SELECT jsonb_build_object(
        'users', count(DISTINCT o.buyer_user_id), 'events', count(*))
      FROM public.grade_outcomes o
      WHERE o.buyer_user_id IS NOT NULL AND o.created_at >= (SELECT since FROM win)),
    'guarantee_claims', (SELECT jsonb_build_object(
        'users', count(DISTINCT g.user_id), 'events', count(*))
      FROM public.buyer_guarantee_claims g WHERE g.created_at >= (SELECT since FROM win)),
    'portfolio', (SELECT jsonb_build_object(
        'users', count(DISTINCT c.user_id), 'events', count(*))
      FROM public.closet_items c WHERE c.created_at >= (SELECT since FROM win)),
    'wants', (SELECT jsonb_build_object(
        'users', count(DISTINCT w.user_id), 'events', count(*))
      FROM public.buyer_wants w WHERE w.created_at >= (SELECT since FROM win)),
    -- Authenticity has no table of its own: the meter counter IS the record.
    -- Current billing period, not the window — say so rather than pretend.
    'authenticity', (SELECT jsonb_build_object(
        'users', count(*) FILTER (WHERE coalesce((m.usage ->> 'authenticity_credits')::int, 0) > 0),
        'events', coalesce(sum(coalesce((m.usage ->> 'authenticity_credits')::int, 0)), 0))
      FROM public.buyer_meter_usage m),
    'video_grade', (SELECT jsonb_build_object(
        'users', count(DISTINCT s.user_id), 'events', count(*))
      FROM public.submissions s
      WHERE s.buyer_video_grade = true AND s.created_at >= (SELECT since FROM win))
  ),
  'flywheel', coalesce((
    SELECT jsonb_agg(jsonb_build_object(
      'date', to_char(d.day, 'YYYY-MM-DD'),
      'buyer_demand', d.n,
      'seller_grades', g.n
    ) ORDER BY d.day)
    FROM demand d JOIN grades g ON g.day = d.day
  ), '[]'::jsonb),
  'attribution', coalesce((
    SELECT jsonb_agg(jsonb_build_object(
      'source', a.source,
      'medium', a.medium,
      'campaign', a.campaign,
      'buyers', a.buyers,
      'paid_buyers', a.paid_buyers,
      'guard_monthly', a.guard_monthly,
      'guard_yearly', a.guard_yearly,
      'connoisseur_monthly', a.connoisseur_monthly,
      'connoisseur_yearly', a.connoisseur_yearly,
      'metered_units', a.metered_units
    ) ORDER BY a.buyers DESC, a.source)
    FROM attribution a
  ), '[]'::jsonb)
))
  END
$$;


-- community_benchmarks -> authenticated
-- LANGUAGE sql scalar; the expression is gated in place
-- body from 00569_community_benchmarks_filters.sql, unchanged apart from the guard.
create or replace function public.community_benchmarks(
  p_period_start date default null,
  -- US-2235 AC1. All null (the default) = the unfiltered snapshot 00241
  -- returned, byte for byte. Text filters are case-insensitive exact matches on
  -- the SAME normalized expressions the aggregates group by, so "nike" selects
  -- exactly the cohort the topBrands row for "Nike" describes.
  p_brand text default null,
  p_category text default null,
  p_size text default null,
  -- Bounds on the LISTING price, which is the number a sourcing decision turns
  -- on. Sale price is an outcome; you cannot filter your sourcing by it.
  p_price_min numeric default null,
  p_price_max numeric default null
)
returns jsonb
language sql
stable
security definer
set search_path = public
AS $$
  SELECT CASE WHEN public.gt_require_role('community_benchmarks', 'authenticated')
    THEN (with cfg as (
    -- Configured threshold, clamped to a hard floor of 5. Never lets an operator
    -- weaken k-anonymity below the documented guarantee.
    select greatest(
      5,
      coalesce(
        (select nullif(value #>> '{}', '')::int
           from public.system_settings
          where key = 'community_min_cohort_sellers'),
        5
      )
    )::int as min_sellers
  ),
  base as (
    -- One row per inventory item, platform-wide, with its latest listing/sale.
    select
      i.user_id,
      coalesce(nullif(trim(i.brand), ''), 'No brand') as brand,
      coalesce(
        nullif(trim(coalesce(i.item_category::text, i.garment_category::text)), ''),
        'Uncategorized'
      ) as category,
      nullif(trim(i.size), '') as size,
      l.list_date,
      l.list_price,
      sa.sale_date,
      sa.sale_price
    from public.inventory_items i
    left join lateral (
      select listed_at as list_date, listing_price as list_price
      from public.listings
      where listings.inventory_item_id = i.id
      order by listings.listed_at desc nulls last, listings.created_at desc
      limit 1
    ) l on true
    left join lateral (
      select coalesce(sold_at, sale_date) as sale_date, sale_price
      from public.sales
      where sales.inventory_item_id = i.id
      order by coalesce(sales.sold_at, sales.sale_date) desc nulls last,
        sales.created_at desc
      limit 1
    ) sa on true
    -- ── US-2235 AC1: THE FILTERS GO HERE, AND ONLY HERE ────────────────────
    --
    -- Applying them to `base` is what makes this safe, and it is worth being
    -- explicit about why, because filtering is exactly how a k-anonymity
    -- guarantee gets broken. Every aggregate below already carries its own
    -- `sellers >= min_sellers` guard. Narrowing `base` means each of those
    -- guards re-evaluates against the FILTERED cohort — so an attacker who
    -- filters down to one seller gets nulls everywhere, not that seller's
    -- numbers. No new guard is needed, and none may be added downstream: a
    -- filter applied in the OUTPUT projection instead would leave every guard
    -- counting the unfiltered population and would hand back a cohort of one.
    --
    -- The caller's own "you" section is unaffected by that reasoning — it is
    -- their data — but it IS filtered too, which is the honest behaviour:
    -- "your sell-through on Nike" should mean Nike.
    where (p_brand is null
        or lower(coalesce(nullif(trim(i.brand), ''), 'No brand')) = lower(trim(p_brand)))
      and (p_category is null
        or lower(coalesce(
             nullif(trim(coalesce(i.item_category::text, i.garment_category::text)), ''),
             'Uncategorized'
           )) = lower(trim(p_category)))
      -- An item with NO size cannot match a size filter. Treating null as a
      -- match would silently widen the cohort past what the seller asked for.
      and (p_size is null
        or lower(coalesce(nullif(trim(i.size), ''), '')) = lower(trim(p_size)))
      -- Same for price: an unlisted item has no list price, so it is outside
      -- any band rather than inside every one.
      and (p_price_min is null or (l.list_price is not null and l.list_price >= p_price_min))
      and (p_price_max is null or (l.list_price is not null and l.list_price <= p_price_max))
  ),
  hits as (
    -- Apply the period window once; an item is "listed"/"sold" in-window the
    -- same way flipdesk_sell_through defines it (null period = all time).
    select
      user_id,
      brand,
      category,
      size,
      list_date,
      list_price,
      sale_date,
      sale_price,
      (list_date is not null
        and (p_period_start is null or list_date::date >= p_period_start)) as listed_hit,
      (sale_date is not null
        and (p_period_start is null or sale_date::date >= p_period_start)) as sold_hit
    from base
  ),
  -- In-window sold items with the two derived per-item facts the deep-dives need:
  -- days listed→sold and sale/list price realization. percentile_cont ignores the
  -- NULLs from items missing a list date / list price, so no extra filtering.
  sold_items as (
    select
      user_id,
      brand,
      category,
      sale_price,
      list_price,
      case when list_date is not null and sale_date::date >= list_date::date
        then (sale_date::date - list_date::date) end as days_to_sell,
      case when list_price is not null and list_price > 0 and sale_price is not null
        then sale_price::numeric / list_price end as realization
    from hits
    where sold_hit
  ),
  -- ── Brand deep-dive (k-anonymous) ─────────────────────────────────────────
  brand_agg as (
    select
      brand,
      count(distinct user_id) filter (where listed_hit or sold_hit) as sellers,
      count(*) filter (where listed_hit) as listed,
      count(*) filter (where sold_hit)   as sold,
      avg(sale_price) filter (where sold_hit and sale_price is not null) as avg_sale_price
    from hits
    where brand <> 'No brand'
    group by brand
    having count(distinct user_id) filter (where listed_hit or sold_hit) >= (select min_sellers from cfg)
       and count(*) filter (where listed_hit) >= (select min_sellers from cfg)
  ),
  brand_sold as (
    select
      brand,
      count(distinct user_id) as sellers,
      percentile_cont(0.5) within group (order by days_to_sell) as median_days,
      percentile_cont(0.5) within group (order by realization)  as median_real
    from sold_items
    where brand <> 'No brand'
    group by brand
  ),
  -- ── Category deep-dive (k-anonymous), same shape as brands ────────────────
  category_agg as (
    select
      category,
      count(distinct user_id) filter (where listed_hit or sold_hit) as sellers,
      count(*) filter (where listed_hit) as listed,
      count(*) filter (where sold_hit)   as sold,
      avg(sale_price) filter (where sold_hit and sale_price is not null) as avg_sale_price
    from hits
    where category <> 'Uncategorized'
    group by category
    having count(distinct user_id) filter (where listed_hit or sold_hit) >= (select min_sellers from cfg)
       and count(*) filter (where listed_hit) >= (select min_sellers from cfg)
  ),
  category_sold as (
    select
      category,
      count(distinct user_id) as sellers,
      percentile_cont(0.5) within group (order by days_to_sell) as median_days,
      percentile_cont(0.5) within group (order by realization)  as median_real
    from sold_items
    where category <> 'Uncategorized'
    group by category
  ),
  -- ── Trending categories: last 30d vs prior 30d (k-anonymous) ──────────────
  cat_trend as (
    select
      category,
      count(distinct user_id)
        filter (where sale_date is not null
          and sale_date::date >= current_date - 60) as sellers,
      count(*) filter (where sale_date is not null
        and sale_date::date >= current_date - 30) as sold_recent,
      count(*) filter (where sale_date is not null
        and sale_date::date >= current_date - 60
        and sale_date::date <  current_date - 30) as sold_prev
    from hits
    where category <> 'Uncategorized'
    group by category
    having count(distinct user_id)
      filter (where sale_date is not null
        and sale_date::date >= current_date - 60) >= (select min_sellers from cfg)
  ),
  -- ── Price realization, community-wide (k-anonymous) ───────────────────────
  realization_stats as (
    select
      count(distinct user_id) as sellers,
      count(*) filter (where realization is not null) as sales,
      percentile_cont(0.25) within group (order by realization)  as p25,
      percentile_cont(0.5)  within group (order by realization)  as p50,
      percentile_cont(0.75) within group (order by realization)  as p75,
      percentile_cont(0.5)  within group (order by sale_price)   as median_sale,
      percentile_cont(0.5)  within group (order by list_price)   as median_list
    from sold_items
    where realization is not null
  ),
  -- ── Time-to-sell percentiles, community-wide (k-anonymous) ────────────────
  tts_stats as (
    select
      count(distinct user_id) as sellers,
      count(*) filter (where days_to_sell is not null) as sales,
      percentile_cont(0.25) within group (order by days_to_sell) as p25,
      percentile_cont(0.5)  within group (order by days_to_sell) as p50,
      percentile_cont(0.75) within group (order by days_to_sell) as p75,
      percentile_cont(0.9)  within group (order by days_to_sell) as p90
    from sold_items
    where days_to_sell is not null
  ),
  -- ── Trend series: fixed windows + 12-month monthly buckets ────────────────
  -- These define their OWN time windows (sale_date based), so — like trending
  -- categories — they ignore p_period_start and always reflect the live trend.
  all_sales as (
    select user_id, sale_date::date as sd, sale_price
    from base
    where sale_date is not null
  ),
  win as (
    select
      count(distinct user_id) filter (where sd >= current_date - 30)  as s30_sellers,
      count(*) filter (where sd >= current_date - 30)                 as s30_sold,
      sum(sale_price) filter (where sd >= current_date - 30)          as s30_gmv,
      count(distinct user_id) filter (where sd >= current_date - 90)  as s90_sellers,
      count(*) filter (where sd >= current_date - 90)                 as s90_sold,
      sum(sale_price) filter (where sd >= current_date - 90)          as s90_gmv,
      count(distinct user_id) filter (where sd >= current_date - 365) as s365_sellers,
      count(*) filter (where sd >= current_date - 365)                as s365_sold,
      sum(sale_price) filter (where sd >= current_date - 365)         as s365_gmv
    from all_sales
  ),
  months as (
    select
      to_char(g, 'YYYY-MM') as month,
      g as month_start
    from generate_series(
      date_trunc('month', current_date::timestamp) - interval '11 months',
      date_trunc('month', current_date::timestamp),
      interval '1 month'
    ) g
  ),
  monthly as (
    select
      m.month,
      m.month_start,
      count(distinct s.user_id) as sellers,
      count(s.*) as sold,
      coalesce(sum(s.sale_price), 0) as gmv
    from months m
    left join all_sales s on date_trunc('month', s.sd::timestamp) = m.month_start
    group by m.month, m.month_start
  ),
  -- ── Seller-level sell-through for the you-vs-peers comparison ──────────────
  -- Require a minimum listing volume so a 1-item fluke is not a "rate".
  seller_rates as (
    select
      user_id,
      count(*) filter (where listed_hit) as listed,
      count(*) filter (where sold_hit)   as sold,
      (count(*) filter (where sold_hit))::numeric
        / nullif(count(*) filter (where listed_hit), 0) as st
    from hits
    group by user_id
    having count(*) filter (where listed_hit) >= 3
  ),
  caller as (
    select listed, sold, st from seller_rates where user_id = auth.uid()
  ),
  -- The caller's raw counts, independent of the >= 3 listed floor, so they
  -- always see their own numbers even with thin inventory.
  caller_raw as (
    select
      count(*) filter (where listed_hit) as listed,
      count(*) filter (where sold_hit)   as sold
    from hits
    where user_id = auth.uid()
  ),
  -- The caller's own time-to-sell / realization medians — always shown (own data).
  caller_sold as (
    select
      percentile_cont(0.5) within group (order by days_to_sell) as median_days,
      percentile_cont(0.5) within group (order by realization)  as median_real,
      count(*) filter (where days_to_sell is not null) as with_days,
      count(*) filter (where realization is not null)  as with_real
    from sold_items
    where user_id = auth.uid()
  ),
  peers as (
    select st from seller_rates where user_id <> auth.uid() and st is not null
  ),
  peer_stats as (
    select
      count(*) as n,
      percentile_cont(0.5) within group (order by st) as median
    from peers
  ),
  -- ── US-2235 AC2: how many sellers are actually behind these numbers ───────
  --
  -- The page previously showed medians and percentiles with no sense of scale,
  -- so "the community median" read the same whether it came from 6 sellers or
  -- 600. That is the difference between a curiosity and a number worth sourcing
  -- against, and only one of the two deserves the confidence the UI projected.
  --
  -- Two counts, because they answer different questions: `cohort` is who is in
  -- the current (possibly filtered) view, `total` is the whole platform. A
  -- seller narrowing to one brand needs to see BOTH — "12 of 480 sellers" says
  -- what a bare 12 cannot.
  --
  -- Both pass the same k-anonymity floor. A cohort count below the floor is
  -- returned as null, not as the number: every aggregate is already nulled at
  -- that point, and publishing "3 sellers" alongside them would leak the one
  -- fact the nulls exist to withhold.
  coverage_stats as (
    select
      (select count(distinct user_id) from hits) as cohort_sellers,
      (select count(distinct user_id) from public.inventory_items) as total_sellers
  )
  select jsonb_build_object(
    'meta', jsonb_build_object(
      'minSellers', (select min_sellers from cfg),
      'periodStart', p_period_start,
      'generatedAt', now(),
      -- Echoed back so the client renders what the SERVER actually applied
      -- rather than what it believes it asked for. The two diverge the moment a
      -- filter is added on one side only, and a banner claiming a filter that
      -- never reached the query is worse than no banner.
      'filters', jsonb_build_object(
        'brand', nullif(trim(coalesce(p_brand, '')), ''),
        'category', nullif(trim(coalesce(p_category, '')), ''),
        'size', nullif(trim(coalesce(p_size, '')), ''),
        'priceMin', p_price_min,
        'priceMax', p_price_max
      ),
      'coverage', (
        select jsonb_build_object(
          'cohortSellers', case when cv.cohort_sellers >= (select min_sellers from cfg)
            then cv.cohort_sellers else null end,
          'totalSellers', case when cv.total_sellers >= (select min_sellers from cfg)
            then cv.total_sellers else null end,
          -- So the UI can say "too few to show" without inferring it from a
          -- null it cannot distinguish from "nobody has sold anything yet".
          'belowFloor', cv.cohort_sellers < (select min_sellers from cfg)
        )
        from coverage_stats cv
      )
    ),
    'topBrands', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'brand', ba.brand,
          'sellers', ba.sellers,
          'listed', ba.listed,
          'sold', ba.sold,
          'sellThrough', case when ba.listed > 0 then ba.sold::numeric / ba.listed else null end,
          'avgSalePrice', round(ba.avg_sale_price::numeric, 2),
          -- Per-brand derived medians only when the brand's SOLD cohort itself is
          -- k-anonymous (distinct sellers who sold it >= floor).
          'medianRealization', case when bs.sellers >= (select min_sellers from cfg)
            then round(bs.median_real::numeric, 4) else null end,
          'medianDaysToSell', case when bs.sellers >= (select min_sellers from cfg)
            then round(bs.median_days::numeric, 1) else null end
        )
        order by case when ba.listed > 0 then ba.sold::numeric / ba.listed else 0 end desc,
          ba.sold desc
      )
      from brand_agg ba
      left join brand_sold bs on bs.brand = ba.brand
    ), '[]'::jsonb),
    'categories', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'category', ca.category,
          'sellers', ca.sellers,
          'listed', ca.listed,
          'sold', ca.sold,
          'sellThrough', case when ca.listed > 0 then ca.sold::numeric / ca.listed else null end,
          'avgSalePrice', round(ca.avg_sale_price::numeric, 2),
          'medianRealization', case when cs.sellers >= (select min_sellers from cfg)
            then round(cs.median_real::numeric, 4) else null end,
          'medianDaysToSell', case when cs.sellers >= (select min_sellers from cfg)
            then round(cs.median_days::numeric, 1) else null end
        )
        order by case when ca.listed > 0 then ca.sold::numeric / ca.listed else 0 end desc,
          ca.sold desc
      )
      from category_agg ca
      left join category_sold cs on cs.category = ca.category
    ), '[]'::jsonb),
    'trendingCategories', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'category', category,
          'sellers', sellers,
          'soldRecent', sold_recent,
          'soldPrevious', sold_prev,
          'growth', case when sold_prev > 0
            then (sold_recent - sold_prev)::numeric / sold_prev else null end
        )
        order by sold_recent desc, sold_prev desc
      )
      from cat_trend
    ), '[]'::jsonb),
    -- Overall price realization (sale vs list). Null until the cohort is k-anon.
    'priceRealization', (
      select case when rs.sellers >= (select min_sellers from cfg) then jsonb_build_object(
        'sellers', rs.sellers,
        'sales', rs.sales,
        'medianRatio', round(rs.p50::numeric, 4),
        'p25Ratio', round(rs.p25::numeric, 4),
        'p75Ratio', round(rs.p75::numeric, 4),
        'medianSalePrice', round(rs.median_sale::numeric, 2),
        'medianListPrice', round(rs.median_list::numeric, 2)
      ) else null end
      from realization_stats rs
    ),
    -- Time-to-sell distribution (days). Null until the cohort is k-anon.
    'timeToSell', (
      select case when ts.sellers >= (select min_sellers from cfg) then jsonb_build_object(
        'sellers', ts.sellers,
        'sales', ts.sales,
        'p25', round(ts.p25::numeric, 1),
        'p50', round(ts.p50::numeric, 1),
        'p75', round(ts.p75::numeric, 1),
        'p90', round(ts.p90::numeric, 1)
      ) else null end
      from tts_stats ts
    ),
    -- Trend windows + monthly series. Each window / month with too few sellers is
    -- nulled out (kept in the series so the chart shows a gap, never a count < floor).
    'trends', jsonb_build_object(
      'windows', (
        select jsonb_build_object(
          'd30', case when w.s30_sellers >= (select min_sellers from cfg)
            then jsonb_build_object('sellers', w.s30_sellers, 'sold', w.s30_sold,
              'gmv', round(coalesce(w.s30_gmv, 0)::numeric, 2)) else null end,
          'd90', case when w.s90_sellers >= (select min_sellers from cfg)
            then jsonb_build_object('sellers', w.s90_sellers, 'sold', w.s90_sold,
              'gmv', round(coalesce(w.s90_gmv, 0)::numeric, 2)) else null end,
          'd365', case when w.s365_sellers >= (select min_sellers from cfg)
            then jsonb_build_object('sellers', w.s365_sellers, 'sold', w.s365_sold,
              'gmv', round(coalesce(w.s365_gmv, 0)::numeric, 2)) else null end
        )
        from win w
      ),
      'monthly', coalesce((
        select jsonb_agg(
          jsonb_build_object(
            'month', mo.month,
            'sellers', case when mo.sellers >= (select min_sellers from cfg) then mo.sellers else null end,
            'sold', case when mo.sellers >= (select min_sellers from cfg) then mo.sold else null end,
            'gmv', case when mo.sellers >= (select min_sellers from cfg) then round(mo.gmv::numeric, 2) else null end
          )
          order by mo.month_start
        )
        from monthly mo
      ), '[]'::jsonb)
    ),
    'you', jsonb_build_object(
      'listed', (select listed from caller_raw),
      'sold', (select sold from caller_raw),
      'sellThrough', (
        select case when listed > 0 then sold::numeric / listed else null end
        from caller_raw
      ),
      'medianDaysToSell', (
        select case when with_days > 0 then round(median_days::numeric, 1) else null end
        from caller_sold
      ),
      'medianRealization', (
        select case when with_real > 0 then round(median_real::numeric, 4) else null end
        from caller_sold
      ),
      -- Peer comparison is itself k-anonymous: shown only when >= floor peers have
      -- a rate, and exposes only cohort statistics (median, the caller's percentile
      -- among peers) — never an individual peer's value.
      'peerComparison', (
        select case when ps.n >= (select min_sellers from cfg) then jsonb_build_object(
          'peerCount', ps.n,
          'peerMedianSellThrough', round(ps.median::numeric, 4),
          'yourSellThrough', (select st from caller),
          'percentile', case
            when (select st from caller) is not null then (
              select round(avg(case when p.st <= (select st from caller)
                then 1.0 else 0.0 end)::numeric, 2)
              from peers p
            )
            else null
          end
        ) else null end
        from peer_stats ps
      )
    )
  ))
  END
$$;


-- increment_grades_used is DROPPED rather than guarded.
--
-- It has no callers anywhere: not the edge, not the web app, not iOS, not
-- Android, not the extension, not a script. It is a leftover from 00004 that
-- superseded itself, and it was reachable by anon with no guard - the probe that
-- proved this whole class ran against it and got a 204. Guarding dead code keeps
-- it alive; the smaller and better fix is to remove the surface.
--
-- Recreating it is one CREATE from 00004 if it is ever wanted back.
DROP FUNCTION IF EXISTS public.increment_grades_used(uuid);

insert into public.applied_migrations (version) values ('00640') on conflict do nothing;
