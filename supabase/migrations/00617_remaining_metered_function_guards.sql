-- US-2282: the three anon-executable functions 00615 and 00616 did not reach.
--
-- MEASURED, not inferred. After a `supabase db reset` over the full directory
-- including 00615 and 00616, every one of the fourteen credit/meter functions
-- was called as `anon` (role claim set, `set local role anon`, each in a rolled
-- back savepoint). Eleven now answer 42501. Three still reach their body:
--
--   equity_snapshot_owners   returns the user_id of every seller holding live
--                            inventory. A customer roster, to anyone with the
--                            public anon key.
--   refund_ai_action         decrements ai_actions_used_this_month. MUTATES.
--   refund_buyer_meter       decrements a buyer meter counter. MUTATES.
--
-- Two of the three write. They are not credit grants, which is why a sweep
-- keyed on "credit" missed them, and they are still a stranger editing a
-- paying customer's quota one call at a time.
--
-- WHY THEY WERE MISSED IS THE REUSABLE PART. 00615 fixed the nine functions
-- whose NAME carries `credit`, and 00616 the SQL-language ones it found. These
-- three are the residue of both cuts: `refund_ai_action` and
-- `refund_buyer_meter` spend a metered allowance rather than a credit balance,
-- and `equity_snapshot_owners` reads rather than writes, so a mutation-only
-- sweep skips it too. Name-shaped and verb-shaped searches each leave a
-- different remainder; calling every candidate and reading the answer leaves
-- none, which is how these three surfaced.
--
-- Every caller is the edge through the service-role client, traced before
-- writing: jobs-equity-snapshot.ts, lib/ai-metering.ts and lib/buyer-metering.ts
-- respectively. No browser call site for any of them.
--
-- refund_buyer_meter has ONE in-database caller, public.refund_grade. Entering a
-- SECURITY DEFINER function does not change the request.jwt.claim.role GUC, so
-- auth.role() inside the nested call is still service_role and the guard passes.
-- Verified by calling refund_grade as service_role after applying this: it
-- reaches its own SUBMISSION_NOT_FOUND rather than 42501.
--
-- No REVOKE, for the reasons 00611 and 00615 both record: a revoke naming only
-- anon is a no-op, and one naming PUBLIC strips service_role wherever it holds
-- EXECUTE through the PUBLIC default. See
-- vault/20-domain/postgres-revoke-from-anon-is-a-noop.md.
--
-- The two `language sql` bodies become plpgsql because SQL cannot raise. Their
-- statements are unchanged; `#variable_conflict use_column` keeps the RETURNS
-- TABLE output name `user_id` resolving as a column.

CREATE OR REPLACE FUNCTION public.equity_snapshot_owners(p_limit integer DEFAULT 20000)
 RETURNS TABLE(user_id uuid)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
#variable_conflict use_column
BEGIN
  IF auth.role() IS NOT NULL AND auth.role() <> 'service_role' THEN
    RAISE EXCEPTION 'equity_snapshot_owners: service role required' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  SELECT DISTINCT i.user_id
  FROM public.inventory_items i
  WHERE i.user_id IS NOT NULL
    AND i.status NOT IN ('sold', 'shipped', 'completed', 'archived')
  ORDER BY i.user_id
  LIMIT GREATEST(COALESCE(p_limit, 20000), 1);
END;
$function$;

CREATE OR REPLACE FUNCTION public.refund_ai_action(p_user_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF auth.role() IS NOT NULL AND auth.role() <> 'service_role' THEN
    RAISE EXCEPTION 'refund_ai_action: service role required' USING ERRCODE = '42501';
  END IF;

  UPDATE public.users
    SET ai_actions_used_this_month = greatest(0, ai_actions_used_this_month - 1)
    WHERE id = p_user_id;
END;
$function$;

CREATE OR REPLACE FUNCTION public.refund_buyer_meter(p_user_id uuid, p_meter text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_usage jsonb;
  v_used  int;
BEGIN
  IF auth.role() IS NOT NULL AND auth.role() <> 'service_role' THEN
    RAISE EXCEPTION 'refund_buyer_meter: service role required' USING ERRCODE = '42501';
  END IF;

  SELECT usage INTO v_usage FROM public.buyer_meter_usage WHERE user_id = p_user_id FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;
  v_used := COALESCE((v_usage ->> p_meter)::int, 0);
  IF v_used <= 0 THEN RETURN; END IF;
  UPDATE public.buyer_meter_usage
    SET usage = jsonb_set(v_usage, ARRAY[p_meter], to_jsonb(v_used - 1)),
        updated_at = now()
    WHERE user_id = p_user_id;
END;
$function$;

insert into public.applied_migrations (version) values ('00617') on conflict do nothing;
