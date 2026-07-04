// US-1587: the proposal lifecycle — agent write-actions land as structured
// proposals; approval executes the payload through a registered WRITE tool
// EXACTLY ONCE; rejection requires a reason; expiry closes the window.
//
// Exactly-once mechanics: the approval CLAIM is a conditional update
// (status pending → approved) — under concurrent double-approval only one
// caller's update matches a row; the loser sees "already decided". The TTL
// is re-checked at claim time so an expired-but-unswept proposal can never
// execute.
//
// Write tools are a SEPARATE registry from the read tools (US-1585): they
// are never exposed to the model's tool list, and each handler REFUSES to
// run without an execution context (an approved proposal id) — hands only
// through sign-off until L2+ direct execution arrives (US-1608 promotes,
// this file executes).

import { supabaseAdmin } from "./supabase.ts";
import { redact, redactError } from "./log-redact.ts";
import { writeSystemAuditLog } from "./audit-log.ts";
import { routeOpsEventToAdmins } from "./admin-notifications.ts";
import { dispatchWriteIntent, type PolicyAgent } from "./agent-policy.ts";

// ── Write tools (class 'write', reversible by design) ───────────────────────

export interface WriteToolContext {
  /** The approved proposal this execution is authorized by. REQUIRED. */
  proposalId: string;
  agentKey: string;
}

export interface WriteTool {
  name: string;
  description: string;
  class: "write";
  run(
    args: Record<string, unknown>,
    ctx: WriteToolContext,
    db: WriteDb,
  ): Promise<unknown>;
}

/** Narrow injectable surface (tests fake it). */
// deno-lint-ignore no-explicit-any
export type WriteDb = any;

const JOB_SLUG = /^[a-z0-9-]{2,64}$/;

async function selfJobPost(job: string): Promise<{ status: number; body: string }> {
  const secret = Deno.env.get("FLIPDESK_INTERNAL_JOB_SECRET") ?? "";
  if (!secret) throw new Error("FLIPDESK_INTERNAL_JOB_SECRET is not configured");
  const base = Deno.env.get("EDGE_SELF_URL") ??
    `http://127.0.0.1:${Deno.env.get("PORT") ?? "8787"}`;
  const res = await fetch(`${base}/api/jobs/${job}`, {
    method: "POST",
    headers: { "X-Internal-Job-Secret": secret },
  });
  const body = (await res.text()).slice(0, 500);
  return { status: res.status, body: redact(body) };
}

export const WRITE_TOOLS: Record<string, WriteTool> = {
  retry_job: {
    name: "retry_job",
    description:
      "Re-POST a registered /api/jobs/* endpoint via the internal job secret. Reversible: jobs are idempotent by contract.",
    class: "write",
    async run(args, ctx) {
      requireContext(ctx);
      const job = String(args.job ?? "");
      if (!JOB_SLUG.test(job)) {
        throw new Error(`invalid job slug '${job}'`);
      }
      const { status, body } = await selfJobPost(job);
      if (status >= 400) throw new Error(`job '${job}' returned HTTP ${status}: ${body}`);
      return { job, status, body };
    },
  },

  requeue_dead_letter: {
    name: "requeue_dead_letter",
    description:
      "Push a dead-lettered webhook back to pending so the existing replay machinery re-processes it. Reversible: a re-failure dead-letters again.",
    class: "write",
    async run(args, ctx, db) {
      requireContext(ctx);
      const id = String(args.id ?? "");
      if (!id) throw new Error("dead-letter id is required");
      const { data, error } = await db
        .from("webhook_dead_letters")
        .update({ status: "pending" })
        .eq("id", id)
        .in("status", ["unresolved", "dead_letter"])
        .select("id")
        .maybeSingle();
      if (error) throw new Error(error.message);
      if (!data) throw new Error(`dead letter ${id} not found or already handled`);
      return { requeued: id };
    },
  },

  create_admin_task: {
    name: "create_admin_task",
    description:
      "File a card on the admin task board. Reversible: tasks can be archived.",
    class: "write",
    async run(args, ctx, db) {
      requireContext(ctx);
      const title = String(args.title ?? "").trim();
      if (!title) throw new Error("title is required");
      const projectId = String(args.project_id ?? "");
      if (!projectId) throw new Error("project_id is required");
      const attribution = `

— filed by agent '${ctx.agentKey}' via proposal ${ctx.proposalId}`;
      const body = (typeof args.body === "string" ? args.body.slice(0, 4000) : "") +
        attribution;
      const { data, error } = await db
        .from("admin_tasks")
        .insert({
          project_id: projectId,
          title: title.slice(0, 200),
          body,
          status: "todo",
          created_by: null, // agent-filed; attribution lives in the body
        })
        .select("id")
        .single();
      if (error) throw new Error(error.message);
      return { taskId: (data as { id: string }).id };
    },
  },
};

