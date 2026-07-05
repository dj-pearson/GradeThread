// US-1587 / AGENTIC-OS Phase 0 (Module E): the proposal lifecycle ENGINE.
//
// Agent write-actions land as structured proposals (agent_proposals). This
// module owns the lifecycle: persist (from run output, idempotency-deduped),
// approve-once EXECUTE through a registered write tool, reject, and TTL-expire.
// The admin HTTP sign-off surface (list/approve/reject endpoints) is US-1657 —
// it drives these functions.
//
// EXACTLY-ONCE (AC2): approval CLAIMS the row pending→approved via a race-safe
// conditional UPDATE (WHERE status='pending'). Only the winner of that atomic
// claim proceeds to execute, and the write tool runs with the proposal id as
// idempotency key — so a double/concurrent approve can never double-execute.
// Expired/rejected proposals can never execute (the claim only matches pending,
// and approve refuses an expired row).
//
// SECURITY (US-268): agent_proposals is an operator table (deny-all RLS,
// service-role only). Reads/writes are keyed by the proposal id; there is no
// tenant data here.

import type { ProposalDraft } from "./agent-policy.ts";
import { ACTION_CLASS_TO_TOOL, agentToolRegistry } from "./agent-tools.ts";
import { supabaseAdmin } from "./supabase.ts";
import { redact, redactError } from "./log-redact.ts";
import { emitOpsEvent } from "./ops-events.ts";
import { playbookFor } from "../agents/playbooks/index.ts";
import { type PlaybookRunResult, runPlaybook } from "./playbook-executor.ts";
import { writeSystemAuditLog } from "./audit-log.ts";

type ProposalEventSeverity = "info" | "warning" | "critical";

export const DEFAULT_PROPOSAL_TTL_HOURS = 72;

export interface ProposalRow {
  id: string;
  agent_id: string;
  run_id: string | null;
  action_class: string;
  title: string;
  summary: string | null;
  payload: unknown;
  status: string;
  expires_at: string | null;
  idempotency_key: string | null;
  executed_at: string | null;
  result: unknown;
}

// ── Pure helpers ─────────────────────────────────────────────────────────────

export function computeExpiryIso(nowMs: number, ttlHours: number): string {
  const hours = Number.isFinite(ttlHours) && ttlHours > 0 ? ttlHours : DEFAULT_PROPOSAL_TTL_HOURS;
  return new Date(nowMs + hours * 3600_000).toISOString();
}

// A null expiry never expires (an explicitly indefinite proposal).
export function isExpired(expiresAtIso: string | null, nowMs: number): boolean {
  if (!expiresAtIso) return false;
  const t = Date.parse(expiresAtIso);
  return Number.isFinite(t) && t < nowMs;
}

// A proposal may execute only while approved and un-expired.
export function canExecute(status: string, expiresAtIso: string | null, nowMs: number): boolean {
  return status === "approved" && !isExpired(expiresAtIso, nowMs);
}

// A write tool returns { error: … } on a soft failure; detect it as "failed".
function isToolError(result: unknown): boolean {
  return !!result && typeof result === "object" && !Array.isArray(result) &&
    "error" in (result as Record<string, unknown>);
}

// ── Deps seam (DI for tests) ─────────────────────────────────────────────────

export interface ProposalDeps {
  insertProposals: (rows: Record<string, unknown>[]) => Promise<number>;
  loadProposal: (id: string) => Promise<ProposalRow | null>;
  // Race-safe conditional status transition. Updates WHERE id=? AND status=from,
  // returns the updated row if THIS call won the claim, else null.
  claimStatus: (
    id: string,
    from: string,
    to: string,
    patch: Record<string, unknown>,
  ) => Promise<ProposalRow | null>;
  finalizeExecution: (id: string, status: "executed" | "failed", result: unknown) => Promise<void>;
  expirePast: (nowIso: string) => Promise<number>;
  runWriteTool: (
    toolName: string,
    payload: unknown,
    ctx: { authorizedBy: string; proposalId: string },
  ) => Promise<unknown>;
  // US-1605: execute an approved run_playbook proposal step-by-step. Returns the
  // honest partial report; a "failed" status marks the proposal failed.
  runPlaybookProposal: (
    payload: unknown,
    ctx: { authorizedBy: string; proposalId: string; runId: string | null },
  ) => Promise<PlaybookRunResult | { error: { code: string; message: string } }>;
  // US-1608: execute an approved promote_autonomy meta-proposal — flip the
  // agent's autonomy for the target action-class to the proposed level.
  executeAutonomyPromotion: (
    agentId: string,
    payload: unknown,
    authorizedBy: string,
  ) => Promise<{ ok: boolean } | { error: { code: string; message: string } }>;
  // Emit an agent.proposal.* ops event (US-1589). Fire-and-forget.
  emitEvent: (type: string, severity: ProposalEventSeverity, data: Record<string, unknown>) => void;
  now: () => number;
}

