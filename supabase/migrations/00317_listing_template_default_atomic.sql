-- 00317_listing_template_default_atomic.sql
--
-- US-1265 — setting a listing template as the default must never leave the
-- seller with ZERO defaults if the write fails.
--
-- The iOS TemplateService used to clear the prior default in a SEPARATE UPDATE
-- *before* the create/update write. If that second write failed (duplicate
-- name, RLS, network drop mid-statement), the clear had already committed and
-- the seller was left with no default at all. A pure client-side "write then
-- clear" reorder is impossible: the partial unique index
-- `idx_listing_templates_one_default` rejects inserting/updating a second
-- is_default=true row while another exists, so the clear MUST precede the write.
--
-- Fix = do BOTH in one transactional RPC. A plpgsql function runs inside the
-- request transaction, so if the INSERT/UPDATE raises, the preceding clear
-- rolls back with it — there is never a window of zero defaults on failure.
--
-- SECURITY INVOKER: the functions run as the calling user, so the existing RLS
-- policies on listing_templates (auth.uid() = user_id) still scope every read
-- and write — no privilege escalation. Idempotent: CREATE OR REPLACE.

BEGIN;

-- Atomically create a template, optionally clearing the caller's prior default
-- first. Returns the inserted row. If the INSERT fails (e.g. duplicate name),
-- the whole function — including the clear — rolls back.
CREATE OR REPLACE FUNCTION public.create_listing_template(
  p_name                 text,
  p_description_template text,
  p_ebay_condition       text,
  p_condition_description text,
  p_item_specifics       jsonb,
  p_ebay_category_id     text,
  p_return_policy_id     text,
  p_shipping_policy_id   text,
  p_payment_policy_id    text,
  p_is_default           boolean,
  p_sort_order           integer
)
RETURNS public.listing_templates
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_user uuid := auth.uid();
  v_row  public.listing_templates;
BEGIN
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'not authenticated' USING errcode = '28000';
  END IF;

  IF COALESCE(p_is_default, false) THEN
    UPDATE public.listing_templates
       SET is_default = false
     WHERE user_id = v_user AND is_default;
  END IF;

  INSERT INTO public.listing_templates (
    user_id, name, description_template, ebay_condition, condition_description,
    item_specifics, ebay_category_id, return_policy_id, shipping_policy_id,
    payment_policy_id, is_default, sort_order
  ) VALUES (
    v_user, p_name, p_description_template, p_ebay_condition, p_condition_description,
    COALESCE(p_item_specifics, '{}'::jsonb), p_ebay_category_id, p_return_policy_id,
    p_shipping_policy_id, p_payment_policy_id, COALESCE(p_is_default, false),
    COALESCE(p_sort_order, 0)
  )
  RETURNING * INTO v_row;

  RETURN v_row;
END;
$$;

-- Atomically update a template, optionally clearing the caller's OTHER defaults
-- first, then re-setting this row as the default in the same transaction. If the
-- target UPDATE fails (or matches no owned row), the clear rolls back too.
CREATE OR REPLACE FUNCTION public.update_listing_template(
  p_id                   uuid,
  p_name                 text,
  p_description_template text,
  p_ebay_condition       text,
  p_condition_description text,
  p_item_specifics       jsonb,
  p_ebay_category_id     text,
  p_return_policy_id     text,
  p_shipping_policy_id   text,
  p_payment_policy_id    text,
  p_is_default           boolean,
  p_sort_order           integer
)
RETURNS public.listing_templates
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_user uuid := auth.uid();
  v_row  public.listing_templates;
BEGIN
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'not authenticated' USING errcode = '28000';
  END IF;

  -- Clear every OTHER default first so the single-default index holds when the
  -- update below re-sets this row as the default.
  IF COALESCE(p_is_default, false) THEN
    UPDATE public.listing_templates
       SET is_default = false
     WHERE user_id = v_user AND is_default AND id <> p_id;
  END IF;

  UPDATE public.listing_templates
     SET name                 = p_name,
         description_template  = p_description_template,
         ebay_condition        = p_ebay_condition,
         condition_description = p_condition_description,
         item_specifics        = COALESCE(p_item_specifics, '{}'::jsonb),
         ebay_category_id      = p_ebay_category_id,
         return_policy_id      = p_return_policy_id,
         shipping_policy_id    = p_shipping_policy_id,
         payment_policy_id     = p_payment_policy_id,
         is_default            = COALESCE(p_is_default, false),
         sort_order            = COALESCE(p_sort_order, 0)
   WHERE id = p_id AND user_id = v_user
  RETURNING * INTO v_row;

  IF v_row.id IS NULL THEN
    RAISE EXCEPTION 'listing template % not found', p_id USING errcode = 'P0002';
  END IF;

  RETURN v_row;
END;
$$;

REVOKE ALL ON FUNCTION public.create_listing_template(
  text, text, text, text, jsonb, text, text, text, text, boolean, integer
) FROM public;
REVOKE ALL ON FUNCTION public.update_listing_template(
  uuid, text, text, text, text, jsonb, text, text, text, text, boolean, integer
) FROM public;
GRANT EXECUTE ON FUNCTION public.create_listing_template(
  text, text, text, text, jsonb, text, text, text, text, boolean, integer
) TO authenticated;
GRANT EXECUTE ON FUNCTION public.update_listing_template(
  uuid, text, text, text, text, jsonb, text, text, text, text, boolean, integer
) TO authenticated;

COMMIT;

INSERT INTO public.applied_migrations (version) VALUES ('00317') ON CONFLICT DO NOTHING;
