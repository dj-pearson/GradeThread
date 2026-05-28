-- Admin Task / Project management
-- A lightweight PM surface under /admin/tasks: projects (guides) → tasks
-- (steps) on a kanban board, with per-task comments. Admin-only, gated by
-- the existing public.is_admin() helper (see 00003_admin_tables.sql).

-- ══════════════════════════════════════════════════════════
-- ENUMS
-- ══════════════════════════════════════════════════════════

CREATE TYPE public.admin_task_status AS ENUM ('todo', 'in_progress', 'blocked', 'done');
CREATE TYPE public.admin_task_priority AS ENUM ('low', 'medium', 'high');

-- ══════════════════════════════════════════════════════════
-- TABLES
-- ══════════════════════════════════════════════════════════

-- A project = one guide/initiative (e.g. "iOS Release Setup")
CREATE TABLE public.admin_task_projects (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title       text NOT NULL,
  description text,
  archived    boolean NOT NULL DEFAULT false,
  position    integer NOT NULL DEFAULT 0,
  created_by  uuid REFERENCES public.users(id) ON DELETE SET NULL DEFAULT auth.uid(),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- A task = one checkable step inside a project
CREATE TABLE public.admin_tasks (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id   uuid NOT NULL REFERENCES public.admin_task_projects(id) ON DELETE CASCADE,
  title        text NOT NULL,
  body         text,
  section      text,
  status       public.admin_task_status NOT NULL DEFAULT 'todo',
  priority     public.admin_task_priority NOT NULL DEFAULT 'medium',
  due_date     date,
  position     integer NOT NULL DEFAULT 0,
  created_by   uuid REFERENCES public.users(id) ON DELETE SET NULL DEFAULT auth.uid(),
  completed_at timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

-- A comment = a note left on a task
CREATE TABLE public.admin_task_comments (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id     uuid NOT NULL REFERENCES public.admin_tasks(id) ON DELETE CASCADE,
  author_id   uuid REFERENCES public.users(id) ON DELETE SET NULL DEFAULT auth.uid(),
  body        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- ══════════════════════════════════════════════════════════
-- INDEXES
-- ══════════════════════════════════════════════════════════

CREATE INDEX idx_admin_task_projects_position
  ON public.admin_task_projects(position);
CREATE INDEX idx_admin_tasks_project_id
  ON public.admin_tasks(project_id);
CREATE INDEX idx_admin_tasks_project_status
  ON public.admin_tasks(project_id, status);
CREATE INDEX idx_admin_task_comments_task_id
  ON public.admin_task_comments(task_id);

-- ══════════════════════════════════════════════════════════
-- UPDATED_AT TRIGGERS (reuse existing public.set_updated_at)
-- ══════════════════════════════════════════════════════════

CREATE TRIGGER set_admin_task_projects_updated_at
  BEFORE UPDATE ON public.admin_task_projects
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TRIGGER set_admin_tasks_updated_at
  BEFORE UPDATE ON public.admin_tasks
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ══════════════════════════════════════════════════════════
-- ROW LEVEL SECURITY — admin-only across the board
-- ══════════════════════════════════════════════════════════

ALTER TABLE public.admin_task_projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.admin_tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.admin_task_comments ENABLE ROW LEVEL SECURITY;

-- Projects
CREATE POLICY "Admins can view task projects"
  ON public.admin_task_projects FOR SELECT USING (public.is_admin());
CREATE POLICY "Admins can create task projects"
  ON public.admin_task_projects FOR INSERT WITH CHECK (public.is_admin());
CREATE POLICY "Admins can update task projects"
  ON public.admin_task_projects FOR UPDATE USING (public.is_admin());
CREATE POLICY "Admins can delete task projects"
  ON public.admin_task_projects FOR DELETE USING (public.is_admin());

-- Tasks
CREATE POLICY "Admins can view tasks"
  ON public.admin_tasks FOR SELECT USING (public.is_admin());
CREATE POLICY "Admins can create tasks"
  ON public.admin_tasks FOR INSERT WITH CHECK (public.is_admin());
CREATE POLICY "Admins can update tasks"
  ON public.admin_tasks FOR UPDATE USING (public.is_admin());
CREATE POLICY "Admins can delete tasks"
  ON public.admin_tasks FOR DELETE USING (public.is_admin());

-- Comments
CREATE POLICY "Admins can view task comments"
  ON public.admin_task_comments FOR SELECT USING (public.is_admin());
CREATE POLICY "Admins can create task comments"
  ON public.admin_task_comments FOR INSERT WITH CHECK (public.is_admin());
CREATE POLICY "Admins can update task comments"
  ON public.admin_task_comments FOR UPDATE USING (public.is_admin());
CREATE POLICY "Admins can delete task comments"
  ON public.admin_task_comments FOR DELETE USING (public.is_admin());
