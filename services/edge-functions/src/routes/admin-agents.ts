// US-1657 / AGENTIC-OS Phase 0 (Module E): the operator sign-off surface over
// the proposal lifecycle engine (US-1587). Mounted at /api/admin/agents — JWT +
// admin/AAL2 are inherited from the /api/admin/* group in main.ts; this router
// only adds the ops:write scope guard (agent proposal execution — retry jobs,
// requeue dead letters, file tasks — is an operational action).
//
// Endpoints: list agents, list runs, list proposals (filter by status/agent),
// approve (executes exactly once via the engine), reject (reason required).
// Every decision stamps decided_by server-side from c.get("userId") and writes
// an admin audit-log entry.

import { Hono } from "hono";
import type { Context } from "hono";
import { supabaseAdmin } from "../lib/supabase.ts";
import { jsonError } from "../lib/http-errors.ts";
import { requireScope } from "../lib/scope-guard.ts";
import { writeAuditLog } from "../lib/audit-log.ts";
import { bustSettingCache } from "../lib/system-settings.ts";
import { approveProposal, expireProposals, rejectProposal } from "../lib/agent-proposals.ts";

// The global agents kill-switch key (mirrors AGENTS_PAUSE_SETTING_KEY in
// lib/agent-kernel.ts — kept as a literal here to avoid importing the kernel +
// its Anthropic SDK into the admin route).
const AGENTS_PAUSE_KEY = "agents.pause";
const SPEND_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

type AdminEnv = {
  Variables: { userId: string; adminRole: "admin" | "super_admin" };
};

export const adminAgentsRoutes = new Hono<AdminEnv>();

// Agent proposal execution is operational tooling → ops:write.
adminAgentsRoutes.use("*", requireScope("ops:write"));

// ── Registry + runs (read) ───────────────────────────────────────────────────

adminAgentsRoutes.get("/agents", async (c) => {
  const { data: agents, error } = await supabaseAdmin
    .from("agents")
    .select("*")
    .order("key", { ascending: true });
  if (error) return jsonError(c, 500, "Failed to load agents");
  const list = (agents ?? []) as Array<{ id: string; config?: { budget_usd_daily?: number } }>;
  if (!list.length) return c.json({ agents: [] });

  const sinceIso = new Date(Date.now() - SPEND_WINDOW_MS).toISOString();
  const [runsRes, propsRes] = await Promise.all([
    supabaseAdmin
      .from("agent_runs")
      .select("agent_id, status, cost_usd, started_at, finished_at, outcome")
      .gte("started_at", sinceIso)
      .order("started_at", { ascending: false }),
    supabaseAdmin
      .from("agent_proposals")
      .select("agent_id")
      .eq("status", "pending"),
  ]);

  const spend = new Map<string, number>();
  const lastRun = new Map<string, { status: string; started_at: string | null; finished_at: string | null }>();
  for (const r of (runsRes.data ?? []) as Array<Record<string, unknown>>) {
    const aid = String(r.agent_id);
    spend.set(aid, (spend.get(aid) ?? 0) + (typeof r.cost_usd === "number" ? r.cost_usd : 0));
    if (!lastRun.has(aid)) {
      lastRun.set(aid, {
        status: String(r.status),
        started_at: (r.started_at as string | null) ?? null,
        finished_at: (r.finished_at as string | null) ?? null,
      });
    }
  }
  const pending = new Map<string, number>();
  for (const p of (propsRes.data ?? []) as Array<{ agent_id: string }>) {
    pending.set(p.agent_id, (pending.get(p.agent_id) ?? 0) + 1);
  }

  const enriched = list.map((a) => {
    // US-1591: per-agent daily cap (config, else the conservative default of $2).
    const configured = a.config?.budget_usd_daily;
    const dailyCap = typeof configured === "number" && configured > 0 ? configured : 2;
    return {
      ...a,
      spend_7d_usd: Math.round((spend.get(a.id) ?? 0) * 10000) / 10000,
      pending_proposals: pending.get(a.id) ?? 0,
      daily_cap_usd: dailyCap,
      last_run: lastRun.get(a.id) ?? null,
    };
  });
  return c.json({ agents: enriched });
});

