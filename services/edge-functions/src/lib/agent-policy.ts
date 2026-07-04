// US-1586: the policy engine — every agent capability is gated by a
// per-(agent, action-class) autonomy level, granted in small reversible
// increments and revoked instantly.
//
// The ladder:
//   L0 observe  — a write intent is DROPPED and recorded as a finding
//                 ("would have proposed X"); the agent can only look.
//   L1 propose  — the intent becomes a pending agent_proposals row for a
//                 human decision.
//   L2 act+log  — eligible for direct execution with an audit trail.
//   L3 act      — direct execution, brief-level reporting only.
//   Until the execution path lands (US-1587), L2/L3 DOWNGRADE to a proposal
//   with an explicit note — autonomy is never exercised before the rails
//   that audit it exist.
//
// Kill switches, both FAIL-CLOSED and checked at run start AND at every
// write dispatch:
//   - global: system setting agents.pause = true halts all runs + executions;
//   - per-agent: agents.status = 'paused'.

import { supabaseAdmin } from "./supabase.ts";
import { emitOpsEvent } from "./ops-events.ts";
import { redact } from "./log-redact.ts";

// ── Action classes (extensible — add here, never inline strings) ────────────

export const ACTION_CLASSES = [
  "file_task", // create an admin task-board card
  "retry_job", // re-run a failed cron/job
  "requeue_dead_letter", // push a dead-lettered event back through
  "draft_reply", // draft (never send) a support reply
  "adjust_queue", // reorder/prioritize a work queue
  "run_playbook", // execute a declarative remediation (US-1605)
  "notify", // send an operator notification beyond the run record
  "config_write", // change agent/system configuration
] as const;

export type ActionClass = (typeof ACTION_CLASSES)[number];

export function isActionClass(v: unknown): v is ActionClass {
  return typeof v === "string" && (ACTION_CLASSES as readonly string[]).includes(v);
}

// ── Autonomy resolution ──────────────────────────────────────────────────────

export type AutonomyLevel = 0 | 1 | 2 | 3;

export interface PolicyAgent {
  id: string;
  key: string;
  status: string;
  autonomy: Record<string, unknown> | null;
}

/**
 * Resolve the autonomy level for one (agent, action class). agents.autonomy
 * stores either numbers (2) or level strings ("L2"); anything unknown —
 * missing class, malformed value, unregistered class name — defaults to L0.
 * New capabilities are ALWAYS born observe-only.
 */
export function resolveAutonomy(
  agent: Pick<PolicyAgent, "autonomy">,
  actionClass: string,
): AutonomyLevel {
  const raw = agent.autonomy?.[actionClass];
  if (typeof raw === "number" && Number.isInteger(raw) && raw >= 0 && raw <= 3) {
    return raw as AutonomyLevel;
  }
  if (typeof raw === "string") {
    const m = raw.trim().toUpperCase().match(/^L?([0-3])$/);
    if (m) return Number(m[1]) as AutonomyLevel;
  }
  return 0;
}

// ── Kill switches (fail-closed) ──────────────────────────────────────────────

/**
 * Global halt: agents.pause = true stops all runs AND all executions. A read
 * ERROR halts too (fail-closed); a missing row means "not paused" — the
 * switch exists to stop the fleet, not to require ceremony before run one.
 */
export async function isGlobalAgentPause(
  db: PolicyDb = defaultDb,
): Promise<boolean> {
  try {
    const value = await db.readSetting("agents.pause");
    if (value === undefined) return false; // switch not configured
    return value === true || value === "true" ||
      (typeof value === "object" && value !== null &&
        (value as Record<string, unknown>).enabled === true);
  } catch {
    return true; // fail-closed
  }
}

/** The combined halt check used at run start and at every write dispatch. */
export async function isExecutionHalted(
  agent: Pick<PolicyAgent, "status">,
  db: PolicyDb = defaultDb,
): Promise<boolean> {
  if (agent.status === "paused") return true;
  return await isGlobalAgentPause(db);
}

// ── Write-intent dispatch ────────────────────────────────────────────────────

export interface WriteIntent {
  actionClass: string;
  title: string;
  summary: string;
  /** What execution needs: tool name + args (US-1587 consumes this). */
  payload: Record<string, unknown>;
  /** Why the operator should believe it. */
  evidence?: Record<string, unknown>;
  /** Cross-run dedup key; defaults to agent+class+title. */
  idempotencyKey?: string;
  runId?: string | null;
}

