// US-1587: the proposals inbox API — list, approve (execute exactly once),
// reject (reason required). Mounted under /api/admin/agents behind the
// standard admin JWT + RBAC scope; every decision writes an audit-log entry.
//
// Operator surface only: agent_proposals is a SERVICE_ROLE_ONLY table — no
// tenant rows pass through here (payloads/evidence are agent-authored
// aggregates, redacted at write time by the kernel).

import { Hono } from "hono";
import { supabaseAdmin } from "../lib/supabase.ts";
import { jsonError } from "../lib/http-errors.ts";
import { requireScope } from "../lib/scope-guard.ts";
import {
  auditProposalDecision,
  executeProposal,
  expireStaleProposals,
  rejectProposal,
} from "../lib/agent-proposals.ts";

type AdminEnv = {
  Variables: { userId: string; adminRole: "admin" | "super_admin" };
};

export const adminAgentsRoutes = new Hono<AdminEnv>();

adminAgentsRoutes.use("*", requireScope("ops:write"));

// GET /proposals?status=pending&agent=<key> — the inbox. The expiry sweep
// runs first so an executable-looking-but-expired row can never render.
adminAgentsRoutes.get("/proposals", async (c) => {
  await expireStaleProposals().catch(() => {}); // best-effort sweep
  const status = c.req.query("status");
  const agentKey = c.req.query("agent");

  let query = supabaseAdmin
    .from("agent_proposals")
    .select(
      "id, action_class, title, summary, payload, evidence, status, expires_at, " +
        "decided_by, decided_at, decide_reason, executed_at, result, created_at, " +
        "run_id, agents!inner(key, name)",
    )
    .order("created_at", { ascending: false })
    .limit(200);
  if (status) query = query.eq("status", status);
  if (agentKey) query = query.eq("agents.key", agentKey);

  const { data, error } = await query;
  if (error) return jsonError(c, 500, "Failed to load proposals");
  return c.json({ proposals: data ?? [] });
});

// POST /proposals/:id/approve — claim + execute exactly once.
adminAgentsRoutes.post("/proposals/:id/approve", async (c) => {
  const id = c.req.param("id");
  const adminId = c.get("userId");
  const outcome = await executeProposal(id, adminId);

  switch (outcome.kind) {
    case "already_decided":
      return jsonError(c, 409, "Proposal is not pending (already decided or executing)");
    case "expired": {
      await auditProposalDecision(adminId, id, "approved", { outcome: "expired" });
      return jsonError(c, 410, "Proposal expired before execution");
    }
    case "failed": {
      await auditProposalDecision(adminId, id, "approved", {
        outcome: "failed",
        error: outcome.error,
      });
      return c.json({ status: "failed", error: outcome.error }, 502);
    }
    case "executed": {
      await auditProposalDecision(adminId, id, "approved", { outcome: "executed" });
      return c.json({ status: "executed", result: outcome.result });
    }
  }
});

// POST /proposals/:id/reject { reason } — reason is REQUIRED.
adminAgentsRoutes.post("/proposals/:id/reject", async (c) => {
  const id = c.req.param("id");
  const adminId = c.get("userId");
  const body = await c.req.json().catch(() => ({}));
  const reason = typeof body.reason === "string" ? body.reason.trim() : "";
  if (!reason) return jsonError(c, 400, "A rejection reason is required");

  const rejected = await rejectProposal(id, adminId, reason);
  if (!rejected) {
    return jsonError(c, 409, "Proposal is not pending (already decided)");
  }
  await auditProposalDecision(adminId, id, "rejected", { reason });
  return c.json({ status: "rejected" });
});
