// US-1565: admin task-board CRUD through the edge boundary.
//
// The tasks surface (use-admin-tasks.ts) used to write admin_task_projects /
// admin_tasks / admin_task_comments directly from the browser under
// admin-role RLS policies. Those client policies are DROPPED in migration
// 00344 (deny-all + service-role only, registered in rls-guard_test.ts) and
// every operation now flows through here — JWT + role + AAL2 middleware,
// with per-table FIELD WHITELISTS so a request body can never write columns
// it shouldn't (created_by/author_id are always stamped server-side from the
// authenticated admin, never taken from the body — the operator-table analog
// of tenant scoping; see tenant-isolation_test.ts).

import { Hono } from "hono";
import { supabaseAdmin } from "../lib/supabase.ts";
import { jsonError } from "../lib/http-errors.ts";
import { requireScope } from "../lib/scope-guard.ts";

type AdminEnv = {
  Variables: { userId: string; adminRole: "admin" | "super_admin" };
};

export const adminTasksRoutes = new Hono<AdminEnv>();

// US-1560 taxonomy: the task board is operational tooling → ops:write.
adminTasksRoutes.use("*", requireScope("ops:write"));

const TASK_STATUSES = new Set(["todo", "in_progress", "done"]);
const TASK_PRIORITIES = new Set(["low", "medium", "high", "urgent"]);

// Field whitelists — the only columns a request body may set. Exported for
// the guard tests.
export const PROJECT_FIELDS = new Set([
  "title",
  "description",
  "archived",
  "position",
]);
export const TASK_FIELDS = new Set([
  "project_id",
  "title",
  "body",
  "section",
  "status",
  "priority",
  "due_date",
  "position",
  "completed_at",
]);

/** Keep only whitelisted keys. Exported for unit tests. */
export function pickFields(
  body: Record<string, unknown>,
  allowed: Set<string>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(body)) {
    if (allowed.has(k)) out[k] = v;
  }
  return out;
}

function invalidTaskEnums(patch: Record<string, unknown>): string | null {
  if (patch.status !== undefined && !TASK_STATUSES.has(String(patch.status))) {
    return "invalid status";
  }
  if (
    patch.priority !== undefined && !TASK_PRIORITIES.has(String(patch.priority))
  ) {
    return "invalid priority";
  }
  return null;
}

// ── Projects ─────────────────────────────────────────────────────────

adminTasksRoutes.get("/projects", async (c) => {
  const { data, error } = await supabaseAdmin
    .from("admin_task_projects")
    .select("*")
    .order("position", { ascending: true })
    .order("created_at", { ascending: true });
  if (error) return jsonError(c, 500, "Failed to load projects");
  return c.json({ projects: data ?? [] });
});

adminTasksRoutes.post("/projects", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const insert = pickFields(body, PROJECT_FIELDS);
  if (typeof insert.title !== "string" || !insert.title.trim()) {
    return jsonError(c, 400, "title is required");
  }
  const { data, error } = await supabaseAdmin
    .from("admin_task_projects")
    .insert({ ...insert, created_by: c.get("userId") })
    .select()
    .single();
  if (error) return jsonError(c, 500, "Failed to create project");
  return c.json({ project: data });
});

adminTasksRoutes.patch("/projects/:id", async (c) => {
  const patch = pickFields(await c.req.json().catch(() => ({})), PROJECT_FIELDS);
  if (Object.keys(patch).length === 0) return jsonError(c, 400, "Empty patch");
  const { error } = await supabaseAdmin
    .from("admin_task_projects")
    .update(patch)
    .eq("id", c.req.param("id"));
  if (error) return jsonError(c, 500, "Failed to update project");
  return c.json({ ok: true });
});

adminTasksRoutes.delete("/projects/:id", async (c) => {
  const { error } = await supabaseAdmin
    .from("admin_task_projects")
    .delete()
    .eq("id", c.req.param("id"));
  if (error) return jsonError(c, 500, "Failed to delete project");
  return c.json({ ok: true });
});

// ── Tasks ────────────────────────────────────────────────────────────

// GET /all — every task (project-list progress bars; small operator dataset).
adminTasksRoutes.get("/all", async (c) => {
  const { data, error } = await supabaseAdmin
    .from("admin_tasks")
    .select("*")
    .order("position", { ascending: true });
  if (error) return jsonError(c, 500, "Failed to load tasks");
  return c.json({ tasks: data ?? [] });
});

adminTasksRoutes.get("/projects/:id/tasks", async (c) => {
  const { data, error } = await supabaseAdmin
    .from("admin_tasks")
    .select("*")
    .eq("project_id", c.req.param("id"))
    .order("position", { ascending: true });
  if (error) return jsonError(c, 500, "Failed to load tasks");
  return c.json({ tasks: data ?? [] });
});

adminTasksRoutes.post("/tasks", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const insert = pickFields(body, TASK_FIELDS);
  if (typeof insert.title !== "string" || !insert.title.trim()) {
    return jsonError(c, 400, "title is required");
  }
  if (typeof insert.project_id !== "string" || !insert.project_id) {
    return jsonError(c, 400, "project_id is required");
  }
  const enumErr = invalidTaskEnums(insert);
  if (enumErr) return jsonError(c, 400, enumErr);
  const { data, error } = await supabaseAdmin
    .from("admin_tasks")
    .insert({ ...insert, created_by: c.get("userId") })
    .select()
    .single();
  if (error) return jsonError(c, 500, "Failed to create task");
  return c.json({ task: data });
});