function requireContext(ctx: WriteToolContext | undefined): void {
  if (!ctx || !ctx.proposalId) {
    // The whole point: no approved proposal, no hands.
    throw new Error("write tools require an approved-proposal execution context");
  }
}

// ── The lifecycle ────────────────────────────────────────────────────────────

export interface ProposalDb {
  /** Conditional claim: pending → approved. Null = not claimable. */
  claimForExecution(
    id: string,
    adminId: string,
    nowIso: string,
  ): Promise<Record<string, unknown> | null>;
  markExecuted(
    id: string,
    status: "executed" | "failed" | "expired",
    result: Record<string, unknown> | null,
    nowIso: string,
  ): Promise<void>;
  rejectPending(
    id: string,
    adminId: string,
    reason: string,
    nowIso: string,
  ): Promise<boolean>;
  expirePending(nowIso: string): Promise<number>;
}

const defaultDb: ProposalDb = {
  async claimForExecution(id, adminId, nowIso) {
    const { data, error } = await supabaseAdmin
      .from("agent_proposals")
      .update({ status: "approved", decided_by: adminId, decided_at: nowIso })
      .eq("id", id)
      .eq("status", "pending")
      .select("id, action_class, payload, expires_at, agent_id, agents(key)")
      .maybeSingle();
    if (error) throw new Error(error.message);
    return (data as Record<string, unknown> | null) ?? null;
  },
  async markExecuted(id, status, result, nowIso) {
    const { error } = await supabaseAdmin
      .from("agent_proposals")
      .update({
        status,
        result,
        ...(status === "executed" || status === "failed"
          ? { executed_at: nowIso }
          : {}),
      })
      .eq("id", id);
    if (error) throw new Error(error.message);
  },
  async rejectPending(id, adminId, reason, nowIso) {
    const { data, error } = await supabaseAdmin
      .from("agent_proposals")
      .update({
        status: "rejected",
        decided_by: adminId,
        decided_at: nowIso,
        decide_reason: reason,
      })
      .eq("id", id)
      .eq("status", "pending")
      .select("id")
      .maybeSingle();
    if (error) throw new Error(error.message);
    return data != null;
  },
  async expirePending(nowIso) {
    const { data, error } = await supabaseAdmin
      .from("agent_proposals")
      .update({ status: "expired" })
      .eq("status", "pending")
      .lt("expires_at", nowIso)
      .select("id");
    if (error) throw new Error(error.message);
    return (data ?? []).length;
  },
};

export type ExecuteOutcome =
  | { kind: "executed"; result: unknown }
  | { kind: "failed"; error: string }
  | { kind: "already_decided" }
  | { kind: "expired" };

/**
 * Approve + execute exactly once. The conditional claim is the concurrency
 * guard; the TTL re-check means an expired proposal can never execute even
 * if the sweep hasn't run yet.
 */
export async function executeProposal(
  proposalId: string,
  adminId: string,
  db: ProposalDb = defaultDb,
  writeDb: WriteDb = supabaseAdmin,
  now: () => Date = () => new Date(),
): Promise<ExecuteOutcome> {
  const nowIso = now().toISOString();
  const claimed = await db.claimForExecution(proposalId, adminId, nowIso);
  if (!claimed) return { kind: "already_decided" };

  const expiresAt = claimed.expires_at as string | null;
  if (expiresAt && expiresAt < nowIso) {
    await db.markExecuted(proposalId, "expired", null, nowIso);
    return { kind: "expired" };
  }

  const payload = (claimed.payload ?? {}) as Record<string, unknown>;
  const toolName = String(payload.tool ?? "");
  const args = (payload.args ?? {}) as Record<string, unknown>;
  const agentKey = String(
    (claimed.agents as { key?: string } | null)?.key ?? "unknown",
  );
  const tool = WRITE_TOOLS[toolName];
  if (!tool) {
    const error = `unknown write tool '${toolName}'`;
    await db.markExecuted(proposalId, "failed", { error }, nowIso);
    return { kind: "failed", error };
  }

  try {
    const result = await tool.run(args, { proposalId, agentKey }, writeDb);
    await db.markExecuted(
      proposalId,
      "executed",
      { ok: true, result },
      now().toISOString(),
    );
    return { kind: "executed", result };
  } catch (err) {
    const error = redactError(err);
    await db.markExecuted(proposalId, "failed", { error }, now().toISOString());
    return { kind: "failed", error };
  }
}

