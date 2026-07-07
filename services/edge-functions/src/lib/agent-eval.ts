// Agent eval harness (US-1607): the grading-engine eval discipline applied to
// the agent fleet. Runs an agent's charter against frozen golden scenarios
// (canned tool responses injected via the kernel's tool-registry seam) and
// scores the structured outcome against expectations — required findings present,
// forbidden actions absent, proposal classes correct, and (the trap day) the
// correct behavior being to do nothing.
//
// Golden scenarios live in-repo per agent at agents/evals/<agent-key>/*.json.
// `deno task eval:agents` runs every suite (real model, frozen tools). The
// scoring + injection mechanics are pure/injectable so agent-eval_test.ts can
// exercise them deterministically with a scripted model step (no API call).
//
// A failing suite exits non-zero (CI gate) and emits an agent.eval.failed ops
// event; autonomy promotion (US-1608) consumes the per-agent pass state.

import {
  runAgent,
  type AgentOutcome,
  type AgentRow,
  type KernelDeps,
} from "./agent-kernel.ts";
import { charterFor, type AgentCharter } from "../agents/charters/index.ts";

// ── Scenario + expectation shapes (mirror the on-disk JSON) ──────────────────

export interface EvalExpectation {
  /** Substrings that must ALL appear in the JSON-serialized findings. */
  findingsInclude?: string[];
  /** Action classes the agent MUST propose (as a proposal OR a would_propose finding). */
  requireActionClasses?: string[];
  /** Action classes that must be ABSENT (forbidden actions). */
  forbidActionClasses?: string[];
  /** The trap day: the agent must take NO action at all (no proposal, no would_propose). */
  expectNoActions?: boolean;
}

export interface EvalScenario {
  /** Scenario key (unique within an agent). */
  key: string;
  /** Human description of the day this scenario models. */
  description: string;
  /** The run trigger label (default "eval"). */
  trigger?: string;
  /** Frozen tool responses by tool name — the injected registry returns these. */
  tools?: Record<string, unknown>;
  /** Autonomy grants (action-class → level) so intended actions surface as proposals. */
  autonomy?: Record<string, number>;
  /** What a correct run must (and must not) produce. */
  expect: EvalExpectation;
}

export interface ScenarioResult {
  scenario: string;
  passed: boolean;
  failures: string[];
}

export interface AgentEvalResult {
  agentKey: string;
  total: number;
  passed: number;
  results: ScenarioResult[];
}

// ── Scoring (pure) ───────────────────────────────────────────────────────────

function proposalClasses(outcome: AgentOutcome): string[] {
  const out: string[] = [];
  for (const p of outcome.proposals ?? []) {
    if (p && typeof p === "object") {
      const o = p as Record<string, unknown>;
      const c = o.action_class ?? o.actionClass;
      if (typeof c === "string" && c) out.push(c);
    }
  }
  return out;
}

/** would_propose findings are actions the agent WANTED but lacked autonomy for. */
function wouldProposeClasses(outcome: AgentOutcome): string[] {
  const out: string[] = [];
  for (const f of outcome.findings ?? []) {
    if (f && typeof f === "object") {
      const o = f as Record<string, unknown>;
      if (o.type === "would_propose") {
        const c = o.action_class ?? o.actionClass;
        if (typeof c === "string" && c) out.push(c);
      }
    }
  }
  return out;
}

/** All action classes the agent chose to take — filed proposals + would-propose. */
export function actionClasses(outcome: AgentOutcome): string[] {
  return [...proposalClasses(outcome), ...wouldProposeClasses(outcome)];
}

/** Substantive findings only (excludes the policy-injected would_propose entries). */
function substantiveFindings(outcome: AgentOutcome): unknown[] {
  return (outcome.findings ?? []).filter(
    (f) => !(f && typeof f === "object" && (f as Record<string, unknown>).type === "would_propose"),
  );
}