// Per-agent pause / resume (agents.status).
async function setAgentStatus(c: Context<AdminEnv>, status: "enabled" | "paused") {
  const id = c.req.param("id");
  const { data, error } = await supabaseAdmin
    .from("agents")
    .update({ status } as never)
    .eq("id", id)
    .select("id, key, status")
    .maybeSingle();
  if (error) return jsonError(c, 500, "Failed to update agent");
  if (!data) return jsonError(c, 404, "Agent not found");
  await writeAuditLog(c, {
    action: status === "paused" ? "agent.paused" : "agent.resumed",
    targetType: "agent",
    targetId: id,
    details: { status },
  });
  return c.json({ ok: true, agent: data });
}

adminAgentsRoutes.post("/agents/:id/pause", (c) => setAgentStatus(c, "paused"));
adminAgentsRoutes.post("/agents/:id/resume", (c) => setAgentStatus(c, "enabled"));

// Global kill switch (system setting agents.pause). Body: { paused: boolean }.
adminAgentsRoutes.post("/global-pause", async (c) => {
  const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
  if (typeof body.paused !== "boolean") return jsonError(c, 400, "paused (boolean) is required");
  const paused = body.paused;
  const { error } = await supabaseAdmin
    .from("system_settings")
    .upsert({ key: AGENTS_PAUSE_KEY, value: paused, updated_by: c.get("userId") }, { onConflict: "key" });
  if (error) return jsonError(c, 500, "Failed to set global pause");
  bustSettingCache(AGENTS_PAUSE_KEY);
  await writeAuditLog(c, {
    action: paused ? "agent.global_pause" : "agent.global_resume",
    targetType: "system_setting",
    targetId: AGENTS_PAUSE_KEY,
    details: { paused },
  });
  return c.json({ ok: true, paused });
});

// The latest persisted Daily Operator Brief (US-1592) for Mission Control.
adminAgentsRoutes.get("/brief", async (c) => {
  const { data } = await supabaseAdmin
    .from("system_settings")
    .select("value")
    .eq("key", "agents.latest_brief")
    .maybeSingle();
  return c.json({ brief: (data as { value?: unknown } | null)?.value ?? null });
});

// US-1607: per-agent eval pass-rate for the Mission Control panel. Populated by
// the weekly agent-eval cron (agents.eval_results).
adminAgentsRoutes.get("/agent-evals", async (c) => {
  const { data } = await supabaseAdmin
    .from("system_settings")
    .select("value")
    .eq("key", "agents.eval_results")
    .maybeSingle();
  return c.json({ results: (data as { value?: unknown } | null)?.value ?? null });
});

// Current global-pause state (for the console toggle).
adminAgentsRoutes.get("/global-pause", async (c) => {
  const { data } = await supabaseAdmin
    .from("system_settings")
    .select("value")
    .eq("key", AGENTS_PAUSE_KEY)
    .maybeSingle();
  const paused = (data as { value?: unknown } | null)?.value === true;
  return c.json({ paused });
});

adminAgentsRoutes.get("/runs", async (c) => {
  const agentId = c.req.query("agent");
  let q = supabaseAdmin
    .from("agent_runs")
    .select("*")
    .order("started_at", { ascending: false })
    .limit(100);
  if (agentId) q = q.eq("agent_id", agentId);
  const { data, error } = await q;
  if (error) return jsonError(c, 500, "Failed to load runs");
  return c.json({ runs: data ?? [] });
});

// US-1606: an agent's durable memory (strongest first) for the Mission Control
// card. Operator data (agent_memory is deny-all RLS, service-role only).
adminAgentsRoutes.get("/agents/:id/memory", async (c) => {
  const agentId = c.req.param("id");
  const { data, error } = await supabaseAdmin
    .from("agent_memory")
    .select("id, kind, key, content, weight, updated_at")
    .eq("agent_id", agentId)
    .order("weight", { ascending: false })
    .order("updated_at", { ascending: false })
    .limit(100);
  if (error) return jsonError(c, 500, "Failed to load agent memory");
  return c.json({ memory: data ?? [] });
});

