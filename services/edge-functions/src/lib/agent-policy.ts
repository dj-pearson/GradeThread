// US-1586 / AGENTIC-OS Phase 0 (Module D): the policy engine — the spine of the
// whole OS (vault/70-agent/agentic-os-map.md §2 autonomy ladder, §3.D).
//
// Every agent capability is gated by a per-(agent, action-class) autonomy LEVEL
// (L0 observe → L3 act-silent), granted in small reversible increments and
// revocable instantly by two kill switches (global agents.pause + per-agent
// agents.status). This module owns:
//   • the action-class taxonomy + resolveAutonomy (pure ladder read, default L0),
//   • dispatchWriteIntent — how a would-be write is handled at each level,
//   • applyWritePolicy — the kernel post-run hook that routes an agent's
//     emitted proposals by level (L0 → finding, L1+ → proposal),
//   • recordPolicyBreach — one-level demotion (floored at L0) + warning event.
//
// Promotion automation is US-1608; the write-EXECUTION path is US-1587 (until
// then L2/L3 downgrade to a proposal with a note). This story is
// resolution / demotion / kill only.

import type { AgentRow } from "./agent-kernel.ts";
import { supabaseAdmin } from "./supabase.ts";
import { emitOpsEvent } from "./ops-events.ts";
import { captureException } from "./observability.ts";
import { redact } from "./log-redact.ts";

// ── Action-class taxonomy (extensible) ───────────────────────────────────────

// The known write action classes. resolveAutonomy accepts ANY string (autonomy
// is granted per class), so a new module can introduce a class without editing
// this list — this constant is the documented/registered set for tooling + UI.
export const ACTION_CLASSES = [
  "file_task",
  "retry_job",
  "requeue_dead_letter",
  "draft_reply",
  "adjust_queue",
  "run_playbook",
  // US-1597 (Module T) account-level actions — HARD-CAPPED at L1 (see below).
  "suspend_account",
  "require_step_up",
  "deny_claim",
  // US-1608 meta-proposal: approving flips an agent's autonomy for a class.
  "promote_autonomy",
  // US-1610 Release agent: run an active smoke check.
  "run_smoke",
  // US-1595 Support Triage: persist a batch of ticket classifications onto the
  // ticket rows the support UI renders (draft_reply already exists above).
  "triage_tickets",
  // US-1599 Marketing Portfolio: add a topic to a topic bank; adjust the shared
  // marketing frequency cap. Engine-level levers only (never a send/subscriber).
  "add_marketing_topic",
  "adjust_frequency",
  // US-1600 User Lifecycle: enrol a DEFINED cohort in an existing drip campaign
  // (the drip engine + frequency caps still own delivery; never a direct send).
  "enroll_cohort",
] as const;
export type KnownActionClass = typeof ACTION_CLASSES[number];

export function isKnownActionClass(v: string): v is KnownActionClass {
  return (ACTION_CLASSES as readonly string[]).includes(v);
}

// ── Permanent per-(agent, action-class) autonomy hard caps ───────────────────
//
// A PERMANENT design decision, NOT a tunable (vault/70-agent/agentic-os-map.md §2 ladder note): the
// Trust & Safety agent's account-level actions can never exceed L1 (a human
// always approves a suspension / step-up / claim denial), regardless of what the
// agents.autonomy config or any future promotion grants. resolveAutonomy clamps
// to this cap — so even a hand-edited autonomy row of L3 resolves to L1.
export const AUTONOMY_HARD_CAPS: Record<string, Record<string, AutonomyLevel>> = {
  "trust-safety": {
    suspend_account: 1,
    require_step_up: 1,
    deny_claim: 1,
  },
};

// ── The autonomy ladder ──────────────────────────────────────────────────────

export type AutonomyLevel = 0 | 1 | 2 | 3;

