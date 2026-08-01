-- US-2376: freeze the grading-lifecycle columns on public.submissions against
-- end-user (authenticated-role) self-updates.
--
-- "Users can update own submissions" (00451) is USING-only, with no WITH CHECK
-- and no column list, and the sole BEFORE UPDATE trigger on the table (00001)
-- only stamps updated_at. So a seller holding their own JWT could PATCH their
-- own submission row and set status='completed', clear refunded_at, unset
-- flagged, or zero grading_attempts — straight from a devtools console.
--
-- Mirrors guard_users_protected_columns (00347/00331) exactly, including the
-- service-role short-circuit: edge functions, SECURITY DEFINER triggers and
-- direct DB sessions run under a different role and still own these columns.
-- The grading pipeline, the stuck-submission sweep and the admin routes all go
-- through the service-role client, so nothing legitimate is affected — no web,
-- iOS or Android client writes public.submissions directly today.
--
-- The columns a seller DOES legitimately edit (title, description, brand,
-- garment_type, garment_category, style_attributes, verified_capture_opt_in …)
-- are deliberately absent from this list and stay writable.

CREATE OR REPLACE FUNCTION public.guard_submissions_protected_columns()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Only end-user (browser/app) updates are guarded.
  IF auth.role() IS DISTINCT FROM 'authenticated' THEN
    RETURN NEW;
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status
     OR NEW.payment_status IS DISTINCT FROM OLD.payment_status
     OR NEW.service_tier IS DISTINCT FROM OLD.service_tier
     OR NEW.authenticity_addon IS DISTINCT FROM OLD.authenticity_addon
     OR NEW.refunded_at IS DISTINCT FROM OLD.refunded_at
     OR NEW.flagged IS DISTINCT FROM OLD.flagged
     OR NEW.flag_reason IS DISTINCT FROM OLD.flag_reason
     OR NEW.moderation_status IS DISTINCT FROM OLD.moderation_status
     OR NEW.grading_started_at IS DISTINCT FROM OLD.grading_started_at
     OR NEW.grading_lease_until IS DISTINCT FROM OLD.grading_lease_until
     OR NEW.grading_attempts IS DISTINCT FROM OLD.grading_attempts
     -- Clearing these would pull a retaken-and-superseded submission back into
     -- the active counts the monthly quota is measured against (00252).
     OR NEW.superseded_at IS DISTINCT FROM OLD.superseded_at
     OR NEW.superseded_by_submission_id IS DISTINCT FROM OLD.superseded_by_submission_id
  THEN
    RAISE EXCEPTION
      'submissions: grading lifecycle columns (status/payment/moderation/lease) cannot be modified by the submission owner';
  END IF;

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.guard_submissions_protected_columns() IS
  'US-2376: freezes status/payment/moderation/grading-lease columns against end-user (authenticated-role) self-updates. Service-role and SECURITY DEFINER paths bypass via the auth.role() check. Counterpart to guard_users_protected_columns.';

DROP TRIGGER IF EXISTS guard_submissions_protected_columns ON public.submissions;
CREATE TRIGGER guard_submissions_protected_columns
  BEFORE UPDATE ON public.submissions
  FOR EACH ROW
  EXECUTE FUNCTION public.guard_submissions_protected_columns();

-- Self-record so the edge boot guard stays in sync (US-1108).
INSERT INTO public.applied_migrations (version) VALUES ('00511') ON CONFLICT DO NOTHING;
