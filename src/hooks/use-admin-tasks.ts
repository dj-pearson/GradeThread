import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { edgeFetch } from "@/lib/edge-fetch";
import type {
  AdminTaskCommentRow,
  AdminTaskInsert,
  AdminTaskProjectInsert,
  AdminTaskProjectRow,
  AdminTaskProjectUpdate,
  AdminTaskRow,
  AdminTaskUpdate,
} from "@/types/database";
import type { ParsedImport } from "@/lib/admin-tasks-import";

// US-1565: every task-board operation flows through /api/admin/tasks (the
// edge admin boundary — JWT + role + AAL2 + ops:write scope + server-side
// field whitelists) instead of direct client Supabase reads/writes. The
// client RLS policies on the three admin_task* tables were dropped in
// migration 00344, so the browser CANNOT reach them anymore — this module is
// the only path. Exported hook API is unchanged from the direct-DB era.

export const TASK_PROJECTS_KEY = ["admin_task_projects"] as const;
export const ALL_TASKS_KEY = ["admin_tasks_all"] as const;
export const projectTasksKey = (projectId: string) =>
  ["admin_tasks", projectId] as const;
export const taskCommentsKey = (taskId: string) =>
  ["admin_task_comments", taskId] as const;
export const COMMENT_COUNTS_KEY = ["admin_task_comment_counts"] as const;

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await edgeFetch(`/api/admin/tasks${path}`, init);
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(
      (json as { error?: string }).error || `Request failed (${res.status})`,
    );
  }
  return json as T;
}

function jsonInit(method: string, body: unknown): RequestInit {
  return {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

// ───────────────────────────────────────────────────────────────────
// QUERIES
// ───────────────────────────────────────────────────────────────────

export function useTaskProjects() {
  return useQuery({
    queryKey: TASK_PROJECTS_KEY,
    staleTime: 30_000,
    queryFn: async (): Promise<AdminTaskProjectRow[]> =>
      (await api<{ projects: AdminTaskProjectRow[] }>("/projects")).projects,
  });
}

// Lightweight fetch of every task — powers the project-list progress bars
// and "Next up" line without a per-project round trip.
export function useAllTasks() {
  return useQuery({
    queryKey: ALL_TASKS_KEY,
    staleTime: 30_000,
    queryFn: async (): Promise<AdminTaskRow[]> =>
      (await api<{ tasks: AdminTaskRow[] }>("/all")).tasks,
  });
}

export function useProjectTasks(projectId: string | undefined) {
  return useQuery({
    queryKey: projectId ? projectTasksKey(projectId) : ["admin_tasks", "none"],
    enabled: !!projectId,
    staleTime: 30_000,
    queryFn: async (): Promise<AdminTaskRow[]> =>
      (await api<{ tasks: AdminTaskRow[] }>(`/projects/${projectId}/tasks`)).tasks,
  });
}

// Comment count per task id — drives the small comment indicator on board
// cards.
export function useTaskCommentCounts(taskIds: string[]) {
  const key = [...taskIds].sort().join(",");
  return useQuery({
    queryKey: [...COMMENT_COUNTS_KEY, key],
    enabled: taskIds.length > 0,
    staleTime: 15_000,
    queryFn: async (): Promise<Record<string, number>> =>
      (await api<{ counts: Record<string, number> }>(
        `/comments/counts?ids=${encodeURIComponent(taskIds.join(","))}`,
      )).counts,
  });
}

export function useTaskComments(taskId: string | undefined) {
  return useQuery({
    queryKey: taskId ? taskCommentsKey(taskId) : ["admin_task_comments", "none"],
    enabled: !!taskId,
    staleTime: 15_000,
    queryFn: async (): Promise<AdminTaskCommentRow[]> =>
      (await api<{ comments: AdminTaskCommentRow[] }>(`/tasks/${taskId}/comments`))
        .comments,
  });
}

// ───────────────────────────────────────────────────────────────────
// PROJECT MUTATIONS
// ───────────────────────────────────────────────────────────────────

export function useCreateProject() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: AdminTaskProjectInsert): Promise<AdminTaskProjectRow> =>
      (await api<{ project: AdminTaskProjectRow }>("/projects", jsonInit("POST", input)))
        .project,
    onSuccess: () => qc.invalidateQueries({ queryKey: TASK_PROJECTS_KEY }),
  });
}

