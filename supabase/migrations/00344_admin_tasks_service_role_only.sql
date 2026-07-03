-- US-1565: admin task-board tables go service-role only.
--
-- The tasks surface used to read/write admin_task_projects / admin_tasks /
-- admin_task_comments straight from the browser under the admin-role RLS
-- policies below. Every operation now flows through the edge admin boundary
-- (/api/admin/tasks — JWT + role + AAL2 + US-1560 ops:write scope + field
-- whitelists), so the client policies are dropped. RLS stays ENABLED with no
-- policies = deny-all for anon/authenticated; only the service role reaches
-- these tables. Registered in rls-guard_test.ts SERVICE_ROLE_ONLY.
--
-- Idempotent: DROP POLICY IF EXISTS throughout; safe to re-run.

DROP POLICY IF EXISTS "Admins can view task projects" ON public.admin_task_projects;
DROP POLICY IF EXISTS "Admins can create task projects" ON public.admin_task_projects;
DROP POLICY IF EXISTS "Admins can update task projects" ON public.admin_task_projects;
DROP POLICY IF EXISTS "Admins can delete task projects" ON public.admin_task_projects;

DROP POLICY IF EXISTS "Admins can view tasks" ON public.admin_tasks;
DROP POLICY IF EXISTS "Admins can create tasks" ON public.admin_tasks;
DROP POLICY IF EXISTS "Admins can update tasks" ON public.admin_tasks;
DROP POLICY IF EXISTS "Admins can delete tasks" ON public.admin_tasks;

DROP POLICY IF EXISTS "Admins can view task comments" ON public.admin_task_comments;
DROP POLICY IF EXISTS "Admins can create task comments" ON public.admin_task_comments;
DROP POLICY IF EXISTS "Admins can update task comments" ON public.admin_task_comments;
DROP POLICY IF EXISTS "Admins can delete task comments" ON public.admin_task_comments;

-- RLS was enabled by 00047; re-assert defensively (idempotent).
ALTER TABLE public.admin_task_projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.admin_tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.admin_task_comments ENABLE ROW LEVEL SECURITY;

-- US-1108 self-record footer.
INSERT INTO public.applied_migrations (version) VALUES ('00344')
ON CONFLICT (version) DO NOTHING;
