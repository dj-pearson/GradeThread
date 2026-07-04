// US-1584: the Agentic OS kernel run loop. ONE hardened, budgeted runtime
// executes every registered agent: assemble context, run a bounded Claude
// tool-use loop, record every step to agent_run_steps, persist a structured
// outcome to agent_runs. Domain agents (US-1593+) are DATA — a registry row
// with a prompt, a tool allowlist, and caps — never bespoke loops.
//
// Hard rules encoded here:
//  - caps from config with safe defaults (steps 24, wall-clock 5 min, output
//    tokens 4096); a breach kills the loop, records 'timeout' with a partial
//    outcome, and NEVER throws to the caller;
//  - every model call passes the ai-budget gate FIRST; a refusal ends the
//    run cleanly as 'skipped' with the reason in outcome;
//  - a paused agent or the global agents.pause setting short-circuits to a
//    'skipped' row — and the pause read is FAIL-CLOSED (unreadable → paused);
//  - every step's input/output goes through log-redact before persisting;
//  - the final output must match { summary, findings[], proposals[] } or the
//    run records 'failed'.

import type Anthropic from "@anthropic-ai/sdk";
import { supabaseAdmin } from "./supabase.ts";
import { getAnthropicClient, getDefaultModel } from "./ai-config.ts";
import { isAiBudgetExhausted } from "./ai-budget-gate.ts";
import { redact, redactError } from "./log-redact.ts";
import { computeCostUsd, toAiTokenUsage } from "./ai-usage.ts";
import { isGlobalAgentPause } from "./agent-policy.ts";
import { emitOpsEvent } from "./ops-events.ts";
import { captureException, recordMetric } from "./observability.ts";

// ── The output contract ──────────────────────────────────────────────────────

export interface AgentOutput {
  summary: string;
  findings: unknown[];
  proposals: unknown[];
}

/** Validate the agent's final answer. Null = malformed (run records failed). */
export function validateAgentOutput(raw: unknown): AgentOutput | null {
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.summary !== "string" || o.summary.trim() === "") return null;
  if (!Array.isArray(o.findings)) return null;
  if (!Array.isArray(o.proposals)) return null;
  return { summary: o.summary, findings: o.findings, proposals: o.proposals };
}

/** Extract the contract from the final model text (JSON, fenced or bare). */
export function parseAgentOutputText(text: string): AgentOutput | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = (fenced ? fenced[1] : text).trim();
  try {
    return validateAgentOutput(JSON.parse(candidate));
  } catch {
    return null;
  }
}

// ── Tool surface (filled by the US-1585 registry) ───────────────────────────

export interface AgentTool {
  name: string;
  description: string;
  // JSON Schema for the tool input (Anthropic tools format).
  inputSchema: Record<string, unknown>;
  run(input: Record<string, unknown>): Promise<unknown>;
}

// ── Caps ─────────────────────────────────────────────────────────────────────

export interface AgentCaps {
  maxSteps: number;
  maxWallClockMs: number;
  maxOutputTokens: number;
}

export function capsFromConfig(config: Record<string, unknown>): AgentCaps {
  const n = (v: unknown, dflt: number, max: number): number => {
    const parsed = typeof v === "number" && Number.isFinite(v) ? v : dflt;
    return Math.max(1, Math.min(parsed, max));
  };
  return {
    maxSteps: n(config.max_steps, 24, 100),
    maxWallClockMs: n(config.max_wall_clock_ms, 5 * 60_000, 30 * 60_000),
    maxOutputTokens: n(config.max_output_tokens, 4096, 16_384),
  };
}

// ── Injectable dependencies (tests mock the lot) ────────────────────────────

interface AgentRow {
  id: string;
  key: string;
  status: string;
  config: Record<string, unknown>;
}

export interface KernelDb {
  loadAgent(key: string): Promise<AgentRow | null>;
  insertRun(row: Record<string, unknown>): Promise<string>; // returns run id
  updateRun(id: string, patch: Record<string, unknown>): Promise<void>;
  insertStep(row: Record<string, unknown>): Promise<void>;
}

export interface ModelTurn {
  // Mirrors the Anthropic response surface the loop consumes.
  stopReason: string | null;
  content: Array<
    | { type: "text"; text: string }
    | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  >;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
}

