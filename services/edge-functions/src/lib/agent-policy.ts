// US-1586 / AGENTIC-OS Phase 0 (Module D): the policy engine — the spine of the
// whole OS (AGENTIC_OS.md §2 autonomy ladder, §3.D).
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
] as const;
export type KnownActionClass = typeof ACTION_CLASSES[number];

export function isKnownActionClass(v: string): v is KnownActionClass {
  return (ACTION_CLASSES as readonly string[]).includes(v);
}

// ── Permanent per-(agent, action-class) autonomy hard caps ───────────────────
//
// A PERMANENT design decision, NOT a tunable (AGENTIC_OS.md §2 ladder note): the
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
  saveAutonomy: (agentId: string, autonomy: Record<string, unknown>) => Promise<void>;
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
      await supabaseAdmin
        .from("agents")
        .update({ autonomy } as never)
        .eq("id", agentId);
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
// breach calls this (AGENTIC_OS.md §2). Best-effort persistence/event — never
// throws. Returns the level transition.
export async function recordPolicyBreach(
  agent: AgentRow,
  actionClass: string,
  reason: string,
  deps: Partial<PolicyDeps> = {},
): Promise<{ from: AutonomyLevel; to: AutonomyLevel }> {
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
  await d.saveAutonomy(agent.id, next).catch(() => {});
  await d.emitBreachEvent(agent, actionClass, from, to, reason).catch(() => {});
  return { from, to };
}
