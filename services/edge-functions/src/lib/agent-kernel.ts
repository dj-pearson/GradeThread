// US-1584 / AGENTIC-OS Phase 0 (Module A — Agent Kernel): the single run loop.
//
// runAgent(agentKey, trigger) is the hardened, budgeted runtime every domain
// agent shares (AGENTIC_OS.md §2 guardrails, §3.A). It: loads the agent, honors
// the pause kill-switches, creates an agent_runs row, runs a BOUNDED Claude
// tool-use loop (max steps / output tokens / wall-clock), records every model
// and tool step to agent_run_steps (PII-redacted), gates each model call on the
// ai-budget kill-switch, validates the final structured output, and finalizes
// the run with status + tokens + cost. It NEVER throws to the caller — every
// terminal path (success, timeout, budget-skip, pause-skip, malformed-failure,
// unexpected-error) resolves to a finalized run row and a RunResult.
//
// Testability: all impure edges (agent load, run/step persistence, the model
// step, the tool registry, the budget + pause reads, the clock) are injected via
// KernelDeps. prodKernelDeps() wires the real infrastructure; the unit tests
// drive a mocked model client. This mirrors the pure-core + injected-deps split
// used by affiliate-payout.ts and support-assistant-engine.ts.
//
// SECURITY (US-268): agents/agent_runs/agent_run_steps are operator tables
// (deny-all RLS, service-role only). No tenant data flows through the kernel;
// reads are keyed by the agent key / the run id the kernel itself created.

import type Anthropic from "@anthropic-ai/sdk";
import { supabaseAdmin } from "./supabase.ts";
import { getAnthropicClient, getDefaultModel } from "./ai-config.ts";
import { computeCostUsd } from "./ai-usage.ts";
import { isAiBudgetExhausted } from "./ai-budget-gate.ts";
import { redact, redactError } from "./log-redact.ts";
import { getSetting } from "./system-settings.ts";
import { agentToolRegistry } from "./agent-tools.ts";
import { applyWritePolicy } from "./agent-policy.ts";
import { DEFAULT_PROPOSAL_TTL_HOURS, persistProposals } from "./agent-proposals.ts";
import type { ProposalDraft } from "./agent-policy.ts";
import { notifyAdminsProposalsFiled } from "./admin-notifications.ts";
import { emitOpsEvent } from "./ops-events.ts";
import { captureException, recordMetric } from "./observability.ts";

// The severities the agent.* ops events use.
export type AgentEventSeverity = "info" | "warning" | "critical";

// ── Config + caps ────────────────────────────────────────────────────────────

// Models an agent may run on. An unknown/unset config.model falls back to the
// platform default rather than trusting an arbitrary string into messages.create.
export const AGENT_MODEL_ALLOWLIST = [
  "claude-opus-4-8",
  "claude-sonnet-5",
  "claude-sonnet-4-6",
  "claude-haiku-4-5-20251001",
];

export const DEFAULT_MAX_STEPS = 24;
export const DEFAULT_MAX_OUTPUT_TOKENS = 2048;
export const DEFAULT_MAX_WALL_CLOCK_MS = 5 * 60 * 1000; // 5 min
// The global kill-switch (system_settings). True → every agent short-circuits.
export const AGENTS_PAUSE_SETTING_KEY = "agents.pause";

export interface AgentConfig {
  model?: string;
  system_prompt?: string;
  // Per-agent tool allowlist. `tools` is the US-1585 name; `tool_allowlist` is
  // accepted as an alias.
  tools?: string[];
  tool_allowlist?: string[];
  max_steps?: number;
  max_output_tokens?: number;
  max_wall_clock_ms?: number;
  budget_feature?: string;
  budget_usd_daily?: number;
  schedule?: string;
  // TTL (hours) for proposals this agent files (US-1587).
  proposal_ttl_hours?: number;
  [k: string]: unknown;
}

export interface AgentRow {
  id: string;
  key: string;
  name: string;
  module_letter: string | null;
  status: "enabled" | "paused" | string;
  autonomy: Record<string, unknown>;
  config: AgentConfig;
}

export interface ResolvedCaps {
  maxSteps: number;
  maxOutputTokens: number;
  maxWallClockMs: number;
}

