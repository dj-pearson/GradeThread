-- US-2348: ai_prompt_versions is mutable only through the edge.
--
-- 00003 granted every is_admin() caller full INSERT/UPDATE/DELETE via RLS and
-- nothing since narrowed it. The admin SPA used that grant directly, so the
-- router scope guard, the MFA step-up on activate, the audit row and the
-- shadow/eval/canary lifecycle were all reachable-around. Reads stay open to
-- admins; only writes move behind the service-role client.
--
-- See .claude/skills/grading-engine/references/prompt-lifecycle.md for why a
-- live prompt is not editable in place.

DROP POLICY IF EXISTS "Admins can create AI prompt versions" ON public.ai_prompt_versions;
DROP POLICY IF EXISTS "Admins can update AI prompt versions" ON public.ai_prompt_versions;
DROP POLICY IF EXISTS "Admins can delete AI prompt versions" ON public.ai_prompt_versions;

-- No replacement policy is created. With RLS enabled and no permissive policy
-- for a command, that command is denied for every non-service role; the
-- service-role client bypasses RLS entirely, which is how the edge still
-- writes. The SELECT policy from 00003 is deliberately left in place so the
-- admin UI keeps reading the table directly.

COMMENT ON TABLE public.ai_prompt_versions IS
  'Versioned AI prompt overrides. US-2348: writes are service-role only — mutate via /api/admin/grading/prompts, which carries the grading:review scope, the step-up on activate, the audit row and the eval gate. Admins retain SELECT.';

insert into public.applied_migrations (version) values ('00510') on conflict do nothing;
