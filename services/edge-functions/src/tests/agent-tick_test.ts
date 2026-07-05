// US-1588: agent scheduler tick — due-selection, per-tick budget deferral, and
// the global-pause no-op. Types erased; runtime values dynamic-imported after
// env prime (agent-tick.ts pulls in supabase.ts / the kernel).
import { assertEquals } from "@std/assert";
import type { AgentTickDeps, TickAgent } from "../lib/agent-tick.ts";

Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-key");
Deno.env.set("ANTHROPIC_API_KEY", Deno.env.get("ANTHROPIC_API_KEY") ?? "test-anthropic-key");
const { isAgentDue, parseScheduleMinutes, runAgentTick, selectDueAgents } = await import(
  "../lib/agent-tick.ts"
);

const NOW = 1_700_000_000_000;
const MIN = 60_000;

function tickAgent(key: string, schedule: string | undefined, lastRunMs: number | null): TickAgent {
  return { key, config: { schedule }, lastRunMs };
}

// ── Schedule parsing + due-ness ──────────────────────────────────────────────

Deno.test("parseScheduleMinutes: intervals, named, every-tick, defaults", () => {
  assertEquals(parseScheduleMinutes("30m"), 30);
  assertEquals(parseScheduleMinutes("2h"), 120);
  assertEquals(parseScheduleMinutes("1d"), 1440);
  assertEquals(parseScheduleMinutes("hourly"), 60);
  assertEquals(parseScheduleMinutes("daily"), 1440);
  assertEquals(parseScheduleMinutes("every-tick"), 0);
  assertEquals(parseScheduleMinutes(undefined), 60); // default
  assertEquals(parseScheduleMinutes("0 */6 * * *"), 60); // cron string → default
});

Deno.test("isAgentDue: never-run is due; elapsed-interval is due; else not", () => {
  assertEquals(isAgentDue("1h", null, NOW), true); // never ran
  assertEquals(isAgentDue("1h", NOW - 30 * MIN, NOW), false); // 30m < 1h
  assertEquals(isAgentDue("1h", NOW - 61 * MIN, NOW), true); // 61m ≥ 1h
  assertEquals(isAgentDue("every-tick", NOW - 1, NOW), true); // interval 0 → always
});

Deno.test("selectDueAgents: filters to the due subset, order preserved", () => {
  const agents = [
    tickAgent("a", "1h", NOW - 90 * MIN), // due
    tickAgent("b", "1h", NOW - 10 * MIN), // not due
    tickAgent("c", "daily", null), // never ran → due
  ];
  assertEquals(selectDueAgents(agents, NOW).map((a) => a.key), ["a", "c"]);
});

// ── Orchestration ────────────────────────────────────────────────────────────

function baseDeps(over: Partial<AgentTickDeps> = {}): {
  deps: Partial<AgentTickDeps>;
  ran: string[];
  expired: () => number;
} {
  const ran: string[] = [];
  let expiredCalls = 0;
  const deps: Partial<AgentTickDeps> = {
    isGloballyPaused: () => Promise.resolve(false),
    loadEnabledAgents: () => Promise.resolve([]),
    runAgent: (key) => {
      ran.push(key);
      return Promise.resolve({ status: "succeeded" });
    },
    expireProposals: () => {
      expiredCalls++;
      return Promise.resolve(2);
    },
    maybeCurateMemory: () => Promise.resolve(null),
    now: () => NOW,
    budgetMs: 8 * 60 * 1000,
    ...over,
  };
  return { deps, ran, expired: () => expiredCalls };
}

Deno.test("runAgentTick: global pause → a recorded no-op (no expiry, no runs)", async () => {
  const h = baseDeps({ isGloballyPaused: () => Promise.resolve(true) });
  const summary = await runAgentTick(h.deps);
  assertEquals(summary.paused, true);
  assertEquals(summary.ran, 0);
  assertEquals(h.ran.length, 0);
  assertEquals(h.expired(), 0); // short-circuited before expiry
});

Deno.test("runAgentTick: an unreadable pause switch is fail-closed", async () => {
  const h = baseDeps({ isGloballyPaused: () => Promise.reject(new Error("settings down")) });
  const summary = await runAgentTick(h.deps);
  assertEquals(summary.paused, true);
});

Deno.test("runAgentTick: runs due agents, expires proposals, records failures", async () => {
  const agents = [
    tickAgent("a", "1h", NOW - 90 * MIN), // due
    tickAgent("b", "1h", NOW - 5 * MIN), // not due
    tickAgent("c", "daily", null), // due
  ];
  const h = baseDeps({
    loadEnabledAgents: () => Promise.resolve(agents),
    runAgent: (key) => {
      if (key === "c") return Promise.resolve({ status: "failed" });
      return Promise.resolve({ status: "succeeded" });
    },
  });
  const s = await runAgentTick(h.deps);
  assertEquals(s.due, 2);
  assertEquals(s.ran, 2);
  assertEquals(s.deferred, 0);
  assertEquals(s.failed, 1); // c failed but the tick did not
  assertEquals(s.expiredProposals, 2);
});

Deno.test("runAgentTick: an agent-run THROW never fails the tick", async () => {
  const agents = [tickAgent("a", "every-tick", null), tickAgent("b", "every-tick", null)];
  const h = baseDeps({
    loadEnabledAgents: () => Promise.resolve(agents),
    runAgent: (key) => {
      if (key === "a") return Promise.reject(new Error("kernel exploded"));
      return Promise.resolve({ status: "succeeded" });
    },
  });
  const s = await runAgentTick(h.deps);
  assertEquals(s.ran, 2); // both attempted
  assertEquals(s.failed, 1); // the throw counted, not fatal
  assertEquals(s.results.find((r) => r.key === "a")?.status, "error");
});

Deno.test("runAgentTick: per-tick budget defers the leftover due agents", async () => {
  const agents = [
    tickAgent("a", "every-tick", null),
    tickAgent("b", "every-tick", null),
    tickAgent("c", "every-tick", null),
  ];
  // Clock returns 0,100,200,300,… ; start=call#2=100. i=0 check=200-100=100≤150 (run);
  // i=1 check=300-100=200>150 → defer the rest. So exactly 1 runs, 2 defer.
  let calls = 0;
  const h = baseDeps({
    loadEnabledAgents: () => Promise.resolve(agents),
    now: () => calls++ * 100,
    budgetMs: 150,
  });
  const s = await runAgentTick(h.deps);
  assertEquals(s.due, 3);
  assertEquals(s.ran, 1);
  assertEquals(s.deferred, 2); // recorded, not dropped
});
