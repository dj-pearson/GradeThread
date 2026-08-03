-- US-2289 AC2: make the grade-credit debit idempotent.
--
-- A batch grading job that was reclaimed after a stale lease used to run
-- gradeBatchItem again from the top: new submission, fresh charge. With
-- MAX_GRADE_JOB_ATTEMPTS at 5 that is up to five credits debited for one
-- garment. The ROOT fix shipped separately (the job row now carries its
-- submission_id, so a reclaim resumes rather than restarts) — this is the
-- second line, for the case where the root fix is bypassed by a code path
-- nobody has thought about yet.
--
-- The storage was already here and unused: 00216 added
-- grade_credit_transactions.idempotency_key plus a PARTIAL unique index on it
-- (partial so the millions of rows without a key are unaffected — multiple
-- NULLs never collide). The grading path simply never set it. This threads it
-- through the RPC.
--
-- BACKWARD COMPATIBLE BY CONSTRUCTION: the new parameter is trailing and
-- defaults to NULL, so every existing caller keeps its current behaviour
-- exactly. With no key the function is byte-for-byte what it was.

create or replace function public.debit_grade_credits(
  p_user_id uuid,
  p_credits integer,
  p_submission_id uuid,
  p_notes text default null::text,
  p_idempotency_key text default null::text
)
returns integer
language plpgsql
security definer
set search_path to 'public'
as $function$
DECLARE
  v_balance integer;
  v_existing integer;
BEGIN
  IF p_credits <= 0 THEN
    RAISE EXCEPTION 'INVALID_CREDIT_AMOUNT: must be positive (got %)', p_credits;
  END IF;

  -- The row lock is what makes the check-then-act below safe: it serialises
  -- every debit for this user, so a concurrent retry waits here rather than
  -- racing past the duplicate check.
  SELECT grade_credit_balance INTO v_balance
    FROM public.users
    WHERE id = p_user_id
    FOR UPDATE;

  IF v_balance IS NULL THEN
    RAISE EXCEPTION 'USER_NOT_FOUND: %', p_user_id;
  END IF;

  -- US-2289: a replay of a charge that already happened is a NO-OP that
  -- reports success. Returning the current balance rather than raising is
  -- deliberate — the caller's intent ("this submission is paid for") is
  -- already satisfied, and an error here would make a harmless retry look
  -- like a billing failure and push the caller into a checkout it does not
  -- need.
  IF p_idempotency_key IS NOT NULL THEN
    SELECT balance_after INTO v_existing
      FROM public.grade_credit_transactions
      WHERE idempotency_key = p_idempotency_key
      LIMIT 1;
    IF FOUND THEN
      RETURN v_balance;
    END IF;
  END IF;

  IF v_balance < p_credits THEN
    RAISE EXCEPTION 'INSUFFICIENT_CREDITS: balance % < requested %', v_balance, p_credits;
  END IF;

  v_balance := v_balance - p_credits;

  UPDATE public.users
    SET grade_credit_balance = v_balance,
        updated_at = now()
    WHERE id = p_user_id;

  INSERT INTO public.grade_credit_transactions
    (user_id, delta, reason, balance_after, submission_id, notes, idempotency_key)
    VALUES (p_user_id, -p_credits, 'grade_debit', v_balance, p_submission_id, p_notes,
            p_idempotency_key);

  RETURN v_balance;
END;
$function$;

comment on function public.debit_grade_credits(uuid, integer, uuid, text, text) is
  'US-2289: debit grade credits, optionally idempotent. Passing the same '
  'p_idempotency_key twice performs the debit ONCE and returns the current '
  'balance on the replay. The 4-arg call remains unchanged.';

-- The 4-arg overload created by the old signature would otherwise linger and
-- silently win for existing callers, leaving them on the pre-idempotency body.
drop function if exists public.debit_grade_credits(uuid, integer, uuid, text);

grant execute on function public.debit_grade_credits(uuid, integer, uuid, text, text) to service_role;

insert into public.applied_migrations (version) values ('00516') on conflict do nothing;