// Read the (agent, action-class) autonomy level from agents.autonomy, defaulting
// to L0 (observe) for any class not explicitly granted. Pure; clamps to 0..3.
export function resolveAutonomy(agent: AgentRow, actionClass: string): AutonomyLevel {
  const raw = (agent.autonomy ?? {})[actionClass];
  const n = typeof raw === "number" ? raw : Number(raw);
  let level: AutonomyLevel;
  if (!Number.isFinite(n) || n <= 0) level = 0;
  else if (n >= 3) level = 3;
  else level = Math.floor(n) as AutonomyLevel;
  // Permanent hard cap (US-1597): clamp regardless of what the config granted.
  const cap = AUTONOMY_HARD_CAPS[agent.key]?.[actionClass];
  return cap !== undefined && level > cap ? cap : level;
}

// ── Write-intent dispatch ────────────────────────────────────────────────────

export interface WriteIntent {
  actionClass: string;
  title: string;
  summary?: string | null;
  payload?: unknown;
  evidence?: unknown;
  idempotencyKey?: string | null;
}

// Shape mirrors agent_proposals (US-1583); persisted by US-1587's lifecycle.
export interface ProposalDraft {
  agent_id: string;
  action_class: string;
  title: string;
  summary: string | null;
  payload: unknown;
  evidence: unknown;
  status: "pending";
  idempotency_key: string | null;
  // Policy annotation so the lifecycle/UI can show HOW it was routed.
  policy: { level: AutonomyLevel; note: string | null; would_execute: boolean };
}

export interface WouldProposeFinding {
  type: "would_propose";
  action_class: string;
  title: string;
  summary: string | null;
  reason: string; // "L0_observe" | "paused"
}

export type DispatchResult =
  | { disposition: "dropped"; level: AutonomyLevel; finding: WouldProposeFinding; note: string | null }
  | { disposition: "proposal"; level: AutonomyLevel; proposal: ProposalDraft; note: string | null };

// Decide how a write intent is handled given the agent's level for that class
// and the current pause state (pure). Kill switches take PRECEDENCE over level:
// a paused agent's write is always dropped, regardless of L2/L3.
//   • paused (global OR agent) → dropped, recorded as a "would_propose" finding
//   • L0 → dropped as a finding ("would have proposed X")
//   • L1 → a pending proposal
//   • L2/L3 → a pending proposal WITH a note (auto-execution deferred to US-1587)
export function dispatchWriteIntent(
  agent: AgentRow,
  intent: WriteIntent,
  ctx: { paused: boolean },
): DispatchResult {
  const level = resolveAutonomy(agent, intent.actionClass);
  const paused = ctx.paused || agent.status !== "enabled";

  if (paused) {
    return {
      disposition: "dropped",
      level,
      note: "paused",
      finding: wouldPropose(intent, "paused"),
    };
  }
  if (level === 0) {
    return {
      disposition: "dropped",
      level,
      note: null,
      finding: wouldPropose(intent, "L0_observe"),
    };
  }
  const note = level >= 2 ? "auto-execution deferred to US-1587; downgraded to proposal" : null;
  return {
    disposition: "proposal",
    level,
    note,
    proposal: {
      agent_id: agent.id,
      action_class: intent.actionClass,
      title: intent.title,
      summary: intent.summary ?? null,
      payload: intent.payload ?? {},
      evidence: intent.evidence ?? null,
      status: "pending",
      idempotency_key: intent.idempotencyKey ?? null,
      policy: { level, note, would_execute: level >= 2 },
    },
  };
}

function wouldPropose(intent: WriteIntent, reason: string): WouldProposeFinding {
  return {
    type: "would_propose",
    action_class: intent.actionClass,
    title: intent.title,
    summary: intent.summary ?? null,
    reason,
  };
}

// Coerce a raw model-emitted proposal into a WriteIntent. Returns null if it
// lacks the minimum required fields (action_class + title).
export function coerceWriteIntent(raw: unknown): WriteIntent | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const actionClass = o.action_class ?? o.actionClass;
  const title = o.title;
  if (typeof actionClass !== "string" || !actionClass) return null;
  if (typeof title !== "string" || !title) return null;
  return {
    actionClass,
    title,
    summary: typeof o.summary === "string" ? o.summary : null,
    payload: o.payload ?? {},
    evidence: o.evidence ?? null,
    idempotencyKey: typeof o.idempotency_key === "string" ? o.idempotency_key : null,
  };
}

