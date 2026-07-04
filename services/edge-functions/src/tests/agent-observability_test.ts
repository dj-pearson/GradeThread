// US-1589: the agent.* event emission points — run started/finished/failed/
// timeout from the kernel, proposal created/approved/rejected/executed from
// the policy + lifecycle. All against injected emitters.
import { assert, assertEquals } from "@std/assert";

Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);
import type { KernelDeps, ModelTurn } from "../lib/agent-kernel.ts";
import type { PolicyDb } from "../lib/agent-policy.ts";
import type { ProposalDb } from "../lib/agent-proposals.ts";
const { runAgent } = await import("../lib/agent-kernel.ts");
const { dispatchWriteIntent } = await import("../lib/agent-policy.ts");
const { executeProposal, rejectProposal } = await import("../lib/agent-proposals.ts");

interface Emitted {
  type: string;
  severity: string;
  title: string;
  data?: Record<string, unknown>;
}

function collector(events: Emitted[]) {
  return (
    type: string,
    severity: string,
    payload: { title: string; data?: Record<string, unknown> },
  ) => {
    events.push({ type, severity, title: payload.title, data: payload.data });
    return Promise.resolve();
  };
}

// ── Kernel run events ────────────────────────────────────────────────────────

const GOOD = JSON.stringify({ summary: "ok", findings: [], proposals: [] });

function kernelDeps(
  events: Emitted[],
  turns: ModelTurn[],
  agentStatus = "enabled",
): Partial<KernelDeps> {
  let i = 0;
  let clock = 0;
  return {
    db: {
      loadAgent: () =>
        Promise.resolve({ id: "a1", key: "sentinel", status: agentStatus, config: {} }),
      insertRun: () => Promise.resolve("run-1"),
      updateRun: () => Promise.resolve(),
      insertStep: () => Promise.resolve(),
    },
    callModel: () => Promise.resolve(turns[Math.min(i++, turns.length - 1)]),
    isBudgetExhausted: () => Promise.resolve(false),
    isGloballyPaused: () => Promise.resolve(false),
    tools: {},
    now: () => (clock += 10),
    emitEvent: collector(events) as KernelDeps["emitEvent"],
    fileProposals: () => Promise.resolve({ filed: 0, dropped: 0, skipped: 0 }),
  };
}

Deno.test("a succeeded run emits started + finished with agent/duration/cost", async () => {
  const events: Emitted[] = [];
  await runAgent("sentinel", "schedule", kernelDeps(events, [{
    stopReason: "end_turn",
    content: [{ type: "text", text: GOOD }],
    tokensIn: 10,
    tokensOut: 5,
    costUsd: 0.02,
  }]));
  assertEquals(events.map((e) => e.type), [
    "agent.run.started",
    "agent.run.finished",
  ]);
  assertEquals(events[1].severity, "info");
  assertEquals(events[1].data?.agent, "sentinel");
  assert(typeof events[1].data?.duration_ms === "number");
  assert(typeof events[1].data?.cost_usd === "number");
});

Deno.test("a malformed-output run emits agent.run.failed as a warning", async () => {
  const events: Emitted[] = [];
  await runAgent("sentinel", "schedule", kernelDeps(events, [{
    stopReason: "end_turn",
    content: [{ type: "text", text: "just words" }],
    tokensIn: 1,
    tokensOut: 1,
    costUsd: 0,
  }]));
  assertEquals(events.at(-1)!.type, "agent.run.failed");
  assertEquals(events.at(-1)!.severity, "warning");
});

Deno.test("a step-cap breach emits agent.run.timeout", async () => {
  const events: Emitted[] = [];
  const deps = kernelDeps(events, [{
    stopReason: "tool_use",
    content: [{ type: "tool_use", id: "t", name: "spin", input: {} }],
    tokensIn: 1,
    tokensOut: 1,
    costUsd: 0,
  }]);
  (deps.db!.loadAgent as unknown) = () =>
    Promise.resolve({
      id: "a1",
      key: "sentinel",
      status: "enabled",
      config: { max_steps: 2 },
    });
  await runAgent("sentinel", "schedule", deps);
  assertEquals(events.at(-1)!.type, "agent.run.timeout");
});

Deno.test("a skipped (paused) run emits NO terminal event — the ledger row suffices", async () => {
  const events: Emitted[] = [];
  await runAgent(
    "sentinel",
    "schedule",
    kernelDeps(events, [], "paused"),
  );
  assertEquals(events.length, 0);
});

// ── Proposal events ──────────────────────────────────────────────────────────

const policyDb: PolicyDb = {
  readSetting: () => Promise.resolve(undefined),
  upsertProposal: () => Promise.resolve("prop-1"),
  persistAutonomy: () => Promise.resolve(),
};

Deno.test("filing a proposal emits agent.proposal.created", async () => {
  const events: Emitted[] = [];
  await dispatchWriteIntent(
    { id: "a1", key: "sentinel", status: "enabled", autonomy: { retry_job: 1 } },
    {
      actionClass: "retry_job",
      title: "Retry X",
      summary: "s",
      payload: {},
    },
    policyDb,
    collector(events) as never,
  );
  assertEquals(events[0].type, "agent.proposal.created");
  assertEquals(events[0].data?.action_class, "retry_job");
});

function lifecycleDb(row: Record<string, unknown> | null): ProposalDb {
  return {
    claimForExecution: () => Promise.resolve(row),
    markExecuted: () => Promise.resolve(),
    rejectPending: () => Promise.resolve(true),
    expirePending: () => Promise.resolve(0),
  };
}

Deno.test("approval emits approved then executed", async () => {
  const events: Emitted[] = [];
  // deno-lint-ignore no-explicit-any
  const chain: any = {
    from: () => chain,
    update: () => chain,
    eq: () => chain,
    in: () => chain,
    select: () => chain,
    maybeSingle: () => Promise.resolve({ data: { id: "dl-1" }, error: null }),
  };
  await executeProposal(
    "p1",
    "admin-1",
    lifecycleDb({
      id: "p1",
      action_class: "requeue_dead_letter",
      payload: { tool: "requeue_dead_letter", args: { id: "dl-1" } },
      expires_at: "2099-01-01T00:00:00Z",
      agents: { key: "sentinel" },
    }),
    chain,
    () => new Date("2026-07-04T00:00:00Z"),
    collector(events) as never,
  );
  assertEquals(events.map((e) => e.type), [
    "agent.proposal.approved",
    "agent.proposal.executed",
  ]);
});

Deno.test("rejection emits agent.proposal.rejected with the redacted reason", async () => {
  const events: Emitted[] = [];
  await rejectProposal(
    "p1",
    "admin-1",
    "contact seller@example.com first",
    lifecycleDb(null),
    () => new Date(),
    collector(events) as never,
  );
  assertEquals(events[0].type, "agent.proposal.rejected");
  assert(!events[0].title.includes("seller@example.com")); // redacted
  assert(events[0].title.includes("[redacted:email]"));
});
