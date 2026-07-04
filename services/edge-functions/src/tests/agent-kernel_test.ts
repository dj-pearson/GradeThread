// US-1584: agent kernel run loop. Drives runAgent with a mocked model client +
// injected deps — no Anthropic, no DB, no env. Covers the five required paths
// (happy, step-cap kill, budget refusal, pause short-circuit, malformed output)
// plus the pure helpers.
import { assert, assertEquals } from "@std/assert";
// Types are erased at compile time (side-effect-free), so importing them
// statically does NOT load agent-kernel.ts (which pulls in supabase.ts and
// throws without env). The runtime values are dynamic-imported AFTER the env is
// primed, mirroring google-play-rtdn_test.ts.
import type {
  AgentRow,
  KernelDeps,
  KernelModelStep,
  KernelStepFn,
  RunFinalize,
  StepRecord,
} from "../lib/agent-kernel.ts";

Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-key");
Deno.env.set("ANTHROPIC_API_KEY", Deno.env.get("ANTHROPIC_API_KEY") ?? "test-anthropic-key");
const { parseAgentOutcome, resolveAgentModel, resolveCaps, runAgent } = await import(
  "../lib/agent-kernel.ts"
);

const AGENT: AgentRow = {
  id: "agent-1",
  key: "sentinel",
  name: "Sentinel",
  module_letter: "H",
  status: "enabled",
  autonomy: {},
  config: {},
};

interface Harness {
  deps: Partial<KernelDeps>;
  steps: StepRecord[];
  finalized: RunFinalize[];
  stepCalls: () => number;
}

// Build injected deps around a supplied model step, with overridable edges.
function harness(
  step: KernelStepFn,
  over: Partial<KernelDeps> & { agent?: AgentRow } = {},
): Harness {
  const steps: StepRecord[] = [];
  const finalized: RunFinalize[] = [];
  let stepCalls = 0;
  const wrappedStep: KernelStepFn = (m) => {
    stepCalls++;
    return step(m);
  };
  let clock = 0;
  const deps: Partial<KernelDeps> = {
    loadAgent: () => Promise.resolve(over.agent ?? AGENT),
    getGlobalPause: over.getGlobalPause ?? (() => Promise.resolve(false)),
    isBudgetExhausted: over.isBudgetExhausted ?? (() => Promise.resolve(false)),
    createRun: over.createRun ?? (() => Promise.resolve("run-1")),
    recordStep: (_runId, s) => {
      steps.push(s);
      return Promise.resolve();
    },
    finalizeRun: (_runId, p) => {
      finalized.push(p);
      return Promise.resolve();
    },
    makeStep: over.makeStep ?? (() => wrappedStep),
    toolRegistry: over.toolRegistry ?? {
      anthropicTools: () => [],
      isAllowed: () => false,
      execute: () => Promise.reject(new Error("no tools")),
    },
    now: over.now ?? (() => (clock += 10)),
  };
  return { deps, steps, finalized, stepCalls: () => stepCalls };
}

function endTurn(text: string): KernelModelStep {
  return {
    text,
    toolUses: [],
    stopReason: "end_turn",
    usage: { inputTokens: 5, outputTokens: 7 },
    assistantContent: [],
  };
}

function toolTurn(): KernelModelStep {
  return {
    text: "",
    toolUses: [{ id: "tu_1", name: "some_tool", input: { q: 1 } }],
    stopReason: "tool_use",
    usage: { inputTokens: 3, outputTokens: 4 },
    assistantContent: [],
  };
}

// ── Happy path ───────────────────────────────────────────────────────────────

Deno.test("runAgent: happy path returns a validated outcome and succeeds", async () => {
  const h = harness(() =>
    Promise.resolve(endTurn('{"summary":"all clear","findings":[{"x":1}],"proposals":[]}'))
  );
  const res = await runAgent("sentinel", "cron", h.deps);
  assertEquals(res.status, "succeeded");
  assertEquals(res.outcome?.summary, "all clear");
  assertEquals(res.outcome?.findings.length, 1);
  assertEquals(res.tokensIn, 5);
  assertEquals(res.tokensOut, 7);
  assert(res.costUsd >= 0);
  // model_call + output steps recorded.
  assertEquals(h.steps.map((s) => s.stepType), ["model_call", "output"]);
  assertEquals(h.finalized.at(-1)?.status, "succeeded");
});

// ── Step-cap kill ────────────────────────────────────────────────────────────

Deno.test("runAgent: a tool-looping agent is killed at the step cap as 'timeout'", async () => {
  // Always asks for a tool; the empty registry errors each call, so it never
  // reaches a terminal turn — the step cap must stop it.
  const capped = { ...AGENT, config: { max_steps: 2 } };
  const h = harness(() => Promise.resolve(toolTurn()), { agent: capped });
  const res = await runAgent("sentinel", "cron", h.deps);
  assertEquals(res.status, "timeout");
  assertEquals(res.outcome?.reason, "max_steps_exceeded");
  assertEquals(res.outcome?.partial, true);
  // Exactly maxSteps model calls were made before the cap tripped.
  assertEquals(h.stepCalls(), 2);
});

