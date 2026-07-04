// US-1584: the kernel run loop against a fully mocked model + db — the five
// AC scenarios (happy path, step-cap kill, budget refusal, pause
// short-circuit, malformed output) plus redaction and output-contract edges.
import { assert, assertEquals } from "@std/assert";

// The kernel module pulls in supabaseAdmin at load; seed placeholder env so
// the import graph resolves (every db access in these tests is mocked).
Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);
// Type-only import erases at runtime; the VALUE import is dynamic so it
// evaluates AFTER the env seed above (static imports hoist above it).
import type {
  AgentTool,
  KernelDb,
  KernelDeps,
  ModelTurn,
} from "../lib/agent-kernel.ts";
const { capsFromConfig, parseAgentOutputText, runAgent, validateAgentOutput } =
  await import("../lib/agent-kernel.ts");

// ── Test doubles ─────────────────────────────────────────────────────────────

interface FakeState {
  agent: {
    id: string;
    key: string;
    status: string;
    config: Record<string, unknown>;
  } | null;
  runs: Array<{ id: string; row: Record<string, unknown> }>;
  updates: Array<{ id: string; patch: Record<string, unknown> }>;
  steps: Array<Record<string, unknown>>;
}

function fakeDb(state: FakeState): KernelDb {
  return {
    loadAgent: (key) =>
      Promise.resolve(state.agent && state.agent.key === key ? state.agent : null),
    insertRun: (row) => {
      const id = `run-${state.runs.length + 1}`;
      state.runs.push({ id, row });
      return Promise.resolve(id);
    },
    updateRun: (id, patch) => {
      state.updates.push({ id, patch });
      return Promise.resolve();
    },
    insertStep: (row) => {
      state.steps.push(row);
      return Promise.resolve();
    },
  };
}

function textTurn(text: string): ModelTurn {
  return {
    stopReason: "end_turn",
    content: [{ type: "text", text }],
    tokensIn: 100,
    tokensOut: 50,
    costUsd: 0.01,
  };
}

function toolTurn(name: string, input: Record<string, unknown>): ModelTurn {
  return {
    stopReason: "tool_use",
    content: [{ type: "tool_use", id: `tu-${name}`, name, input }],
    tokensIn: 100,
    tokensOut: 20,
    costUsd: 0.01,
  };
}

const GOOD_OUTPUT = JSON.stringify({
  summary: "All healthy.",
  findings: [{ kind: "ok" }],
  proposals: [],
});

function makeDeps(
  state: FakeState,
  turns: ModelTurn[],
  overrides: Partial<KernelDeps> = {},
): Partial<KernelDeps> {
  let turnIdx = 0;
  let clock = 1_000;
  return {
    db: fakeDb(state),
    callModel: () => {
      const turn = turns[Math.min(turnIdx, turns.length - 1)];
      turnIdx += 1;
      return Promise.resolve(turn);
    },
    isBudgetExhausted: () => Promise.resolve(false),
    isGloballyPaused: () => Promise.resolve(false),
    tools: {},
    now: () => (clock += 10),
    ...overrides,
  };
}

function agentRow(config: Record<string, unknown> = {}, status = "enabled") {
  return { id: "agent-1", key: "sentinel", status, config };
}

// ── Happy path ───────────────────────────────────────────────────────────────

Deno.test("happy path: tool round-trip then final output → succeeded, ordered steps", async () => {
  const state: FakeState = {
    agent: agentRow({ model: "test-model", tool_allowlist: ["read_metrics"] }),
    runs: [],
    updates: [],
    steps: [],
  };
  const tool: AgentTool = {
    name: "read_metrics",
    description: "Read ops metrics",
    inputSchema: { type: "object", properties: {} },
    run: () => Promise.resolve({ errorRate: 0.001 }),
  };
  const result = await runAgent(
    "sentinel",
    "schedule",
    makeDeps(state, [toolTurn("read_metrics", { window: "1h" }), textTurn(GOOD_OUTPUT)], {
      tools: { read_metrics: tool },
    }),
  );

  assertEquals(result.status, "succeeded");
  assertEquals(result.runId, "run-1");
  // Steps in order: model_call, tool_call, model_call, output — seq 1..4.
  assertEquals(
    state.steps.map((s) => [s.seq, s.step_type, s.name]),
    [
      [1, "model_call", "test-model"],
      [2, "tool_call", "read_metrics"],
      [3, "model_call", "test-model"],
      [4, "output", "final"],
    ].map(([a, b, c]) => [a, b, c]) as unknown as typeof state.steps extends never
      ? never
      : Array<[number, string, string]>,
  );
  const final = state.updates.at(-1)!.patch;
  assertEquals(final.status, "succeeded");
  assertEquals(final.tokens_in, 200);
  assertEquals(final.tokens_out, 70);
  assert((final.outcome as { summary: string }).summary === "All healthy.");
});