export async function rejectProposal(
  proposalId: string,
  adminId: string,
  reason: string,
  db: ProposalDb = defaultDb,
  now: () => Date = () => new Date(),
): Promise<boolean> {
  return await db.rejectPending(proposalId, adminId, reason, now().toISOString());
}

/** Sweep: past-TTL pending proposals become expired (idempotent). */
export async function expireStaleProposals(
  db: ProposalDb = defaultDb,
  now: () => Date = () => new Date(),
): Promise<number> {
  return await db.expirePending(now().toISOString());
}

// ── Filing from a run (the kernel calls this) ────────────────────────────────

export interface RunProposal {
  action_class?: unknown;
  title?: unknown;
  summary?: unknown;
  payload?: unknown;
  evidence?: unknown;
}

export const DEFAULT_PROPOSAL_TTL_HOURS = 72;

/**
 * File the proposals from a succeeded run's output through the policy
 * engine (per-class autonomy applies to EACH). Malformed entries are
 * skipped, filed count returns for the run outcome, and ONE batched admin
 * notification covers the whole run.
 */
export async function fileProposalsFromRun(
  agent: PolicyAgent,
  runId: string,
  proposals: unknown[],
  config: Record<string, unknown>,
  deps: {
    dispatch?: typeof dispatchWriteIntent;
    notify?: typeof routeOpsEventToAdmins;
    now?: () => Date;
  } = {},
): Promise<{ filed: number; dropped: number; skipped: number }> {
  const dispatch = deps.dispatch ?? dispatchWriteIntent;
  const notify = deps.notify ?? routeOpsEventToAdmins;
  const nowFn = deps.now ?? (() => new Date());
  const ttlHours = typeof config.proposal_ttl_hours === "number" &&
      config.proposal_ttl_hours > 0
    ? Math.min(config.proposal_ttl_hours, 24 * 30)
    : DEFAULT_PROPOSAL_TTL_HOURS;
  const expiresAt = new Date(nowFn().getTime() + ttlHours * 3_600_000)
    .toISOString();

  let filed = 0;
  let dropped = 0;
  let skipped = 0;
  for (const raw of proposals) {
    const p = raw as RunProposal;
    if (
      typeof p?.action_class !== "string" || typeof p?.title !== "string" ||
      typeof p?.summary !== "string"
    ) {
      skipped += 1;
      continue;
    }
    const outcome = await dispatch(agent, {
      actionClass: p.action_class,
      title: p.title.slice(0, 200),
      summary: p.summary.slice(0, 2000),
      payload: (p.payload ?? {}) as Record<string, unknown>,
      evidence: (p.evidence ?? {}) as Record<string, unknown>,
      runId,
      expiresAt,
    });
    if (outcome.kind === "proposed") filed += 1;
    else dropped += 1; // L0 suppression or a halt
  }

  if (filed > 0) {
    // Batched per run: one notification no matter how many proposals.
    try {
      await notify({
        type: "agent_proposals_pending",
        severity: "warning",
        title:
          `Agent '${agent.key}' filed ${filed} proposal${filed === 1 ? "" : "s"} awaiting review`,
        link: "/admin/agents?tab=proposals",
        opsEventId: null,
      });
    } catch {
      // Notification is best-effort; the inbox is the source of truth.
    }
  }
  return { filed, dropped, skipped };
}

/** Audit helper shared by the admin routes. */
export async function auditProposalDecision(
  adminId: string,
  proposalId: string,
  decision: "approved" | "rejected",
  extra: Record<string, unknown> = {},
): Promise<void> {
  try {
    await writeSystemAuditLog({
      action: `agent_proposal_${decision}`,
      targetType: "agent_proposal",
      targetId: proposalId,
      details: { admin: adminId, ...extra },
    });
  } catch {
    // Best-effort.
  }
}