export type DispatchOutcome =
  | { kind: "dropped"; finding: Record<string, unknown> }
  | { kind: "proposed"; proposalId: string | null; downgraded: boolean }
  | { kind: "halted" };

export interface PolicyDb {
  readSetting(key: string): Promise<unknown>; // undefined = row absent
  upsertProposal(row: Record<string, unknown>): Promise<string | null>;
  persistAutonomy(agentId: string, autonomy: Record<string, unknown>): Promise<void>;
}

const defaultDb: PolicyDb = {
  async readSetting(key) {
    const { data, error } = await supabaseAdmin
      .from("system_settings")
      .select("value")
      .eq("key", key)
      .maybeSingle();
    if (error) throw new Error(error.message);
    return data ? (data as { value: unknown }).value : undefined;
  },
  async upsertProposal(row) {
    const { data, error } = await supabaseAdmin
      .from("agent_proposals")
      .upsert(row, { onConflict: "idempotency_key" })
      .select("id")
      .maybeSingle();
    if (error) throw new Error(`proposal upsert failed: ${error.message}`);
    return data ? (data as { id: string }).id : null;
  },
  async persistAutonomy(agentId, autonomy) {
    const { error } = await supabaseAdmin
      .from("agents")
      .update({ autonomy })
      .eq("id", agentId);
    if (error) throw new Error(`autonomy update failed: ${error.message}`);
  },
};

/**
 * Dispatch a write intent by the agent's autonomy for its action class.
 * The halt switches are re-checked HERE (not only at run start) so a
 * mid-run pause takes effect before the next write, fail-closed.
 */
export async function dispatchWriteIntent(
  agent: PolicyAgent,
  intent: WriteIntent,
  db: PolicyDb = defaultDb,
): Promise<DispatchOutcome> {
  if (await isExecutionHalted(agent, db)) {
    return { kind: "halted" };
  }

  const level = resolveAutonomy(agent, intent.actionClass);

  if (level === 0) {
    // Observe-only: record what WOULD have happened — that trail is how an
    // agent earns promotion (US-1608).
    return {
      kind: "dropped",
      finding: {
        kind: "suppressed_write_intent",
        note: `would have proposed: ${intent.title}`,
        action_class: intent.actionClass,
        summary: intent.summary,
      },
    };
  }

  // L1 proposes; L2/L3 downgrade to a proposal until US-1587's execution
  // path exists — with the downgrade stated in the evidence.
  const downgraded = level >= 2;
  const idempotencyKey = intent.idempotencyKey ??
    `${agent.key}:${intent.actionClass}:${intent.title}`.slice(0, 200);
  const proposalId = await db.upsertProposal({
    agent_id: agent.id,
    run_id: intent.runId ?? null,
    action_class: intent.actionClass,
    title: intent.title,
    summary: intent.summary,
    payload: intent.payload,
    evidence: {
      ...(intent.evidence ?? {}),
      ...(downgraded
        ? {
          autonomy_note:
            `agent holds L${level} for '${intent.actionClass}' but direct ` +
            `execution is not yet wired (US-1587) — downgraded to proposal`,
        }
        : {}),
    },
    status: "pending",
    idempotency_key: idempotencyKey,
  });
  return { kind: "proposed", proposalId, downgraded };
}

// ── Policy breaches ──────────────────────────────────────────────────────────

/**
 * A breach (a tool misuse, an execution that violated its charter, an eval
 * regression) demotes that (agent, class) ONE level — floored at L0 — and
 * emits a warning ops event. Trust is lost faster than it is earned.
 */
export async function recordPolicyBreach(
  agent: PolicyAgent,
  actionClass: string,
  reason: string,
  db: PolicyDb = defaultDb,
  emit: typeof emitOpsEvent = emitOpsEvent,
): Promise<AutonomyLevel> {
  const current = resolveAutonomy(agent, actionClass);
  const demoted = Math.max(0, current - 1) as AutonomyLevel;
  const autonomy = { ...(agent.autonomy ?? {}), [actionClass]: demoted };
  await db.persistAutonomy(agent.id, autonomy);
  await emit("agent_policy_breach", "warning", {
    title:
      `Agent '${agent.key}' demoted to L${demoted} for '${actionClass}': ` +
      redact(reason).slice(0, 200),
    source: "agent-policy",
    data: { agent: agent.key, action_class: actionClass, from: current, to: demoted },
  });
  return demoted;
}