/** Score an outcome against a scenario's expectations. Pure — the eval unit test's core. */
export function scoreOutcome(
  outcome: AgentOutcome | null,
  expect: EvalExpectation,
): { passed: boolean; failures: string[] } {
  const failures: string[] = [];
  if (!outcome) return { passed: false, failures: ["agent produced no structured outcome"] };

  const findingsJson = JSON.stringify(substantiveFindings(outcome));
  for (const s of expect.findingsInclude ?? []) {
    if (!findingsJson.includes(s)) failures.push(`missing finding content: "${s}"`);
  }

  const taken = actionClasses(outcome);
  if (expect.expectNoActions && taken.length > 0) {
    failures.push(`expected NO actions but agent took: ${taken.join(", ")}`);
  }
  for (const c of expect.requireActionClasses ?? []) {
    if (!taken.includes(c)) failures.push(`missing required action class: ${c}`);
  }
  for (const c of expect.forbidActionClasses ?? []) {
    if (taken.includes(c)) failures.push(`forbidden action class present: ${c}`);
  }
  return { passed: failures.length === 0, failures };
}

// ── Injection: build kernel deps that freeze tools to the scenario ───────────

/** A synthetic AgentRow for the charter under eval, with the scenario's autonomy. */
function evalAgentRow(charter: AgentCharter, scenario: EvalScenario): AgentRow {
  const toolNames = Object.keys(scenario.tools ?? {});
  return {
    id: `eval-${charter.key}`,
    key: charter.key,
    name: `${charter.key} (eval)`,
    module_letter: null,
    status: "enabled",
    autonomy: { ...(scenario.autonomy ?? {}) },
    config: { tool_allowlist: toolNames },
  };
}

/**
 * Kernel deps for an eval run: the tool registry returns the scenario's FROZEN
 * responses, proposals/memory/handoffs are no-ops, and every side effect is
 * stubbed. `makeStep` is left to the caller — omit for the real model (the deno
 * task), or inject a scripted step for a deterministic unit test.
 */
export function buildEvalDeps(
  charter: AgentCharter,
  scenario: EvalScenario,
  makeStep?: KernelDeps["makeStep"],
): Partial<KernelDeps> {
  const agent = evalAgentRow(charter, scenario);
  const tools = scenario.tools ?? {};
  const deps: Partial<KernelDeps> = {
    loadAgent: () => Promise.resolve(agent),
    getGlobalPause: () => Promise.resolve(false),
    checkBudget: () => Promise.resolve({ exhausted: false, reason: null }),
    onBudgetBreach: () => Promise.resolve(),
    createRun: () => Promise.resolve(`eval-run-${scenario.key}`),
    recordStep: () => Promise.resolve(),
    finalizeRun: () => Promise.resolve(),
    persistProposals: (_a, _r, drafts) => Promise.resolve(drafts.length),
    notifyProposalsFiled: () => Promise.resolve(),
    emitEvent: () => {},
    loadMemory: () => Promise.resolve([]),
    persistMemory: () => Promise.resolve(),
    loadHandoffs: () => Promise.resolve([]),
    markHandoffsConsumed: () => Promise.resolve(),
    loadHandoffPolicy: () => Promise.resolve(null),
    deliverHandoff: () => Promise.resolve(),
    fileHandoffTask: () => Promise.resolve(),
    now: () => 0,
    toolRegistry: {
      anthropicTools: () =>
        Object.keys(tools).map((name) => ({
          name,
          description: `(eval) frozen tool ${name}`,
          input_schema: { type: "object", properties: {}, additionalProperties: true },
        })),
      isAllowed: (_a, name) => name in tools,
      execute: (_a, name) =>
        name in tools
          ? Promise.resolve(tools[name])
          : Promise.reject(new Error(`no frozen response for tool: ${name}`)),
    },
  };
  if (makeStep) deps.makeStep = makeStep;
  return deps;
}

// ── Runners ──────────────────────────────────────────────────────────────────

export async function runScenario(
  charter: AgentCharter,
  scenario: EvalScenario,
  makeStep?: KernelDeps["makeStep"],
): Promise<ScenarioResult> {
  const deps = buildEvalDeps(charter, scenario, makeStep);
  const result = await runAgent(charter.key, scenario.trigger ?? "eval", deps);
  const { passed, failures } = scoreOutcome(result.outcome, scenario.expect);
  return { scenario: scenario.key, passed, failures };
}