// Positive-integer coerce with a floor of 1 and a fallback for garbage.
function posInt(v: unknown, fallback: number): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : fallback;
}

// Resolve the per-run hard caps from config, with the safe defaults (pure).
export function resolveCaps(config: AgentConfig): ResolvedCaps {
  return {
    maxSteps: posInt(config.max_steps, DEFAULT_MAX_STEPS),
    maxOutputTokens: posInt(config.max_output_tokens, DEFAULT_MAX_OUTPUT_TOKENS),
    maxWallClockMs: posInt(config.max_wall_clock_ms, DEFAULT_MAX_WALL_CLOCK_MS),
  };
}

// Pick the model: config.model if allowlisted, else the platform default (pure).
export function resolveAgentModel(config: AgentConfig): string {
  const m = config.model;
  if (typeof m === "string" && AGENT_MODEL_ALLOWLIST.includes(m)) return m;
  return getDefaultModel();
}

// ── The output contract ──────────────────────────────────────────────────────

export interface AgentOutcome {
  summary: string;
  findings: unknown[];
  proposals: unknown[];
  // Set on a non-clean finish (timeout / budget-skip / pause) so downstream
  // consumers can tell a partial outcome from a validated one.
  partial?: boolean;
  reason?: string;
}

export type OutcomeParse =
  | { ok: true; outcome: AgentOutcome }
  | { ok: false; error: string };

// Parse + validate the agent's final text as the { summary, findings, proposals }
// contract (pure). Tolerates a ```json code fence and leading/trailing prose by
// extracting the first balanced object. Anything that isn't the exact shape
// (summary:string, findings:array, proposals:array) is a hard failure.
export function parseAgentOutcome(text: string): OutcomeParse {
  const raw = extractJsonObject(text);
  if (raw === null) return { ok: false, error: "no JSON object in output" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { ok: false, error: `JSON parse failed: ${err instanceof Error ? err.message : "invalid"}` };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, error: "output is not an object" };
  }
  const o = parsed as Record<string, unknown>;
  if (typeof o.summary !== "string") return { ok: false, error: "summary must be a string" };
  if (!Array.isArray(o.findings)) return { ok: false, error: "findings must be an array" };
  if (!Array.isArray(o.proposals)) return { ok: false, error: "proposals must be an array" };
  return {
    ok: true,
    outcome: { summary: o.summary, findings: o.findings, proposals: o.proposals },
  };
}