adminTasksRoutes.patch("/tasks/:id", async (c) => {
  const patch = pickFields(await c.req.json().catch(() => ({})), TASK_FIELDS);
  if (Object.keys(patch).length === 0) return jsonError(c, 400, "Empty patch");
  const enumErr = invalidTaskEnums(patch);
  if (enumErr) return jsonError(c, 400, enumErr);
  const { data, error } = await supabaseAdmin
    .from("admin_tasks")
    .update(patch)
    .eq("id", c.req.param("id"))
    .select()
    .single();
  if (error) return jsonError(c, 500, "Failed to update task");
  return c.json({ task: data });
});

adminTasksRoutes.delete("/tasks/:id", async (c) => {
  const { error } = await supabaseAdmin
    .from("admin_tasks")
    .delete()
    .eq("id", c.req.param("id"));
  if (error) return jsonError(c, 500, "Failed to delete task");
  return c.json({ ok: true });
});

// ── Comments ─────────────────────────────────────────────────────────

// GET /comments/counts?ids=a,b,c — per-task comment counts for board badges.
adminTasksRoutes.get("/comments/counts", async (c) => {
  const ids = (c.req.query("ids") ?? "").split(",").map((s) => s.trim())
    .filter(Boolean).slice(0, 500);
  if (ids.length === 0) return c.json({ counts: {} });
  const { data, error } = await supabaseAdmin
    .from("admin_task_comments")
    .select("task_id")
    .in("task_id", ids);
  if (error) return jsonError(c, 500, "Failed to load comment counts");
  const counts: Record<string, number> = {};
  for (const r of (data ?? []) as { task_id: string }[]) {
    counts[r.task_id] = (counts[r.task_id] ?? 0) + 1;
  }
  return c.json({ counts });
});

adminTasksRoutes.get("/tasks/:id/comments", async (c) => {
  const { data, error } = await supabaseAdmin
    .from("admin_task_comments")
    .select("*")
    .eq("task_id", c.req.param("id"))
    .order("created_at", { ascending: true });
  if (error) return jsonError(c, 500, "Failed to load comments");
  return c.json({ comments: data ?? [] });
});

adminTasksRoutes.post("/tasks/:id/comments", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const text = typeof body.body === "string" ? body.body.trim() : "";
  if (!text) return jsonError(c, 400, "body is required");
  const { error } = await supabaseAdmin
    .from("admin_task_comments")
    .insert({
      task_id: c.req.param("id"),
      body: text.slice(0, 5000),
      author_id: c.get("userId"),
    });
  if (error) return jsonError(c, 500, "Failed to add comment");
  return c.json({ ok: true });
});

adminTasksRoutes.delete("/comments/:id", async (c) => {
  const { error } = await supabaseAdmin
    .from("admin_task_comments")
    .delete()
    .eq("id", c.req.param("id"));
  if (error) return jsonError(c, 500, "Failed to delete comment");
  return c.json({ ok: true });
});

// ── Markdown import ──────────────────────────────────────────────────
// POST /import { title?, description?, existing_project_id?, tasks: [...] }
// Creates (or appends to) a project from parsed Markdown; positions continue
// after the current max so document order lands on the board intact.
adminTasksRoutes.post("/import", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const tasks = Array.isArray(body.tasks) ? body.tasks : [];
  let projectId = typeof body.existing_project_id === "string" &&
      body.existing_project_id
    ? body.existing_project_id
    : null;

  if (!projectId) {
    const title = typeof body.title === "string" ? body.title.trim() : "";
    if (!title) return jsonError(c, 400, "title is required for a new project");
    const { data, error } = await supabaseAdmin
      .from("admin_task_projects")
      .insert({
        title,
        description: typeof body.description === "string" ? body.description : null,
        created_by: c.get("userId"),
      })
      .select("id")
      .single();
    if (error || !data) return jsonError(c, 500, "Failed to create project");
    projectId = (data as { id: string }).id;
  }

  let base = 0;
  if (body.existing_project_id) {
    const { data: existing } = await supabaseAdmin
      .from("admin_tasks")
      .select("position")
      .eq("project_id", projectId)
      .order("position", { ascending: false })
      .limit(1);
    base = ((existing?.[0] as { position: number } | undefined)?.position ?? -1) + 1;
  }

  if (tasks.length > 0) {
    const rows = tasks.slice(0, 1000).map(
      (t: Record<string, unknown>, i: number) => {
        const row = pickFields(t, TASK_FIELDS);
        return {
          ...row,
          project_id: projectId,
          position: base + i,
          created_by: c.get("userId"),
        };
      },
    );
    for (const row of rows) {
      const enumErr = invalidTaskEnums(row);
      if (enumErr) return jsonError(c, 400, enumErr);
      if (typeof row.title !== "string" || !(row.title as string).trim()) {
        return jsonError(c, 400, "every task needs a title");
      }
    }
    const { error } = await supabaseAdmin.from("admin_tasks").insert(rows);
    if (error) return jsonError(c, 500, "Failed to import tasks");
  }

  return c.json({ project_id: projectId });
});
