-- Optional per-user monthly AI-action budget. NULL means "use the plan
-- default" — a user can set a lower number to cap their own spend.

ALTER TABLE public.users
  ADD COLUMN ai_action_limit int
    CHECK (ai_action_limit IS NULL OR ai_action_limit >= 0);