// ── Budget refusal ───────────────────────────────────────────────────────────

Deno.test("runAgent: an exhausted budget skips cleanly before any model call", async () => {
  const h = harness(() => Promise.resolve(endTurn("{}")), {
    isBudgetExhausted: () => Promise.resolve(true),
  });
  const res = await runAgent("sentinel", "cron", h.deps);
  assertEquals(res.status, "skipped");
  assertEquals(res.outcome?.reason, "budget_exhausted");
  assertEquals(h.stepCalls(), 0); // never called the model
});

// ── Pause short-circuit ──────────────────────────────────────────────────────

Deno.test("runAgent: the global pause switch short-circuits to a skipped run", async () => {
  const h = harness(() => Promise.resolve(endTurn("{}")), {
    getGlobalPause: () => Promise.resolve(true),
  });
  const res = await runAgent("sentinel", "cron", h.deps);
  assertEquals(res.status, "skipped");
  assertEquals(res.outcome?.reason, "globally_paused");
  assertEquals(h.stepCalls(), 0);
  assert(res.runId !== null); // a run row was still created + finalized
});

Deno.test("runAgent: a paused agent status short-circuits to skipped", async () => {
  const paused = { ...AGENT, status: "paused" };
  const h = harness(() => Promise.resolve(endTurn("{}")), { agent: paused });
  const res = await runAgent("sentinel", "cron", h.deps);
  assertEquals(res.status, "skipped");
  assertEquals(res.outcome?.reason, "agent_paused");
});

Deno.test("runAgent: an unreadable pause switch is fail-closed (treated as paused)", async () => {
  const h = harness(() => Promise.resolve(endTurn("{}")), {
    getGlobalPause: () => Promise.reject(new Error("settings down")),
  });
  const res = await runAgent("sentinel", "cron", h.deps);
  assertEquals(res.status, "skipped");
  assertEquals(res.outcome?.reason, "globally_paused");
});

// ── Malformed output ─────────────────────────────────────────────────────────

Deno.test("runAgent: malformed final output records status 'failed'", async () => {
  const h = harness(() => Promise.resolve(endTurn("I could not produce JSON, sorry.")));
  const res = await runAgent("sentinel", "cron", h.deps);
  assertEquals(res.status, "failed");
  assert((h.finalized.at(-1)?.error ?? "").startsWith("malformed output"));
  assertEquals(res.outcome, null);
});

Deno.test("runAgent: a missing agent is a no-op skip with no run row", async () => {
  const h = harness(() => Promise.resolve(endTurn("{}")), {});
  const res = await runAgent("ghost", "cron", { ...h.deps, loadAgent: () => Promise.resolve(null) });
  assertEquals(res.status, "skipped");
  assertEquals(res.reason, "agent_not_found");
  assertEquals(res.runId, null);
});

// ── Pure helpers ─────────────────────────────────────────────────────────────

Deno.test("resolveCaps: defaults + config overrides + garbage floors", () => {
  assertEquals(resolveCaps({}), {
    maxSteps: 24,
    maxOutputTokens: 2048,
    maxWallClockMs: 300000,
  });
  assertEquals(resolveCaps({ max_steps: 5, max_output_tokens: 100, max_wall_clock_ms: 1000 }), {
    maxSteps: 5,
    maxOutputTokens: 100,
    maxWallClockMs: 1000,
  });
  // Garbage / non-positive falls back to defaults.
  assertEquals(resolveCaps({ max_steps: 0, max_output_tokens: -1 as unknown as number }).maxSteps, 24);
});

Deno.test("resolveAgentModel: allowlisted passes through; unknown falls back", () => {
  assertEquals(resolveAgentModel({ model: "claude-opus-4-8" }), "claude-opus-4-8");
  // Unknown model → platform default (not the untrusted string).
  assertEquals(resolveAgentModel({ model: "evil-model" }) !== "evil-model", true);
  assertEquals(resolveAgentModel({}) !== "", true);
});

Deno.test("parseAgentOutcome: valid, fenced, prose-wrapped, and invalid", () => {
  assertEquals(parseAgentOutcome('{"summary":"s","findings":[],"proposals":[]}').ok, true);
  // ```json fence + prose around it.
  const fenced = 'Here is my report:\n```json\n{"summary":"s","findings":[],"proposals":[]}\n```';
  assertEquals(parseAgentOutcome(fenced).ok, true);
  // Missing/typed-wrong fields fail.
  assertEquals(parseAgentOutcome('{"summary":"s","findings":{},"proposals":[]}').ok, false);
  assertEquals(parseAgentOutcome('{"findings":[],"proposals":[]}').ok, false);
  assertEquals(parseAgentOutcome("not json at all").ok, false);
});
