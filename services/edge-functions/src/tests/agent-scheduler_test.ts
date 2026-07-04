// US-1588: the tick — due-selection semantics, per-tick budget deferral,
// and the pause no-op.
import { assert, assertEquals } from "@std/assert";

Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);
import type { SchedulableAgent, TickDeps } from "../lib/agent-scheduler.ts";
const { isAgentDue, runAgentTick } = await import("../lib/agent-scheduler.ts");

const NOW = new Date("2026-07-04T12:05:00Z");

function agent(config: Record<string, unknown>, key = "a"): SchedulableAgent {
  return { id: `id-${key}`, key, status: "enabled", config };
}

// ── Due selection ────────────────────────────────────────────────────────────

Deno.test("cron schedule: due when the next fire after the last start has passed", () => {
  const hourly = agent({ schedule: "0 * * * *" });
  // Last ran 11:00 → next fire 12:00 → 12:05 is due.
  assert(isAgentDue(hourly, "2026-07-04T11:00:00Z", NOW));
  // Last ran 12:01 → next fire 13:00 → not due yet.
  assert(!isAgentDue(hourly, "2026-07-04T12:01:00Z", NOW));
});

Deno.test("interval schedule: due after interval_minutes elapse", () => {
  const every30 = agent({ interval_minutes: 30 });
  assert(isAgentDue(every30, "2026-07-04T11:30:00Z", NOW)); // 35 min ago
  assert(!isAgentDue(every30, "2026-07-04T11:45:00Z", NOW)); // 20 min ago
});

Deno.test("a never-run agent WITH a cadence is due immediately", () => {
  assert(isAgentDue(agent({ schedule: "0 0 * * *" }), null, NOW));
  assert(isAgentDue(agent({ interval_minutes: 1440 }), null, NOW));
});

Deno.test("no schedule at all → never due (cadence is opt-in)", () => {
  assert(!isAgentDue(agent({}), null, NOW));
  assert(!isAgentDue(agent({}), "2020-01-01T00:00:00Z", NOW));
});

Deno.test("an unparseable cron expression is never due (not a crash)", () => {
  assert(!isAgentDue(agent({ schedule: "whenever" }), "2026-07-04T00:00:00Z", NOW));
});

// ── The tick ─────────────────────────────────────────────────────────────────

function tickDeps(
  agents: SchedulableAgent[],
  overrides: Partial<TickDeps> = {},
): Partial<TickDeps> {
  let clock = NOW.getTime();
  return {
    loadEnabledAgents: () => Promise.resolve(agents),
    loadLastStarts: () => Promise.resolve(new Map()),
    runAgent: (key) => Promise.resolve({ runId: `run-${key}`, status: "succeeded" as const }),
    sweepProposals: () => Promise.resolve(0),
    isPaused: () => Promise.resolve(false),
    now: () => clock,
    budgetMs: 8 * 60_000,
    ...overrides,
  };
}

Deno.test("tick runs every due agent sequentially and reports the tally", async () => {
  const agents = [
    agent({ interval_minutes: 5 }, "sentinel"),
    agent({ interval_minutes: 5 }, "finance"),
    agent({}, "no-cadence"), // never due
  ];
  const outcome = await runAgentTick(tickDeps(agents));
  assertEquals(outcome.paused, false);
  assertEquals(outcome.due, ["sentinel", "finance"]);
  assertEquals(outcome.ran.map((r) => r.agent), ["sentinel", "finance"]);
  assertEquals(outcome.deferred, []);
});

Deno.test("budget exhaustion defers the remainder — recorded, not dropped", async () => {
  const agents = [
    agent({ interval_minutes: 5 }, "one"),
    agent({ interval_minutes: 5 }, "two"),
    agent({ interval_minutes: 5 }, "three"),
  ];
  let clock = NOW.getTime();
  const outcome = await runAgentTick(tickDeps(agents, {
    now: () => clock,
    budgetMs: 1_000,
    runAgent: (key) => {
      clock += 700; // each run eats 700ms of the 1s budget
      return Promise.resolve({ runId: `run-${key}`, status: "succeeded" as const });
    },
  }));
  // one (0ms elapsed) and two (700ms) run; three (1400ms > budget) defers.
  assertEquals(outcome.ran.map((r) => r.agent), ["one", "two"]);
  assertEquals(outcome.deferred, ["three"]);
});

Deno.test("an individual run failure never fails the tick", async () => {
  const agents = [
    agent({ interval_minutes: 5 }, "flaky"),
    agent({ interval_minutes: 5 }, "steady"),
  ];
  const outcome = await runAgentTick(tickDeps(agents, {
    runAgent: (key) =>
      Promise.resolve({
        runId: null,
        status: key === "flaky" ? ("failed" as const) : ("succeeded" as const),
      }),
  }));
  assertEquals(outcome.ran, [
    { agent: "flaky", status: "failed" },
    { agent: "steady", status: "succeeded" },
  ]);
});

Deno.test("global pause makes the tick a recorded no-op (no loads, no runs)", async () => {
  let loaded = false;
  const outcome = await runAgentTick(tickDeps([], {
    isPaused: () => Promise.resolve(true),
    loadEnabledAgents: () => {
      loaded = true;
      return Promise.resolve([]);
    },
  }));
  assertEquals(outcome.paused, true);
  assertEquals(outcome.ran, []);
  assertEquals(loaded, false); // short-circuited before any work
});

Deno.test("the proposal-TTL sweep rides the tick and its failure is non-fatal", async () => {
  const outcome = await runAgentTick(tickDeps([agent({ interval_minutes: 5 }, "a")], {
    sweepProposals: () => Promise.resolve(3),
  }));
  assertEquals(outcome.expiredProposals, 3);

  const survived = await runAgentTick(tickDeps([agent({ interval_minutes: 5 }, "a")], {
    sweepProposals: () => Promise.reject(new Error("sweep db down")),
  }));
  assertEquals(survived.ran.length, 1); // the tick still ran its agents
});