export function useUpdateProject() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({
      id,
      patch,
    }: {
      id: string;
      patch: AdminTaskProjectUpdate;
    }) => {
      await api(`/projects/${id}`, jsonInit("PATCH", patch));
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: TASK_PROJECTS_KEY }),
  });
}

export function useDeleteProject() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      await api(`/projects/${id}`, { method: "DELETE" });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: TASK_PROJECTS_KEY });
      qc.invalidateQueries({ queryKey: ALL_TASKS_KEY });
    },
  });
}

// ───────────────────────────────────────────────────────────────────
// TASK MUTATIONS
// ───────────────────────────────────────────────────────────────────

export function useCreateTask() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: AdminTaskInsert): Promise<AdminTaskRow> =>
      (await api<{ task: AdminTaskRow }>("/tasks", jsonInit("POST", input))).task,
    onSuccess: (row) => {
      qc.invalidateQueries({ queryKey: projectTasksKey(row.project_id) });
      qc.invalidateQueries({ queryKey: ALL_TASKS_KEY });
    },
  });
}

export function useUpdateTask() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({
      id,
      patch,
    }: {
      id: string;
      patch: AdminTaskUpdate;
    }): Promise<AdminTaskRow> =>
      (await api<{ task: AdminTaskRow }>(`/tasks/${id}`, jsonInit("PATCH", patch))).task,
    onSuccess: (row) => {
      qc.invalidateQueries({ queryKey: projectTasksKey(row.project_id) });
      qc.invalidateQueries({ queryKey: ALL_TASKS_KEY });
    },
  });
}

export function useDeleteTask() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id }: { id: string; projectId: string }) => {
      await api(`/tasks/${id}`, { method: "DELETE" });
    },
    onSuccess: (_data, { projectId }) => {
      qc.invalidateQueries({ queryKey: projectTasksKey(projectId) });
      qc.invalidateQueries({ queryKey: ALL_TASKS_KEY });
    },
  });
}

// ───────────────────────────────────────────────────────────────────
// COMMENT MUTATIONS
// ───────────────────────────────────────────────────────────────────

export function useAddComment() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ taskId, body }: { taskId: string; body: string }) => {
      await api(`/tasks/${taskId}/comments`, jsonInit("POST", { body }));
    },
    onSuccess: (_data, { taskId }) => {
      qc.invalidateQueries({ queryKey: taskCommentsKey(taskId) });
      qc.invalidateQueries({ queryKey: COMMENT_COUNTS_KEY });
    },
  });
}

export function useDeleteComment() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id }: { id: string; taskId: string }) => {
      await api(`/comments/${id}`, { method: "DELETE" });
    },
    onSuccess: (_data, { taskId }) => {
      qc.invalidateQueries({ queryKey: taskCommentsKey(taskId) });
      qc.invalidateQueries({ queryKey: COMMENT_COUNTS_KEY });
    },
  });
}

// ───────────────────────────────────────────────────────────────────
// IMPORT
// ───────────────────────────────────────────────────────────────────

// Creates a project (or appends to an existing one) from parsed Markdown.
// The server assigns positions in document order (continuing after the
// existing max when appending) and returns the target project id.
export function useImportMarkdown() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({
      parsed,
      existingProjectId,
    }: {
      parsed: ParsedImport;
      existingProjectId?: string;
    }): Promise<string> =>
      (await api<{ project_id: string }>(
        "/import",
        jsonInit("POST", {
          title: parsed.title,
          description: parsed.description,
          existing_project_id: existingProjectId ?? null,
          tasks: parsed.tasks.map((t) => ({
            title: t.title,
            body: t.body,
            section: t.section,
            status: t.status,
            priority: t.priority,
            due_date: t.due_date,
            completed_at: t.status === "done" ? new Date().toISOString() : null,
          })),
        }),
      )).project_id,
    onSuccess: (projectId) => {
      qc.invalidateQueries({ queryKey: TASK_PROJECTS_KEY });
      qc.invalidateQueries({ queryKey: ALL_TASKS_KEY });
      qc.invalidateQueries({ queryKey: projectTasksKey(projectId) });
    },
  });
}