// Extract the first balanced {...} run from text (handles ```json fences + prose).
function extractJsonObject(text: string): string | null {
  if (typeof text !== "string") return null;
  const start = text.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

// ── Model step + tool registry seams ─────────────────────────────────────────

export interface KernelModelStep {
  text: string;
  toolUses: Array<{ id: string; name: string; input: unknown }>;
  stopReason: string | null;
  usage: { inputTokens: number; outputTokens: number };
  assistantContent: Anthropic.ContentBlockParam[];
}

export type KernelStepFn = (messages: Anthropic.MessageParam[]) => Promise<KernelModelStep>;

// The tool registry is built by US-1585; the kernel only needs this surface and
// works against an empty one (the agent then runs read-only and just emits an
// outcome). isAllowed composes the agent's own allowlist with the registry.
export interface AgentToolRegistry {
  anthropicTools(agent: AgentRow): Anthropic.Tool[];
  isAllowed(agent: AgentRow, name: string): boolean;
  execute(agent: AgentRow, name: string, input: unknown): Promise<unknown>;
}

export const EMPTY_TOOL_REGISTRY: AgentToolRegistry = {
  anthropicTools: () => [],
  isAllowed: () => false,
  execute: (_a, name) => Promise.reject(new Error(`tool not available: ${name}`)),
};

// ── Deps ─────────────────────────────────────────────────────────────────────

export interface StepRecord {
  seq: number;
  stepType: "model_call" | "tool_call" | "output";
  name: string | null;
  input: unknown;
  output: unknown;
  durationMs: number;
}

export interface RunFinalize {
  status: RunStatus;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  outcome: AgentOutcome | null;
  error: string | null;
}

export interface KernelDeps {
  loadAgent: (agentKey: string) => Promise<AgentRow | null>;
  // Global kill-switch read. The kernel treats a THROW as paused (fail-closed);
  // a normal false/true is honored as-is.
  getGlobalPause: () => Promise<boolean>;
  isBudgetExhausted: (feature: string) => Promise<boolean>;
  createRun: (agentId: string, trigger: string) => Promise<string | null>;
  recordStep: (runId: string, step: StepRecord) => Promise<void>;
  finalizeRun: (runId: string, patch: RunFinalize) => Promise<void>;
  makeStep: (agent: AgentRow, model: string, maxOutputTokens: number) => KernelStepFn;
  toolRegistry: AgentToolRegistry;
  // Persist an agent's filed proposal drafts (US-1587). Returns the count filed.
  persistProposals: (
    agentId: string,
    runId: string,
    drafts: ProposalDraft[],
    ttlHours: number,
  ) => Promise<number>;
  // Notify admins of newly-filed proposals, batched per run (US-1657).
  notifyProposalsFiled: (agentKey: string, runId: string, count: number) => Promise<void>;
  // Emit an agent.* ops event (US-1589). Fire-and-forget.
  emitEvent: (type: string, severity: AgentEventSeverity, data: Record<string, unknown>) => void;
  now: () => number;
}

export type RunStatus = "succeeded" | "failed" | "timeout" | "skipped";

export interface RunResult {
  runId: string | null;
  status: RunStatus;
  outcome: AgentOutcome | null;
  reason?: string;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
}

const DEFAULT_SYSTEM_PROMPT =
  "You are a GradeThread operations agent. Gather context using the tools you " +
  "are given (read-only unless told otherwise), reason about what you find, and " +
  "then STOP. Your final message MUST be a single JSON object and nothing else, " +
  'of the exact shape {"summary": string, "findings": array, "proposals": array}. ' +
  "summary is a short operator-facing paragraph; findings are notable " +
  "observations; proposals are structured write-actions for a human to approve " +
  "(leave empty unless you are explicitly authorized to propose actions).";

// ── The run loop ─────────────────────────────────────────────────────────────

export async function runAgent(
  agentKey: string,
  trigger: string,
  deps: Partial<KernelDeps> = {},
): Promise<RunResult> {
  const d = { ...prodKernelDeps(), ...deps };
  const empty: RunResult = {
    runId: null,
    status: "skipped",
    outcome: null,
    tokensIn: 0,
    tokensOut: 0,
    costUsd: 0,
  };

  // 1. Load the agent. A missing/unknown key is a no-op skip (no row to FK to).
  let agent: AgentRow | null;
  try {
    agent = await d.loadAgent(agentKey);
  } catch (err) {
    console.warn(`[agent-kernel] load failed for ${agentKey}: ${redactError(err)}`);
    return { ...empty, reason: "load_failed" };
  }
  if (!agent) return { ...empty, reason: "agent_not_found" };

  // Create the run row up front so every terminal path finalizes one uniform row.
  let runId: string | null;
  try {
    runId = await d.createRun(agent.id, trigger);
  } catch (err) {
    console.warn(`[agent-kernel] createRun failed for ${agentKey}: ${redactError(err)}`);
    runId = null;
  }
  if (!runId) return { ...empty, reason: "run_row_failed" };

  // Captured once (agent is a `let` — TS won't keep the non-null narrowing inside
  // the finalize closure). Observability keys off these.
  const agentKey = agent.key;
  const runStartMs = d.now();
  let seq = 0;

  const finalize = async (patch: RunFinalize): Promise<RunResult> => {
    try {
      await d.finalizeRun(runId!, patch);
    } catch (err) {
      console.warn(`[agent-kernel] finalizeRun failed for run ${runId}: ${redactError(err)}`);
    }
    // US-1589: a terminal agent.run.* ops event + a metric line, per outcome.
    const durationMs = d.now() - runStartMs;
    const evType = patch.status === "succeeded"
      ? "agent.run.finished"
      : patch.status === "failed"
      ? "agent.run.failed"
      : patch.status === "timeout"
      ? "agent.run.timeout"
      : "agent.run.skipped";
    const evSeverity: AgentEventSeverity = patch.status === "failed" || patch.status === "timeout"
      ? "warning"
      : "info";
    d.emitEvent(evType, evSeverity, {
      agent: agentKey,
      run_id: runId,
      status: patch.status,
      duration_ms: durationMs,
      steps: seq,
      tokens_in: patch.tokensIn,
      tokens_out: patch.tokensOut,
      cost_usd: patch.costUsd,
      reason: patch.outcome?.reason ?? null,
    });
    recordMetric("agent.run", 1, {
      agent: agentKey,
      outcome: patch.status,
      duration_ms: durationMs,
      steps: seq,
      tokens_in: patch.tokensIn,
      tokens_out: patch.tokensOut,
      cost_usd: patch.costUsd,
    });
    return {
      runId,
      status: patch.status,
      outcome: patch.outcome,
      reason: patch.outcome?.reason,
      tokensIn: patch.tokensIn,
      tokensOut: patch.tokensOut,
      costUsd: patch.costUsd,
    };
  };

  // 2. Pause kill-switches (AC5): global setting (fail-closed on read error) OR
  //    the agent's own paused status → skip.
  let globallyPaused: boolean;
  try {
    globallyPaused = await d.getGlobalPause();
  } catch {
    globallyPaused = true; // fail-closed: an unreadable switch means "paused".
  }
  if (globallyPaused || agent.status === "paused") {
    const reason = globallyPaused ? "globally_paused" : "agent_paused";
    return finalize({
      status: "skipped",
      tokensIn: 0,
      tokensOut: 0,
      costUsd: 0,
      outcome: { summary: `Skipped: ${reason}`, findings: [], proposals: [], partial: true, reason },
      error: null,
    });
  }

  // 3. Run the bounded tool-use loop.
  const caps = resolveCaps(agent.config);
  const model = resolveAgentModel(agent.config);
  const budgetFeature = typeof agent.config.budget_feature === "string"
    ? agent.config.budget_feature
    : "agent-kernel";
  const startedAt = d.now();
  const step = d.makeStep(agent, model, caps.maxOutputTokens);

  const systemPrompt = typeof agent.config.system_prompt === "string" && agent.config.system_prompt
    ? agent.config.system_prompt
    : DEFAULT_SYSTEM_PROMPT;
  const messages: Anthropic.MessageParam[] = [
    { role: "user", content: `System context: ${systemPrompt}\n\nBegin your run for trigger "${trigger}".` },
  ];

  let tokensIn = 0;
  let tokensOut = 0;
  let finalText: string | null = null;

  // US-1589: the run has truly begun (past the pause/kill gate).
  d.emitEvent("agent.run.started", "info", { agent: agentKey, run_id: runId, trigger, model });

  const costOf = (): number =>
    computeCostUsd({
      model,
      inputTokens: tokensIn,
      outputTokens: tokensOut,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
    });

  try {
    for (let iteration = 0; ; iteration++) {
      // Wall-clock cap (AC2).
      if (d.now() - startedAt > caps.maxWallClockMs) {
        return finalize(partialFinish("timeout", "wall_clock_exceeded", tokensIn, tokensOut, costOf()));
      }
      // Step cap (AC2).
      if (iteration >= caps.maxSteps) {
        return finalize(partialFinish("timeout", "max_steps_exceeded", tokensIn, tokensOut, costOf()));
      }
      // Budget gate BEFORE every model call (AC4).
      if (await d.isBudgetExhausted(budgetFeature)) {
        return finalize(partialFinish("skipped", "budget_exhausted", tokensIn, tokensOut, costOf()));
      }

      const t0 = d.now();
      const s = await step(messages);
      tokensIn += s.usage.inputTokens;
      tokensOut += s.usage.outputTokens;
      await d.recordStep(runId, {
        seq: seq++,
        stepType: "model_call",
        name: model,
        input: { redacted: redact(messages) },
        output: { redacted: redact({ text: s.text, toolUses: s.toolUses, stopReason: s.stopReason }) },
        durationMs: d.now() - t0,
      });

      // Terminal turn: the model stopped asking for tools → this is the output.
      if (s.stopReason !== "tool_use" || s.toolUses.length === 0) {
        finalText = s.text;
        break;
      }

      // Otherwise execute each requested tool and feed the results back.
      messages.push({ role: "assistant", content: s.assistantContent });
      const toolResults: Anthropic.ContentBlockParam[] = [];
      for (const tu of s.toolUses) {
        const tt0 = d.now();
        let output: unknown;
        let isError = false;
        if (!d.toolRegistry.isAllowed(agent, tu.name)) {
          output = { error: `tool not allowed: ${tu.name}` };
          isError = true;
        } else {
          try {
            output = await d.toolRegistry.execute(agent, tu.name, tu.input);
          } catch (err) {
            output = { error: redactError(err) };
            isError = true;
          }
        }
        await d.recordStep(runId, {
          seq: seq++,
          stepType: "tool_call",
          name: tu.name,
          input: { redacted: redact(tu.input) },
          output: { redacted: redact(output) },
          durationMs: d.now() - tt0,
        });
        toolResults.push({
          type: "tool_result",
          tool_use_id: tu.id,
          content: redact(output),
          ...(isError ? { is_error: true } : {}),
        });
      }
      messages.push({ role: "user", content: toolResults });
    }
  } catch (err) {
    // Any unexpected error (model call, tool, persistence) → clean 'failed'.
    // US-1589: route the crash through captureException with the run id, but the
    // run row still finalizes as 'failed'.
    console.warn(`[agent-kernel] run ${runId} errored: ${redactError(err)}`);
    captureException(err, {
      route: "agent-kernel",
      level: "error",
      tags: { run_id: runId, agent: agentKey },
    });
    return finalize({
      status: "failed",
      tokensIn,
      tokensOut,
      costUsd: costOf(),
      outcome: null,
      error: redactError(err),
    });
  }

  // 4. Validate the structured output contract (AC6).
  const parsed = parseAgentOutcome(finalText ?? "");
  if (!parsed.ok) {
    await d.recordStep(runId, {
      seq: seq++,
      stepType: "output",
      name: "invalid_output",
      input: { redacted: redact(finalText ?? "") },
      output: { error: parsed.error },
      durationMs: 0,
    }).catch(() => {});
    return finalize({
      status: "failed",
      tokensIn,
      tokensOut,
      costUsd: costOf(),
      outcome: null,
      error: `malformed output: ${parsed.error}`,
    });
  }

  // Route any emitted write intents through the policy engine (US-1586): L0 /
  // paused proposals become findings; L1+ become pending proposal drafts. The
  // pause switch is re-read fail-closed here — the "checked at each write
  // dispatch" half of the kill-switch guarantee.
  let writePaused: boolean;
  try {
    writePaused = await d.getGlobalPause();
  } catch {
    writePaused = true;
  }
  const routed = applyWritePolicy(agent, parsed.outcome, { paused: writePaused });
  const outcome: AgentOutcome = {
    ...parsed.outcome,
    findings: routed.findings,
    proposals: routed.proposals,
  };

  // Persist filed proposals to agent_proposals (pending, TTL from config) — the
  // idempotency_key dedup makes a re-run non-duplicating (US-1587). Best-effort.
  if (routed.proposals.length) {
    const ttlHours = typeof agent.config.proposal_ttl_hours === "number"
      ? agent.config.proposal_ttl_hours
      : DEFAULT_PROPOSAL_TTL_HOURS;
    try {
      const filed = await d.persistProposals(agent.id, runId, routed.proposals, ttlHours);
      if (filed > 0) {
        await d.notifyProposalsFiled(agentKey, runId, filed);
        d.emitEvent("agent.proposal.created", "info", { agent: agentKey, run_id: runId, count: filed });
      }
    } catch (err) {
      console.warn(`[agent-kernel] persistProposals failed for run ${runId}: ${redactError(err)}`);
    }
  }

  await d.recordStep(runId, {
    seq: seq++,
    stepType: "output",
    name: "output",
    input: null,
    output: { redacted: redact(outcome) },
    durationMs: 0,
  }).catch(() => {});

  return finalize({
    status: "succeeded",
    tokensIn,
    tokensOut,
    costUsd: costOf(),
    outcome,
    error: null,
  });
}

function partialFinish(
  status: RunStatus,
  reason: string,
  tokensIn: number,
  tokensOut: number,
  costUsd: number,
): RunFinalize {
  return {
    status,
    tokensIn,
    tokensOut,
    costUsd,
    outcome: { summary: `Run halted: ${reason}`, findings: [], proposals: [], partial: true, reason },
    error: status === "failed" ? reason : null,
  };
}

// ── Production deps ──────────────────────────────────────────────────────────

export function prodKernelDeps(): KernelDeps {
  return {
    loadAgent: async (agentKey) => {
      const { data } = await supabaseAdmin
        .from("agents")
        .select("id, key, name, module_letter, status, autonomy, config")
        .eq("key", agentKey)
        .maybeSingle();
      if (!data) return null;
      const row = data as Record<string, unknown>;
      return {
        id: String(row.id),
        key: String(row.key),
        name: String(row.name),
        module_letter: (row.module_letter as string | null) ?? null,
        status: String(row.status),
        autonomy: (row.autonomy as Record<string, unknown>) ?? {},
        config: (row.config as AgentConfig) ?? {},
      };
    },
    getGlobalPause: () => getSetting<boolean>(AGENTS_PAUSE_SETTING_KEY, false),
    isBudgetExhausted: (feature) => isAiBudgetExhausted(feature),
    createRun: async (agentId, trigger) => {
      const { data } = await supabaseAdmin
        .from("agent_runs")
        .insert(
          {
            agent_id: agentId,
            trigger,
            status: "running",
            started_at: new Date().toISOString(),
          } as never,
        )
        .select("id")
        .single();
      return (data as { id: string } | null)?.id ?? null;
    },
    recordStep: async (runId, step) => {
      await supabaseAdmin.from("agent_run_steps").insert(
        {
          run_id: runId,
          seq: step.seq,
          step_type: step.stepType,
          name: step.name,
          input: step.input,
          output: step.output,
          duration_ms: step.durationMs,
        } as never,
      );
    },
    finalizeRun: async (runId, patch) => {
      await supabaseAdmin
        .from("agent_runs")
        .update(
          {
            status: patch.status,
            tokens_in: patch.tokensIn,
            tokens_out: patch.tokensOut,
            cost_usd: patch.costUsd,
            outcome: patch.outcome,
            error: patch.error,
            finished_at: new Date().toISOString(),
          } as never,
        )
        .eq("id", runId);
    },
    makeStep: (agent, model, maxOutputTokens) => {
      const client = getAnthropicClient();
      const tools = agentToolRegistry.anthropicTools(agent);
      const system = typeof agent.config.system_prompt === "string" && agent.config.system_prompt
        ? agent.config.system_prompt
        : DEFAULT_SYSTEM_PROMPT;
      return async (messages) => {
        const resp = await client.messages.create({
          model,
          max_tokens: maxOutputTokens,
          system,
          tools,
          messages,
        });
        const toolUses = resp.content
          .filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use")
          .map((b) => ({ id: b.id, name: b.name, input: b.input }));
        const text = resp.content
          .filter((b): b is Anthropic.TextBlock => b.type === "text")
          .map((b) => b.text)
          .join("");
        return {
          text,
          toolUses,
          stopReason: resp.stop_reason,
          usage: {
            inputTokens: resp.usage.input_tokens,
            outputTokens: resp.usage.output_tokens,
          },
          assistantContent: resp.content as Anthropic.ContentBlockParam[],
        };
      };
    },
    toolRegistry: agentToolRegistry,
    persistProposals: (agentId, runId, drafts, ttlHours) =>
      persistProposals(agentId, runId, drafts, ttlHours),
    notifyProposalsFiled: (agentKey, runId, count) =>
      notifyAdminsProposalsFiled(agentKey, runId, count),
    emitEvent: (type, severity, data) => {
      const key = typeof data.agent === "string" ? data.agent : "agent";
      emitOpsEvent(type, severity, {
        title: `${type} — ${key}`,
        source: "agent-kernel",
        data,
      });
    },
    now: () => Date.now(),
  };
}