export function prodProposalDeps(): ProposalDeps {
  return {
    insertProposals: async (rows) => {
      let inserted = 0;
      for (const row of rows) {
        const { error } = await supabaseAdmin.from("agent_proposals").insert(row as never);
        if (!error) inserted++;
        // 23505 = the UNIQUE(idempotency_key) fired — a re-run's duplicate. No-op.
        else if ((error as { code?: string }).code !== "23505") {
          console.warn(`[agent-proposals] insert failed: ${error.message}`);
        }
      }
      return inserted;
    },
    loadProposal: async (id) => {
      const { data } = await supabaseAdmin
        .from("agent_proposals")
        .select("id, agent_id, run_id, action_class, title, summary, payload, status, expires_at, idempotency_key, executed_at, result")
        .eq("id", id)
        .maybeSingle();
      return (data as ProposalRow | null) ?? null;
    },
    claimStatus: async (id, from, to, patch) => {
      const { data } = await supabaseAdmin
        .from("agent_proposals")
        .update({ status: to, ...patch } as never)
        .eq("id", id)
        .eq("status", from)
        .select("id, agent_id, run_id, action_class, title, summary, payload, status, expires_at, idempotency_key, executed_at, result")
        .maybeSingle();
      return (data as ProposalRow | null) ?? null;
    },
    finalizeExecution: async (id, status, result) => {
      await supabaseAdmin
        .from("agent_proposals")
        .update({ status, result, executed_at: new Date().toISOString() } as never)
        .eq("id", id);
    },
    expirePast: async (nowIso) => {
      const { data } = await supabaseAdmin
        .from("agent_proposals")
        .update({ status: "expired" } as never)
        .eq("status", "pending")
        .lt("expires_at", nowIso)
        .select("id");
      return (data as unknown[] | null)?.length ?? 0;
    },
    runWriteTool: (toolName, payload, ctx) => agentToolRegistry.executeWrite(toolName, payload, ctx),
    runPlaybookProposal: async (payload, ctx) => {
      const key = payload && typeof payload === "object" && !Array.isArray(payload)
        ? (payload as { playbook_key?: unknown }).playbook_key
        : undefined;
      const playbook = typeof key === "string" ? playbookFor(key) : null;
      if (!playbook) return { error: { code: "unknown_playbook", message: `no such playbook: ${String(key)}` } };
      return await runPlaybook(playbook, { authorizedBy: ctx.authorizedBy, proposalId: ctx.proposalId, runId: ctx.runId }, {
        executeWrite: (tool, params, wctx) => agentToolRegistry.executeWrite(tool, params, wctx),
        recordStep: async (row) => {
          await supabaseAdmin.from("agent_run_steps").insert({
            run_id: row.runId,
            seq: row.seq,
            step_type: "tool_call",
            name: row.name,
            input: redact(row.input),
            output: redact(row.output),
            duration_ms: row.durationMs,
          } as never);
        },
        audit: (input) => writeSystemAuditLog(input),
        now: () => Date.now(),
      });
    },
    executeAutonomyPromotion: async (agentId, payload, authorizedBy) => {
      const p = payload && typeof payload === "object" && !Array.isArray(payload) ? payload as Record<string, unknown> : {};
      const cls = typeof p.target_action_class === "string" ? p.target_action_class : null;
      const toLevel = typeof p.to_level === "number" ? p.to_level : null;
      if (!cls || toLevel === null || toLevel < 1 || toLevel > 3) {
        return { error: { code: "invalid_promotion", message: "target_action_class + to_level (1..3) required" } };
      }
      // Re-read current autonomy so a concurrent grant isn't clobbered wholesale.
      const { data: row } = await supabaseAdmin.from("agents").select("key, autonomy").eq("id", agentId).maybeSingle();
      if (!row) return { error: { code: "agent_not_found", message: "agent not found" } };
      const agent = row as { key: string; autonomy: Record<string, unknown> | null };
      const next = { ...(agent.autonomy ?? {}), [cls]: toLevel };
      const { error } = await supabaseAdmin.from("agents").update({ autonomy: next } as never).eq("id", agentId);
      if (error) return { error: { code: "update_failed", message: error.message } };
      await writeSystemAuditLog({
        action: "agent.autonomy.promoted",
        targetType: "agent",
        targetId: agentId,
        details: { agent_key: agent.key, action_class: cls, to_level: toLevel, authorized_by: authorizedBy },
      }).catch(() => {});
      emitOpsEvent("agent.autonomy.promoted", "info", {
        title: `Autonomy promoted: ${agent.key} · ${cls} → L${toLevel}`,
        source: "agent-proposals",
        data: { agent_key: agent.key, action_class: cls, to_level: toLevel },
      });
      return { ok: true };
    },
    emitEvent: (type, severity, data) =>
      emitOpsEvent(type, severity, { title: type, source: "agent-proposals", data }),
    now: () => Date.now(),
  };
}

// ── Persist (from run output) ────────────────────────────────────────────────