// The kernel post-run hook (AC2): route an agent's emitted proposals by level.
// L0/paused proposals become "would_propose" findings; L1+ become pending
// proposal drafts. Invalid raw proposals are surfaced as findings, never
// silently dropped. Pure.
export function applyWritePolicy(
  agent: AgentRow,
  outcome: { findings: unknown[]; proposals: unknown[] },
  ctx: { paused: boolean },
): { proposals: ProposalDraft[]; findings: unknown[] } {
  const keptProposals: ProposalDraft[] = [];
  const extraFindings: unknown[] = [];
  for (const raw of outcome.proposals ?? []) {
    const intent = coerceWriteIntent(raw);
    if (!intent) {
      extraFindings.push({ type: "invalid_proposal", detail: redact(raw) });
      continue;
    }
    const decision = dispatchWriteIntent(agent, intent, ctx);
    if (decision.disposition === "dropped") extraFindings.push(decision.finding);
    else keptProposals.push(decision.proposal);
  }
  return {
    proposals: keptProposals,
    findings: [...(outcome.findings ?? []), ...extraFindings],
  };
}

// ── Kill switch resolution ───────────────────────────────────────────────────

// Compose global + per-agent pause into a single halt decision (pure). Global
// pause takes precedence. The caller reads the global switch fail-closed
// (unreadable → true) before calling this.
export function resolveHalt(
  agent: AgentRow,
  globalPaused: boolean,
): { halted: boolean; reason: string | null } {
  if (globalPaused) return { halted: true, reason: "globally_paused" };
  if (agent.status === "paused") return { halted: true, reason: "agent_paused" };
  return { halted: false, reason: null };
}

// ── Demotion (policy breach) ─────────────────────────────────────────────────

export interface PolicyDeps {
  loadAutonomy: (agentId: string) => Promise<Record<string, unknown>>;
  /** MUST reject when the write does not land — see prodPolicyDeps. */
  saveAutonomy: (agentId: string, autonomy: Record<string, unknown>) => Promise<void>;
  /**
   * US-2364: the escalation when the demotion cannot be persisted. An agent
   * that breached policy and could NOT be demoted must not keep running at the
   * level it just abused, so it is paused instead — `resolveHalt` above already
   * treats `status === "paused"` as halted.
   */
  pauseAgent: (agentId: string, reason: string) => Promise<void>;
  emitBreachEvent: (
    agent: AgentRow,
    actionClass: string,
    from: AutonomyLevel,
    to: AutonomyLevel,
    reason: string,
  ) => Promise<void>;
}

export function prodPolicyDeps(): PolicyDeps {
  return {
    loadAutonomy: async (agentId) => {
      const { data } = await supabaseAdmin
        .from("agents")
        .select("autonomy")
        .eq("id", agentId)
        .maybeSingle();
      const a = (data as { autonomy?: Record<string, unknown> } | null)?.autonomy;
      return a && typeof a === "object" ? a : {};
    },
    saveAutonomy: async (agentId, autonomy) => {
      // US-2364: READ THE ERROR. supabase-js resolves with `{ data, error }`
      // rather than rejecting, so the previous version could not fail: a
      // rejected write returned normally and the caller's `.catch()` had
      // nothing to catch. That was the deeper half of the silence — the
      // swallow was only the visible half.
      const { error } = await supabaseAdmin
        .from("agents")
        .update({ autonomy } as never)
        .eq("id", agentId);
      if (error) throw new Error(`saveAutonomy failed: ${error.message}`);
    },
    pauseAgent: async (agentId, _reason) => {
      // `agents` has no reason column (00357: status is a two-value CHECK), and
      // adding one is a migration this does not need — the WHY travels on the
      // critical ops event below, which is where an operator looks anyway.
      const { error } = await supabaseAdmin
        .from("agents")
        .update({ status: "paused" } as never)
        .eq("id", agentId);
      if (error) throw new Error(`pauseAgent failed: ${error.message}`);
    },
    emitBreachEvent: (agent, actionClass, from, to, reason) =>
      emitOpsEvent("agent.policy_breach", "warning", {
        title: `Agent ${agent.key} demoted L${from}→L${to} on ${actionClass}`,
        source: "agent-policy",
        data: { agent_key: agent.key, agent_id: agent.id, action_class: actionClass, from, to, reason },
      }),
  };
}

