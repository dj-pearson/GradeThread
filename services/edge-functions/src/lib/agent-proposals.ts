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
import { redactError } from "./log-redact.ts";
import { emitOpsEvent } from "./ops-events.ts";

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
  const toolName = ACTION_CLASS_TO_TOOL[claimed.action_class] ?? claimed.action_class;
  try {
    const result = await d.runWriteTool(toolName, claimed.payload, { authorizedBy: adminId, proposalId });
    const failed = isToolError(result);
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
