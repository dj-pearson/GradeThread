-- US-2667: allow escalation_trigger = 'crisis' on support_conversations.
--
-- 00188 added the column with CHECK (escalation_trigger IN ('model','auto','user')).
-- The crisis path (services/edge-functions/src/lib/support-crisis.ts) hands a
-- thread to a human WITHOUT the model ever running, so it needs a fourth value
-- the admin inbox can sort and badge on.
--
-- The old constraint was created inline by ADD COLUMN, so its name was assigned
-- by Postgres. Rather than assume `support_conversations_escalation_trigger_check`
-- and fail on a database where it landed as `..._check1`, the DO block drops
-- EVERY check constraint on this table whose definition mentions the column.
-- Idempotent both ways: the drop is conditional, and the re-add runs only when
-- the named constraint is absent.

DO $$
DECLARE
  c record;
BEGIN
  FOR c IN
    SELECT con.conname
    FROM pg_constraint con
    JOIN pg_class rel ON rel.oid = con.conrelid
    JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
    WHERE nsp.nspname = 'public'
      AND rel.relname = 'support_conversations'
      AND con.contype = 'c'
      AND pg_get_constraintdef(con.oid) ILIKE '%escalation_trigger%'
  LOOP
    EXECUTE format(
      'ALTER TABLE public.support_conversations DROP CONSTRAINT %I',
      c.conname
    );
  END LOOP;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'support_conversations_escalation_trigger_check'
      AND conrelid = 'public.support_conversations'::regclass
  ) THEN
    ALTER TABLE public.support_conversations
      ADD CONSTRAINT support_conversations_escalation_trigger_check
      CHECK (escalation_trigger IN ('model', 'auto', 'user', 'crisis'));
  END IF;
END $$;

-- Self-record (US-1108) so the edge boot guard stays truthful however this ran.
insert into public.applied_migrations (version) values ('00618') on conflict do nothing;