// Demote (agent, action-class) one level (floored at L0), persist the change,
// and emit a warning ops event. A rejected-then-executed action or a budget
// breach calls this (vault/70-agent/agentic-os-map.md §2). Never throws — every
// caller treats it as fire-and-forget — but US-2364 removed the SILENCE that
// came with that: a demotion that cannot be persisted is retried, then escalated
// by pausing the agent and emitting a CRITICAL ops event. Returns the level
// transition plus whether it actually landed.
const SAVE_ATTEMPTS = 3;

export async function recordPolicyBreach(
  agent: AgentRow,
  actionClass: string,
  reason: string,
  deps: Partial<PolicyDeps> = {},
): Promise<{
  from: AutonomyLevel;
  to: AutonomyLevel;
  /** False when the demotion could not be persisted after every attempt. */
  applied: boolean;
  /** True when the agent was paused because the demotion did not stick. */
  halted: boolean;
}> {
  const d = { ...prodPolicyDeps(), ...deps };
  const from = resolveAutonomy(agent, actionClass);
  const to = Math.max(0, from - 1) as AutonomyLevel;

  // Read fresh autonomy so a concurrent grant isn't clobbered wholesale (we only
  // touch the one class). Fall back to the in-memory copy on read failure.
  let fresh: Record<string, unknown>;
  try {
    fresh = await d.loadAutonomy(agent.id);
  } catch {
    fresh = agent.autonomy ?? {};
  }
  const next = { ...fresh, [actionClass]: to };

  // US-2364: the demotion is retried, and its failure is never silent.
  //
  // This used to be `.catch(() => {})`, which left an agent that had just
  // breached policy sitting at the level it abused, with nothing anywhere
  // recording that the demotion had not happened. The failure mode is the worst
  // shape available: the system reports a demotion, the operator believes the
  // agent is contained, and the agent keeps its old privileges.
  let applied = false;
  let lastErr: unknown = null;
  for (let attempt = 1; attempt <= SAVE_ATTEMPTS; attempt++) {
    try {
      await d.saveAutonomy(agent.id, next);
      applied = true;
      break;
    } catch (err) {
      lastErr = err;
    }
  }

  // The breach event itself is emitted either way — a breach happened whether or
  // not we could record its consequence. No `.catch` here: emitOpsEvent is
  // internally best-effort and reports its own failures, so a catch would only
  // make this read as swallowing something.
  await d.emitBreachEvent(agent, actionClass, from, to, reason);

  let halted = false;
  if (!applied) {
    // Escalation, not a log line. An agent that cannot be demoted after a breach
    // is more dangerous than one that is stopped, so it is stopped.
    try {
      await d.pauseAgent(agent.id, `demotion_failed:${actionClass}`);
      halted = true;
    } catch (err) {
      captureException(err, {
        route: "agent-policy.pauseAgent",
        tags: { agent_key: agent.key, action_class: actionClass },
      });
    }
    captureException(
      lastErr instanceof Error ? lastErr : new Error(String(lastErr)),
      {
        route: "agent-policy.saveAutonomy",
        tags: { agent_key: agent.key, action_class: actionClass },
      },
    );
    await emitOpsEvent("agent.demotion_failed", "critical", {
      title: halted
        ? `Agent ${agent.key} could not be demoted on ${actionClass} — PAUSED`
        : `Agent ${agent.key} could not be demoted on ${actionClass} and is STILL RUNNING at L${from}`,
      source: "agent-policy",
      data: {
        agent_key: agent.key,
        agent_id: agent.id,
        action_class: actionClass,
        intended_level: to,
        still_at_level: from,
        paused: halted,
        attempts: SAVE_ATTEMPTS,
        reason,
        error: lastErr instanceof Error ? lastErr.message : String(lastErr),
      },
    });
  }

  return { from, to, applied, halted };
}