/** Load an agent's golden scenarios from agents/evals/<key>/*.json. */
export async function loadScenariosForAgent(agentKey: string): Promise<EvalScenario[]> {
  const dir = new URL(`../agents/evals/${agentKey}/`, import.meta.url);
  const scenarios: EvalScenario[] = [];
  let entries: AsyncIterable<Deno.DirEntry>;
  try {
    entries = Deno.readDir(dir);
  } catch {
    return scenarios; // no suite yet for this agent
  }
  for await (const entry of entries) {
    if (!entry.isFile || !entry.name.endsWith(".json")) continue;
    const text = await Deno.readTextFile(new URL(entry.name, dir));
    scenarios.push(JSON.parse(text) as EvalScenario);
  }
  scenarios.sort((a, b) => a.key.localeCompare(b.key));
  return scenarios;
}

export async function runAgentEval(
  agentKey: string,
  makeStep?: KernelDeps["makeStep"],
): Promise<AgentEvalResult> {
  const charter = charterFor(agentKey);
  if (!charter) throw new Error(`no charter registered for agent: ${agentKey}`);
  const scenarios = await loadScenariosForAgent(agentKey);
  const results: ScenarioResult[] = [];
  for (const s of scenarios) results.push(await runScenario(charter, s, makeStep));
  return {
    agentKey,
    total: results.length,
    passed: results.filter((r) => r.passed).length,
    results,
  };
}

export interface FleetEvalSummary {
  agents: Array<{ agentKey: string; passed: number; total: number; ok: boolean }>;
  /** agents.eval_pass shape consumed by the autonomy-promotion gate (US-1608). */
  passMap: Record<string, boolean>;
  failed: number;
}

/**
 * Run every agent's golden-scenario suite and summarize pass state. Pure
 * orchestration (no DB / no ops events — the cron route owns those side
 * effects), so it's unit-testable with an injected makeStep. An agent with a
 * suite that fully passes is `ok`; an agent with NO suite is ok:false
 * (conservative — an un-eval'd agent is never promoted).
 */
export async function runFleetEval(makeStep?: KernelDeps["makeStep"]): Promise<FleetEvalSummary> {
  const keys = await agentsWithSuites();
  const agents: FleetEvalSummary["agents"] = [];
  const passMap: Record<string, boolean> = {};
  let failed = 0;
  for (const key of keys) {
    const res = await runAgentEval(key, makeStep);
    const ok = res.total > 0 && res.passed === res.total;
    agents.push({ agentKey: key, passed: res.passed, total: res.total, ok });
    passMap[key] = ok;
    if (!ok) failed++;
  }
  return { agents, passMap, failed };
}

/** Every agent-key that has a golden-scenario suite on disk. */
export async function agentsWithSuites(): Promise<string[]> {
  const dir = new URL("../agents/evals/", import.meta.url);
  const keys: string[] = [];
  try {
    for await (const entry of Deno.readDir(dir)) {
      if (entry.isDirectory) keys.push(entry.name);
    }
  } catch {
    // no evals dir yet
  }
  keys.sort();
  return keys;
}

// ── CLI entrypoint (deno task eval:agents) ───────────────────────────────────

if (import.meta.main) {
  const only = Deno.args[0];
  const keys = only ? [only] : await agentsWithSuites();
  let failed = 0;
  let totalScenarios = 0;
  for (const key of keys) {
    const res = await runAgentEval(key);
    totalScenarios += res.total;
    const status = res.passed === res.total ? "PASS" : "FAIL";
    console.log(`[eval] ${key}: ${res.passed}/${res.total} ${status}`);
    for (const r of res.results) {
      if (!r.passed) {
        failed++;
        console.log(`  ✗ ${r.scenario}: ${r.failures.join("; ")}`);
      }
    }
  }
  console.log(`[eval] ${keys.length} agent(s), ${totalScenarios} scenario(s), ${failed} failure(s)`);
  if (failed > 0) Deno.exit(1);
}