Deno.test("model defaults from config; allowlist filters unknown tools", async () => {
  const state: FakeState = {
    agent: agentRow({ model: "claude-haiku-4-5", tool_allowlist: ["ghost_tool"] }),
    runs: [],
    updates: [],
    steps: [],
  };
  const result = await runAgent(
    "sentinel",
    "manual",
    makeDeps(state, [textTurn(GOOD_OUTPUT)]),
  );
  assertEquals(result.status, "succeeded");
  assertEquals(state.steps[0].name, "claude-haiku-4-5"); // config model used
});

// ── Step cap ─────────────────────────────────────────────────────────────────

Deno.test("step-cap breach kills the loop as timeout with a partial outcome", async () => {
  const state: FakeState = {
    agent: agentRow({ max_steps: 3, tool_allowlist: ["spin"] }),
    runs: [],
    updates: [],
    steps: [],
  };
  const tool: AgentTool = {
    name: "spin",
    description: "always more work",
    inputSchema: { type: "object", properties: {} },
    run: () => Promise.resolve({ more: true }),
  };
  // The model NEVER finishes — every turn asks for the tool again.
  const result = await runAgent(
    "sentinel",
    "schedule",
    makeDeps(state, [toolTurn("spin", {})], { tools: { spin: tool } }),
  );
  assertEquals(result.status, "timeout");
  const final = state.updates.at(-1)!.patch;
  assertEquals(final.status, "timeout");
  const outcome = final.outcome as { partial: boolean; reason: string };
  assertEquals(outcome.partial, true);
  assert(outcome.reason.includes("step cap 3"));
});

Deno.test("wall-clock breach → timeout (never throws)", async () => {
  const state: FakeState = {
    agent: agentRow({ max_wall_clock_ms: 5, tool_allowlist: [] }),
    runs: [],
    updates: [],
    steps: [],
  };
  let clock = 0;
  const result = await runAgent(
    "sentinel",
    "schedule",
    makeDeps(state, [textTurn(GOOD_OUTPUT)], {
      now: () => (clock += 1_000), // each check jumps a second — instant breach
    }),
  );
  assertEquals(result.status, "timeout");
});

// ── Budget gate ──────────────────────────────────────────────────────────────

Deno.test("budget refusal ends the run cleanly as skipped, before any model call", async () => {
  const state: FakeState = {
    agent: agentRow({ budget_feature: "agents" }),
    runs: [],
    updates: [],
    steps: [],
  };
  let modelCalls = 0;
  const result = await runAgent(
    "sentinel",
    "schedule",
    makeDeps(state, [textTurn(GOOD_OUTPUT)], {
      isBudgetExhausted: (feature) => {
        assertEquals(feature, "agents");
        return Promise.resolve(true);
      },
      callModel: () => {
        modelCalls += 1;
        return Promise.resolve(textTurn(GOOD_OUTPUT));
      },
    }),
  );
  assertEquals(result.status, "skipped");
  assertEquals(modelCalls, 0); // the gate ran FIRST
  const final = state.updates.at(-1)!.patch;
  assert((final.outcome as { reason: string }).reason.includes("budget"));
});

// ── Pause short-circuits ─────────────────────────────────────────────────────

Deno.test("a paused agent short-circuits to a skipped run ROW (not silence)", async () => {
  const state: FakeState = {
    agent: agentRow({}, "paused"),
    runs: [],
    updates: [],
    steps: [],
  };
  const result = await runAgent("sentinel", "schedule", makeDeps(state, []));
  assertEquals(result.status, "skipped");
  assertEquals(state.runs.length, 1);
  assertEquals(state.runs[0].row.status, "skipped");
  assertEquals(
    (state.runs[0].row.outcome as { reason: string }).reason,
    "agent paused",
  );
});

Deno.test("the global agents.pause switch skips an ENABLED agent", async () => {
  const state: FakeState = { agent: agentRow(), runs: [], updates: [], steps: [] };
  const result = await runAgent(
    "sentinel",
    "schedule",
    makeDeps(state, [], { isGloballyPaused: () => Promise.resolve(true) }),
  );
  assertEquals(result.status, "skipped");
  assertEquals(
    (state.runs[0].row.outcome as { reason: string }).reason,
    "global agents.pause",
  );
});

