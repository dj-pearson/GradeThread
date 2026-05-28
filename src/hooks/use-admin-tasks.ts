import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
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

export const TASK_PROJECTS_KEY = ["admin_task_projects"] as const;
export const ALL_TASKS_KEY = ["admin_tasks_all"] as const;
export const projectTasksKey = (projectId: string) =>
  ["admin_tasks", projectId] as const;
export const taskCommentsKey = (taskId: string) =>
  ["admin_task_comments", taskId] as const;
export const COMMENT_COUNTS_KEY = ["admin_task_comment_counts"] as const;

// ───────────────────────────────────────────────────────────────────
// QUERIES
// ───────────────────────────────────────────────────────────────────

export function useTaskProjects() {
  return useQuery({
    queryKey: TASK_PROJECTS_KEY,
    staleTime: 30_000,
    queryFn: async (): Promise<AdminTaskProjectRow[]> => {
      const { data, error } = await supabase
        .from("admin_task_projects")
        .select("*")
        .order("position", { ascending: true })
        .order("created_at", { ascending: true });
      if (error) throw error;
      return data ?? [];
    },
  });
}

// Lightweight fetch of every task — powers the project-list progress bars
// and "Next up" line without a per-project round trip.
export function useAllTasks() {
  return useQuery({
    queryKey: ALL_TASKS_KEY,
    staleTime: 30_000,
    queryFn: async (): Promise<AdminTaskRow[]> => {
      const { data, error } = await supabase
        .from("admin_tasks")
        .select("*")
        .order("position", { ascending: true });
      if (error) throw error;
      return data ?? [];
    },
  });
}

export function useProjectTasks(projectId: string | undefined) {
  return useQuery({
    queryKey: projectId ? projectTasksKey(projectId) : ["admin_tasks", "none"],
    enabled: !!projectId,
    staleTime: 30_000,
    queryFn: async (): Promise<AdminTaskRow[]> => {
      const { data, error } = await supabase
        .from("admin_tasks")
        .select("*")
        .eq("project_id", projectId!)
        .order("position", { ascending: true });
      if (error) throw error;
      return data ?? [];
    },
  });
}

// Comment count per task id — drives the small comment indicator on board
// cards. Fetches just the task_id column for the given ids and counts client
// side (PostgREST has no group-by aggregate over arbitrary id lists).
export function useTaskCommentCounts(taskIds: string[]) {
  const key = [...taskIds].sort().join(",");
  return useQuery({
    queryKey: [...COMMENT_COUNTS_KEY, key],
    enabled: taskIds.length > 0,
    staleTime: 15_000,
    queryFn: async (): Promise<Record<string, number>> => {
      const { data, error } = await supabase
        .from("admin_task_comments")
        .select("task_id")
        .in("task_id", taskIds);
      if (error) throw error;
      const counts: Record<string, number> = {};
      for (const r of (data ?? []) as { task_id: string }[]) {
        counts[r.task_id] = (counts[r.task_id] ?? 0) + 1;
      }
      return counts;
    },
  });
}

export function useTaskComments(taskId: string | undefined) {
  return useQuery({
    queryKey: taskId ? taskCommentsKey(taskId) : ["admin_task_comments", "none"],
    enabled: !!taskId,
    staleTime: 15_000,
    queryFn: async (): Promise<AdminTaskCommentRow[]> => {
      const { data, error } = await supabase
        .from("admin_task_comments")
        .select("*")
        .eq("task_id", taskId!)
        .order("created_at", { ascending: true });
      if (error) throw error;
      return data ?? [];
    },
  });
}

// ───────────────────────────────────────────────────────────────────
// PROJECT MUTATIONS
// ───────────────────────────────────────────────────────────────────

export function useCreateProject() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: AdminTaskProjectInsert): Promise<AdminTaskProjectRow> => {
      const { data, error } = await supabase
        .from("admin_task_projects")
        .insert(input as never)
        .select()
        .single();
      if (error) throw error;
      return data as AdminTaskProjectRow;
    },
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
      const { error } = await supabase
        .from("admin_task_projects")
        .update(patch as never)
        .eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: TASK_PROJECTS_KEY }),
  });
}

export function useDeleteProject() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase
        .from("admin_task_projects")
        .delete()
        .eq("id", id);
      if (error) throw error;
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
    mutationFn: async (input: AdminTaskInsert): Promise<AdminTaskRow> => {
      const { data, error } = await supabase
        .from("admin_tasks")
        .insert(input as never)
        .select()
        .single();
      if (error) throw error;
      return data as AdminTaskRow;
    },
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
    }): Promise<AdminTaskRow> => {
      const { data, error } = await supabase
        .from("admin_tasks")
        .update(patch as never)
        .eq("id", id)
        .select()
        .single();
      if (error) throw error;
      return data as AdminTaskRow;
    },
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
      const { error } = await supabase.from("admin_tasks").delete().eq("id", id);
      if (error) throw error;
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
      const { error } = await supabase
        .from("admin_task_comments")
        .insert({ task_id: taskId, body } as never);
      if (error) throw error;
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
      const { error } = await supabase
        .from("admin_task_comments")
        .delete()
        .eq("id", id);
      if (error) throw error;
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
// Tasks are inserted with position = order of appearance so sections + steps
// keep their document order on the board. Returns the target project id.
export function useImportMarkdown() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({
      parsed,
      existingProjectId,
    }: {
      parsed: ParsedImport;
      existingProjectId?: string;
    }): Promise<string> => {
      let projectId = existingProjectId;

      if (!projectId) {
        const { data, error } = await supabase
          .from("admin_task_projects")
          .insert({ title: parsed.title, description: parsed.description } as never)
          .select()
          .single();
        if (error) throw error;
        projectId = (data as AdminTaskProjectRow).id;
      }

      // When appending, start positions after the existing max.
      let base = 0;
      if (existingProjectId) {
        const { data: existing, error: exErr } = await supabase
          .from("admin_tasks")
          .select("position")
          .eq("project_id", existingProjectId)
          .order("position", { ascending: false })
          .limit(1);
        if (exErr) throw exErr;
        const rows = (existing ?? []) as { position: number }[];
        base = (rows[0]?.position ?? -1) + 1;
      }

      if (parsed.tasks.length > 0) {
        const rows: AdminTaskInsert[] = parsed.tasks.map((t, i) => ({
          project_id: projectId!,
          title: t.title,
          body: t.body,
          section: t.section,
          status: t.status,
          priority: t.priority,
          due_date: t.due_date,
          position: base + i,
          completed_at: t.status === "done" ? new Date().toISOString() : null,
        }));
        const { error } = await supabase
          .from("admin_tasks")
          .insert(rows as never);
        if (error) throw error;
      }

      return projectId!;
    },
    onSuccess: (projectId) => {
      qc.invalidateQueries({ queryKey: TASK_PROJECTS_KEY });
      qc.invalidateQueries({ queryKey: ALL_TASKS_KEY });
      qc.invalidateQueries({ queryKey: projectTasksKey(projectId) });
    },
  });
}