export interface KernelDeps {
  db: KernelDb;
  /** US-1587: file the run's proposals through the policy engine. */
  fileProposals(
    agent: { id: string; key: string; status: string; autonomy: Record<string, unknown> | null },
    runId: string,
    proposals: unknown[],
    config: Record<string, unknown>,
  ): Promise<{ filed: number; dropped: number; skipped: number }>;
  callModel(params: {
    model: string;
    system: string;
    messages: Anthropic.MessageParam[];
    tools: Anthropic.Tool[];
    maxTokens: number;
  }): Promise<ModelTurn>;
  isBudgetExhausted(feature: string): Promise<boolean>;
  /** FAIL-CLOSED global pause: true when paused OR the read failed. */
  isGloballyPaused(): Promise<boolean>;
  tools: Record<string, AgentTool>;
  now(): number;
  /** US-1589: agent.* activity-stream events (injectable for tests). */
  emitEvent(
    type: string,
    severity: "info" | "warning" | "critical",
    payload: { title: string; source?: string; data?: Record<string, unknown> },
  ): Promise<void>;
}

const defaultDb: KernelDb = {
  async loadAgent(key) {
    const { data, error } = await supabaseAdmin
      .from("agents")
      .select("id, key, status, config")
      .eq("key", key)
      .maybeSingle();
    if (error) throw new Error(`agent load failed: ${error.message}`);
    return (data as AgentRow | null) ?? null;
  },
  async insertRun(row) {
    const { data, error } = await supabaseAdmin
      .from("agent_runs")
      .insert(row)
      .select("id")
      .single();
    if (error) throw new Error(`run insert failed: ${error.message}`);
    return (data as { id: string }).id;
  },
  async updateRun(id, patch) {
    const { error } = await supabaseAdmin
      .from("agent_runs")
      .update(patch)
      .eq("id", id);
    if (error) throw new Error(`run update failed: ${error.message}`);
  },
  async insertStep(row) {
    const { error } = await supabaseAdmin.from("agent_run_steps").insert(row);
    if (error) throw new Error(`step insert failed: ${error.message}`);
  },
};

async function defaultCallModel(params: {
  model: string;
  system: string;
  messages: Anthropic.MessageParam[];
  tools: Anthropic.Tool[];
  maxTokens: number;
}): Promise<ModelTurn> {
  const client = getAnthropicClient();
  const response = await client.messages.create({
    model: params.model,
    max_tokens: params.maxTokens,
    system: params.system,
    messages: params.messages,
    ...(params.tools.length > 0 ? { tools: params.tools } : {}),
  });
  const usage = toAiTokenUsage(params.model, response.usage);
  return {
    stopReason: response.stop_reason,
    content: response.content as ModelTurn["content"],
    tokensIn: usage.inputTokens + usage.cacheCreationTokens + usage.cacheReadTokens,
    tokensOut: usage.outputTokens,
    costUsd: computeCostUsd(usage),
  };
}

async function defaultFileProposals(
  agent: { id: string; key: string; status: string; autonomy: Record<string, unknown> | null },
  runId: string,
  proposals: unknown[],
  config: Record<string, unknown>,
) {
  const { fileProposalsFromRun } = await import("./agent-proposals.ts");
  return await fileProposalsFromRun(agent, runId, proposals, config);
}

const defaultDeps: KernelDeps = {
  db: defaultDb,
  fileProposals: defaultFileProposals,
  callModel: defaultCallModel,
  isBudgetExhausted: isAiBudgetExhausted,
  // ONE pause implementation across run start and write dispatch —
  // the policy engine's fail-closed reader (US-1586).
  isGloballyPaused: () => isGlobalAgentPause(),
  emitEvent: (type, severity, payload) => emitOpsEvent(type, severity, payload),
  tools: {},
  now: () => Date.now(),
};

// ── The run loop ─────────────────────────────────────────────────────────────

export interface RunResult {
  runId: string | null;
  status: "succeeded" | "failed" | "timeout" | "skipped";
}

export async function runAgent(
  agentKey: string,
  trigger: string,
  overrides: Partial<KernelDeps> = {},
): Promise<RunResult> {
  const deps: KernelDeps = { ...defaultDeps, ...overrides };
  try {
    return await execute(agentKey, trigger, deps);
  } catch (err) {
    // The kernel NEVER throws to the caller (schedulers must survive
    // anything). A failure this far out means bookkeeping itself broke.
    console.error(`[agent-kernel] ${agentKey}: ${redactError(err)}`);
    return { runId: null, status: "failed" };
  }
}