// US-1608: an agent's promotion/demotion history (from ops_events) for the
// Mission Control agent card — promotions proposed/applied + policy-breach demotions.
adminAgentsRoutes.get("/agents/:id/autonomy-history", async (c) => {
  const agentKey = c.req.query("key");
  const { data, error } = await supabaseAdmin
    .from("ops_events")
    .select("id, type, severity, title, payload, created_at")
    .in("type", ["agent.autonomy.promotion_proposed", "agent.autonomy.promoted", "agent.policy_breach"])
    .order("created_at", { ascending: false })
    .limit(100);
  if (error) return jsonError(c, 500, "Failed to load autonomy history");
  // Filter to this agent by key from the event payload (events carry agent_key).
  const rows = ((data ?? []) as Array<{ payload?: { agent_key?: string } }>).filter(
    (e) => !agentKey || e.payload?.agent_key === agentKey,
  );
  return c.json({ history: rows });
});

// US-1606: operator delete of a bad memory row (by id).
adminAgentsRoutes.delete("/agents/memory/:memoryId", async (c) => {
  const memoryId = c.req.param("memoryId");
  const { error } = await supabaseAdmin.from("agent_memory").delete().eq("id", memoryId);
  if (error) return jsonError(c, 500, "Failed to delete memory");
  await writeAuditLog(c, {
    action: "agent.memory_deleted",
    targetType: "agent_memory",
    targetId: memoryId,
    details: { memory_id: memoryId },
  });
  return c.json({ ok: true });
});

// US-1589: a run's full ordered transcript for the Mission Control viewer. Step
// input/output were redacted at WRITE time by the kernel (log-redact) — returned
// as-is, never re-redacted.
adminAgentsRoutes.get("/runs/:id", async (c) => {
  const id = c.req.param("id");
  const { data: run } = await supabaseAdmin
    .from("agent_runs")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (!run) return jsonError(c, 404, "Run not found");
  const { data: steps } = await supabaseAdmin
    .from("agent_run_steps")
    .select("*")
    .eq("run_id", id)
    .order("seq", { ascending: true });
  return c.json({ run, steps: steps ?? [] });
});

// ── Proposals (list) ─────────────────────────────────────────────────────────

adminAgentsRoutes.get("/proposals", async (c) => {
  // Lazy expiry so the list reflects TTL without waiting for the sweep.
  await expireProposals().catch(() => {});
  const status = c.req.query("status");
  const agentId = c.req.query("agent");
  let q = supabaseAdmin
    .from("agent_proposals")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(200);
  if (status) q = q.eq("status", status);
  if (agentId) q = q.eq("agent_id", agentId);
  const { data, error } = await q;
  if (error) return jsonError(c, 500, "Failed to load proposals");
  return c.json({ proposals: data ?? [] });
});

// ── Proposals (decisions) ────────────────────────────────────────────────────

adminAgentsRoutes.post("/proposals/:id/approve", async (c) => {
  const id = c.req.param("id");
  // The engine claims pending→approved atomically and executes exactly once.
  const res = await approveProposal(id, c.get("userId"));
  await writeAuditLog(c, {
    action: "agent.proposal_approved",
    targetType: "agent_proposal",
    targetId: id,
    details: { status: res.status ?? null, outcome: res.reason ?? null },
  });
  if (!res.ok) {
    if (res.reason === "not_found") return jsonError(c, 404, "Proposal not found");
    return jsonError(c, 409, res.reason ?? "Cannot approve proposal");
  }
  return c.json({ ok: true, status: res.status, result: res.result });
});

adminAgentsRoutes.post("/proposals/:id/reject", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
  const reason = typeof body.reason === "string" ? body.reason.trim() : "";
  if (!reason) return jsonError(c, 400, "reason is required");
  const res = await rejectProposal(id, c.get("userId"), reason);
  await writeAuditLog(c, {
    action: "agent.proposal_rejected",
    targetType: "agent_proposal",
    targetId: id,
    details: { reason, outcome: res.reason ?? res.status ?? null },
  });
  if (!res.ok) {
    if (res.reason === "not_found") return jsonError(c, 404, "Proposal not found");
    return jsonError(c, 409, res.reason ?? "Cannot reject proposal");
  }
  return c.json({ ok: true, status: res.status });
});