// ── Output contract ──────────────────────────────────────────────────────────

Deno.test("malformed final output records failed with the contract violation", async () => {
  const state: FakeState = { agent: agentRow(), runs: [], updates: [], steps: [] };
  const result = await runAgent(
    "sentinel",
    "schedule",
    makeDeps(state, [textTurn("I checked everything and it looks fine!")]),
  );
  assertEquals(result.status, "failed");
  const final = state.updates.at(-1)!.patch;
  assert(String(final.error).includes("malformed"));
});

Deno.test("validateAgentOutput: the contract matrix", () => {
  assert(validateAgentOutput({ summary: "s", findings: [], proposals: [] }));
  assertEquals(validateAgentOutput({ summary: "", findings: [], proposals: [] }), null);
  assertEquals(validateAgentOutput({ summary: "s", findings: {} }), null);
  assertEquals(validateAgentOutput(null), null);
  assertEquals(validateAgentOutput([1]), null);
});

Deno.test("parseAgentOutputText: bare JSON and fenced JSON both parse", () => {
  assert(parseAgentOutputText(GOOD_OUTPUT));
  assert(parseAgentOutputText("```json\n" + GOOD_OUTPUT + "\n```"));
  assertEquals(parseAgentOutputText("nope"), null);
});

// ── Redaction ────────────────────────────────────────────────────────────────

Deno.test("step inputs/outputs pass through PII redaction before persisting", async () => {
  const state: FakeState = {
    agent: agentRow({ tool_allowlist: ["lookup"] }),
    runs: [],
    updates: [],
    steps: [],
  };
  const tool: AgentTool = {
    name: "lookup",
    description: "returns something with an email in it",
    inputSchema: { type: "object", properties: {} },
    run: () => Promise.resolve({ contact: "seller@example.com" }),
  };
  await runAgent(
    "sentinel",
    "schedule",
    makeDeps(
      state,
      [toolTurn("lookup", { email: "target@example.com" }), textTurn(GOOD_OUTPUT)],
      { tools: { lookup: tool } },
    ),
  );
  const toolStep = state.steps.find((s) => s.step_type === "tool_call")!;
  const recordedIn = JSON.stringify(toolStep.input);
  const recordedOut = JSON.stringify(toolStep.output);
  assert(!recordedIn.includes("target@example.com"), "input email leaked");
  assert(!recordedOut.includes("seller@example.com"), "output email leaked");
  assert(recordedIn.includes("[redacted:email]"));
});

// ── Off-allowlist tool request ───────────────────────────────────────────────

Deno.test("a model request for an unregistered tool is refused, not crashed", async () => {
  const state: FakeState = {
    agent: agentRow({ tool_allowlist: [] }),
    runs: [],
    updates: [],
    steps: [],
  };
  const result = await runAgent(
    "sentinel",
    "schedule",
    makeDeps(state, [toolTurn("rm_rf_prod", {}), textTurn(GOOD_OUTPUT)]),
  );
  assertEquals(result.status, "succeeded");
  const toolStep = state.steps.find((s) => s.step_type === "tool_call")!;
  assert(JSON.stringify(toolStep.output).includes("not on this agent"));
});

// ── Caps parsing ─────────────────────────────────────────────────────────────

Deno.test("capsFromConfig: defaults, clamping, garbage tolerance", () => {
  const dflt = capsFromConfig({});
  assertEquals(dflt.maxSteps, 24);
  assertEquals(dflt.maxWallClockMs, 300_000);
  const capped = capsFromConfig({ max_steps: 9_999, max_wall_clock_ms: -5 });
  assertEquals(capped.maxSteps, 100); // ceiling
  assertEquals(capped.maxWallClockMs, 1); // floor
  const garbage = capsFromConfig({ max_steps: "lots" });
  assertEquals(garbage.maxSteps, 24);
});

// ── Unknown agent ────────────────────────────────────────────────────────────

Deno.test("an unknown agent key fails without a run row and without throwing", async () => {
  const state: FakeState = { agent: null, runs: [], updates: [], steps: [] };
  const result = await runAgent("nope", "schedule", makeDeps(state, []));
  assertEquals(result.status, "failed");
  assertEquals(result.runId, null);
  assertEquals(state.runs.length, 0);
});