async function execute(
  agentKey: string,
  trigger: string,
  deps: KernelDeps,
): Promise<RunResult> {
  const agent = await deps.db.loadAgent(agentKey);
  if (!agent) {
    console.error(`[agent-kernel] unknown agent key: ${agentKey}`);
    return { runId: null, status: "failed" };
  }

  // Pause short-circuits still leave a ledger row — silence is not a record.
  const globallyPaused = await deps.isGloballyPaused();
  if (agent.status === "paused" || globallyPaused) {
    const reason = globallyPaused ? "global agents.pause" : "agent paused";
    const runId = await deps.db.insertRun({
      agent_id: agent.id,
      trigger,
      status: "skipped",
      started_at: new Date(deps.now()).toISOString(),
      finished_at: new Date(deps.now()).toISOString(),
      outcome: { reason },
    });
    return { runId, status: "skipped" };
  }

  const caps = capsFromConfig(agent.config ?? {});
  const model = typeof agent.config?.model === "string"
    ? (agent.config.model as string)
    : getDefaultModel();
  const budgetFeature = typeof agent.config?.budget_feature === "string"
    ? (agent.config.budget_feature as string)
    : "agents";
  const systemPrompt = typeof agent.config?.system_prompt === "string"
    ? (agent.config.system_prompt as string)
    : `You are the ${agent.key} agent for GradeThread's operations.`;

  // Allowlist-validated tool surface: config names ∩ the registered tools.
  const allowlist = Array.isArray(agent.config?.tool_allowlist)
    ? (agent.config.tool_allowlist as string[])
    : [];
  const tools = allowlist
    .map((name) => deps.tools[name])
    .filter((t): t is AgentTool => t != null);
  const anthropicTools: Anthropic.Tool[] = tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.inputSchema as Anthropic.Tool["input_schema"],
  }));

  const startedAt = deps.now();
  const runId = await deps.db.insertRun({
    agent_id: agent.id,
    trigger,
    status: "running",
    started_at: new Date(startedAt).toISOString(),
  });
  // US-1589: the activity stream sees every run begin (info — routine).
  void deps.emitEvent("agent.run.started", "info", {
    title: `Agent '${agent.key}' run started (${trigger})`,
    source: "agent-kernel",
    data: { agent: agent.key, run_id: runId, trigger },
  }).catch(() => {});

  let seq = 0;
  let tokensIn = 0;
  let tokensOut = 0;
  let costUsd = 0;

  const recordStep = async (
    stepType: "model_call" | "tool_call" | "output",
    name: string,
    input: unknown,
    output: unknown,
    durationMs: number,
  ) => {
    seq += 1;
    await deps.db.insertStep({
      run_id: runId,
      seq,
      step_type: stepType,
      name,
      // PII never reaches the transcript (US-1584 AC3).
      input: input == null ? null : { redacted: redact(input) },
      output: output == null ? null : { redacted: redact(output) },
      duration_ms: Math.round(durationMs),
    });
  };

  const finalize = async (
    status: RunResult["status"],
    outcome: Record<string, unknown> | null,
    error?: string,
  ): Promise<RunResult> => {
    const durationMs = deps.now() - startedAt;
    await deps.db.updateRun(runId, {
      status,
      finished_at: new Date(deps.now()).toISOString(),
      tokens_in: tokensIn,
      tokens_out: tokensOut,
      cost_usd: Number(costUsd.toFixed(4)),
      outcome,
      ...(error ? { error: redact(error) } : {}),
    });
    // US-1589: one metrics line per run, tagged by agent key.
    recordMetric("agent_run", durationMs, {
      agent: agent.key,
      outcome: status,
      steps: seq,
      tokens_in: tokensIn,
      tokens_out: tokensOut,
      cost_usd: Number(costUsd.toFixed(4)),
    });
    // Terminal activity-stream event: failures/timeouts are warnings,
    // routine completions info. Skips already ledgered at the start path.
    const type = status === "succeeded"
      ? "agent.run.finished"
      : status === "timeout"
      ? "agent.run.timeout"
      : "agent.run.failed";
    if (status !== "skipped") {
      void deps.emitEvent(type, status === "succeeded" ? "info" : "warning", {
        title: `Agent '${agent.key}' run ${status} ` +
          `(${Math.round(durationMs / 1000)}s, $${costUsd.toFixed(4)})`,
        source: "agent-kernel",
        data: {
          agent: agent.key,
          run_id: runId,
          duration_ms: durationMs,
          cost_usd: Number(costUsd.toFixed(4)),
          steps: seq,
        },
      }).catch(() => {});
    }
    return { runId, status };
  };

  const messages: Anthropic.MessageParam[] = [
    {
      role: "user",
      content:
        `Trigger: ${trigger}. Run your checks now. When finished, reply with ` +
        `ONLY a JSON object matching {"summary": string, "findings": [], "proposals": []}.`,
    },
  ];

  try {
    for (let step = 0; step < caps.maxSteps; step++) {
      // Wall-clock breach → timeout with whatever we have (partial outcome).
      if (deps.now() - startedAt > caps.maxWallClockMs) {
        return await finalize("timeout", {
          partial: true,
          reason: `wall clock exceeded ${caps.maxWallClockMs}ms`,
          steps: seq,
        });
      }

      // Budget gate BEFORE every model call — a refusal is a clean skip.
      if (await deps.isBudgetExhausted(budgetFeature)) {
        return await finalize("skipped", {
          reason: `ai budget exhausted for feature '${budgetFeature}'`,
          steps: seq,
        });
      }

      const t0 = deps.now();
      const turn = await deps.callModel({
        model,
        system: systemPrompt,
        messages,
        tools: anthropicTools,
        maxTokens: caps.maxOutputTokens,
      });
      tokensIn += turn.tokensIn;
      tokensOut += turn.tokensOut;
      costUsd += turn.costUsd;
      await recordStep(
        "model_call",
        model,
        { messageCount: messages.length },
        turn.content,
        deps.now() - t0,
      );

      const toolUses = turn.content.filter(
        (b): b is Extract<ModelTurn["content"][number], { type: "tool_use" }> =>
          b.type === "tool_use",
      );

      if (turn.stopReason === "tool_use" && toolUses.length > 0) {
        messages.push({
          role: "assistant",
          content: turn.content as Anthropic.ContentBlockParam[],
        });
        const results: Anthropic.ToolResultBlockParam[] = [];
        for (const use of toolUses) {
          const tool = tools.find((t) => t.name === use.name);
          const tt0 = deps.now();
          let resultContent: string;
          if (!tool) {
            // Model asked for something off-allowlist — refuse, don't crash.
            resultContent = JSON.stringify({
              error: `tool '${use.name}' is not on this agent's allowlist`,
            });
          } else {
            try {
              resultContent = JSON.stringify(await tool.run(use.input));
            } catch (err) {
              resultContent = JSON.stringify({ error: redactError(err) });
            }
          }
          await recordStep(
            "tool_call",
            use.name,
            use.input,
            resultContent,
            deps.now() - tt0,
          );
          results.push({
            type: "tool_result",
            tool_use_id: use.id,
            content: resultContent,
          });
        }
        messages.push({ role: "user", content: results });
        continue;
      }

      // Final turn: enforce the output contract.
      const text = turn.content
        .filter((b): b is { type: "text"; text: string } => b.type === "text")
        .map((b) => b.text)
        .join("\n");
      const output = parseAgentOutputText(text);
      if (!output) {
        await recordStep("output", "malformed", null, text.slice(0, 2000), 0);
        return await finalize("failed", null, "malformed agent output (contract violation)");
      }
      await recordStep("output", "final", null, output, 0);
      // US-1587: the run's proposals ride the policy engine (per-class
      // autonomy applies to each); the filing tally lands in the outcome.
      let filing: { filed: number; dropped: number; skipped: number } | null = null;
      if (output.proposals.length > 0) {
        try {
          filing = await deps.fileProposals(
            { id: agent.id, key: agent.key, status: agent.status, autonomy: null },
            runId,
            output.proposals,
            agent.config ?? {},
          );
        } catch (err) {
          filing = { filed: 0, dropped: 0, skipped: output.proposals.length };
          console.error(`[agent-kernel] proposal filing failed: ${redactError(err)}`);
        }
      }
      return await finalize("succeeded", {
        ...(output as unknown as Record<string, unknown>),
        ...(filing ? { proposal_filing: filing } : {}),
      });
    }

    // Step cap breached — the model never produced a final answer.
    return await finalize("timeout", {
      partial: true,
      reason: `step cap ${caps.maxSteps} exceeded`,
      steps: seq,
    });
  } catch (err) {
    // US-1589: kernel crashes are captured with the run id as context; the
    // run row STILL finalizes as failed (the ledger never lies by omission).
    captureException(err, { route: "agent-kernel.execute", correlationId: runId });
    return await finalize("failed", null, redactError(err));
  }
}
