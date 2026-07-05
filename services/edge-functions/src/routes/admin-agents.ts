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
import { supabaseAdmin } from "../lib/supabase.ts";
import { jsonError } from "../lib/http-errors.ts";
import { requireScope } from "../lib/scope-guard.ts";
import { writeAuditLog } from "../lib/audit-log.ts";
import { approveProposal, expireProposals, rejectProposal } from "../lib/agent-proposals.ts";

type AdminEnv = {
  Variables: { userId: string; adminRole: "admin" | "super_admin" };
};

export const adminAgentsRoutes = new Hono<AdminEnv>();

// Agent proposal execution is operational tooling → ops:write.
adminAgentsRoutes.use("*", requireScope("ops:write"));

// ── Registry + runs (read) ───────────────────────────────────────────────────

adminAgentsRoutes.get("/agents", async (c) => {
  const { data, error } = await supabaseAdmin
    .from("agents")
    .select("*")
    .order("key", { ascending: true });
  if (error) return jsonError(c, 500, "Failed to load agents");
  return c.json({ agents: data ?? [] });
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