// Persist an agent run's proposal drafts as pending agent_proposals with a TTL.
// Idempotency-deduped by idempotency_key (a re-run's same proposal loses on the
// UNIQUE constraint and is a no-op). Returns the number newly filed.
export async function persistProposals(
  agentId: string,
  runId: string | null,
  drafts: ProposalDraft[],
  ttlHours: number = DEFAULT_PROPOSAL_TTL_HOURS,
  deps: Partial<ProposalDeps> = {},
): Promise<number> {
  const d = { ...prodProposalDeps(), ...deps };
  if (!drafts.length) return 0;
  const expiresAt = computeExpiryIso(d.now(), ttlHours);
  const rows = drafts.map((p) => ({
    agent_id: p.agent_id || agentId,
    run_id: runId,
    action_class: p.action_class,
    title: p.title,
    summary: p.summary,
    payload: p.payload ?? {},
    evidence: p.evidence ?? null,
    status: "pending",
    expires_at: expiresAt,
    idempotency_key: p.idempotency_key,
  }));
  return await d.insertProposals(rows);
}

// ── Decisions ────────────────────────────────────────────────────────────────

export interface DecisionResult {
  ok: boolean;
  status?: "executed" | "failed" | "rejected";
  reason?: string;
  result?: unknown;
}

// Approve + execute EXACTLY ONCE. The pending→approved claim is the atomic gate:
// a concurrent/double approve loses the claim and never executes.
export async function approveProposal(
  proposalId: string,
  adminId: string,
  deps: Partial<ProposalDeps> = {},
): Promise<DecisionResult> {
  const d = { ...prodProposalDeps(), ...deps };
  const nowMs = d.now();

  const existing = await d.loadProposal(proposalId);
  if (!existing) return { ok: false, reason: "not_found" };
  if (isExpired(existing.expires_at, nowMs)) {
    // Best-effort latch it to 'expired' so it can't be approved later.
    await d.claimStatus(proposalId, "pending", "expired", {}).catch(() => {});
    return { ok: false, reason: "expired" };
  }
  if (existing.status !== "pending") return { ok: false, reason: `not_pending:${existing.status}` };

  const claimed = await d.claimStatus(proposalId, "pending", "approved", {
    decided_by: adminId,
    decided_at: new Date(nowMs).toISOString(),
  });
  if (!claimed) return { ok: false, reason: "already_decided" };

  d.emitEvent("agent.proposal.approved", "info", {
    proposal_id: proposalId,
    action_class: claimed.action_class,
    decided_by: adminId,
  });

  // Only the claim winner reaches here → execute exactly once.
  try {
    // US-1605 run_playbook executes step-by-step; US-1608 promote_autonomy flips
    // the agent's autonomy; everything else runs a single registered write tool.
    let result: unknown;
    if (claimed.action_class === "run_playbook") {
      result = await d.runPlaybookProposal(claimed.payload, { authorizedBy: adminId, proposalId, runId: claimed.run_id });
    } else if (claimed.action_class === "promote_autonomy") {
      result = await d.executeAutonomyPromotion(claimed.agent_id, claimed.payload, adminId);
    } else {
      result = await d.runWriteTool(ACTION_CLASS_TO_TOOL[claimed.action_class] ?? claimed.action_class, claimed.payload, { authorizedBy: adminId, proposalId });
    }
    const failed = isToolError(result) ||
      (!!result && typeof result === "object" && (result as { status?: unknown }).status === "failed");
    await d.finalizeExecution(proposalId, failed ? "failed" : "executed", result);
    d.emitEvent("agent.proposal.executed", failed ? "warning" : "info", {
      proposal_id: proposalId,
      action_class: claimed.action_class,
      status: failed ? "failed" : "executed",
    });
    return { ok: true, status: failed ? "failed" : "executed", result };
  } catch (err) {
    const result = { error: redactError(err) };
    await d.finalizeExecution(proposalId, "failed", result);
    d.emitEvent("agent.proposal.executed", "warning", {
      proposal_id: proposalId,
      action_class: claimed.action_class,
      status: "failed",
    });
    return { ok: true, status: "failed", result };
  }
}

export async function rejectProposal(
  proposalId: string,
  adminId: string,
  reason: string,
  deps: Partial<ProposalDeps> = {},
): Promise<DecisionResult> {
  const d = { ...prodProposalDeps(), ...deps };
  const claimed = await d.claimStatus(proposalId, "pending", "rejected", {
    decided_by: adminId,
    decided_at: new Date(d.now()).toISOString(),
    decide_reason: reason,
  });
  if (claimed) {
    d.emitEvent("agent.proposal.rejected", "info", {
      proposal_id: proposalId,
      action_class: claimed.action_class,
      decided_by: adminId,
    });
    return { ok: true, status: "rejected" };
  }
  const existing = await d.loadProposal(proposalId);
  if (!existing) return { ok: false, reason: "not_found" };
  return { ok: false, reason: `not_pending:${existing.status}` };
}

// Mark past-TTL pending proposals 'expired'. Wired into the agent tick / a small
// job (US-1588). Returns the number expired.
export async function expireProposals(deps: Partial<ProposalDeps> = {}): Promise<number> {
  const d = { ...prodProposalDeps(), ...deps };
  return await d.expirePast(new Date(d.now()).toISOString());
}
