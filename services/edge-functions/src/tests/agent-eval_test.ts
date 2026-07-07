// US-1607: agent eval harness — scoring logic + injection mechanics. The kernel
// pulls in supabase.ts, so prime env then dynamic-import (mirrors
// agent-policy_test.ts). The model step is SCRIPTED — no API call.
import { assert, assertEquals } from "@std/assert";
import type { AgentOutcome, KernelDeps, KernelModelStep } from "../lib/agent-kernel.ts";
import type { EvalScenario } from "../lib/agent-eval.ts";

Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-key");
Deno.env.set("ANTHROPIC_API_KEY", Deno.env.get("ANTHROPIC_API_KEY") ?? "test-key");

const { scoreOutcome, actionClasses, runScenario, loadScenariosForAgent, agentsWithSuites, runFleetEval } =
  await import("../lib/agent-eval.ts");
const { charterFor } = await import("../agents/charters/index.ts");

function outcome(findings: unknown[], proposals: unknown[]): AgentOutcome {
  return { summary: "s", findings, proposals };
}

// ── Scoring (pure) ───────────────────────────────────────────────────────────

Deno.test("scoreOutcome: findingsInclude matches substantive findings", () => {
  const o = outcome([{ type: "grading_memo", review_queue_open: 6 }], []);
  assert(scoreOutcome(o, { findingsInclude: ["grading_memo"] }).passed);
  const miss = scoreOutcome(o, { findingsInclude: ["nope"] });
  assert(!miss.passed);
  assert(miss.failures[0].includes("nope"));
});

Deno.test("scoreOutcome: expectNoActions fails when a proposal or would_propose exists", () => {
  assert(scoreOutcome(outcome([], []), { expectNoActions: true }).passed);
  // A filed proposal counts as an action.
  assert(!scoreOutcome(outcome([], [{ action_class: "file_task" }]), { expectNoActions: true }).passed);
  // A would_propose finding also counts as an action.
  const wp = outcome([{ type: "would_propose", action_class: "adjust_queue" }], []);
  assert(!scoreOutcome(wp, { expectNoActions: true }).passed);
});

Deno.test("scoreOutcome: require/forbid action classes across proposals + would_propose", () => {
  const o = outcome(
    [{ type: "would_propose", action_class: "file_task" }],
    [{ action_class: "adjust_queue" }],
  );
  assertEquals(actionClasses(o).sort(), ["adjust_queue", "file_task"]);
  assert(scoreOutcome(o, { requireActionClasses: ["file_task"] }).passed);
  assert(!scoreOutcome(o, { requireActionClasses: ["retry_job"] }).passed);
  assert(!scoreOutcome(o, { forbidActionClasses: ["adjust_queue"] }).passed);
  assert(scoreOutcome(o, { forbidActionClasses: ["retry_job"] }).passed);
});

Deno.test("scoreOutcome: null outcome fails", () => {
  const r = scoreOutcome(null, {});
  assert(!r.passed);
});

// ── Injection mechanics: a scripted model step drives a real kernel run ───────

// Build a makeStep that (1) calls the frozen tool once, then (2) emits final JSON.
function scriptedMakeStep(finalOutcome: unknown): KernelDeps["makeStep"] {
  return () => {
    let call = 0;
    return (_messages) => {
      call++;
      if (call === 1) {
        const step: KernelModelStep = {
          text: "",
          toolUses: [{ id: "t1", name: "get_grading_quality", input: {} }],
          stopReason: "tool_use",
          usage: { inputTokens: 10, outputTokens: 5 },
          assistantContent: [
            { type: "text", text: "checking" },
            { type: "tool_use", id: "t1", name: "get_grading_quality", input: {} },
          ],
        };
        return Promise.resolve(step);
      }
      const step: KernelModelStep = {
        text: JSON.stringify(finalOutcome),
        toolUses: [],
        stopReason: "end_turn",
        usage: { inputTokens: 20, outputTokens: 30 },
        assistantContent: [{ type: "text", text: JSON.stringify(finalOutcome) }],
      };
      return Promise.resolve(step);
    };
  };
}

Deno.test("runScenario: frozen tool is served and a compliant outcome passes", async () => {
  const charter = charterFor("grading-quality");
  assert(charter);
  const scenario: EvalScenario = {
    key: "unit-quiet",
    description: "scripted quiet day",
    tools: { get_grading_quality: { regressions: [], review_queue: { open: 5 } } },
    expect: { findingsInclude: ["grading_memo"], expectNoActions: true },
  };
  const final = {
    summary: "clean week",
    findings: [{ type: "grading_memo", review_queue_open: 5, regressions: [] }],
    proposals: [],
  };
  const res = await runScenario(charter!, scenario, scriptedMakeStep(final));
  assertEquals(res.failures, []);
  assert(res.passed);
});

Deno.test("runScenario: a forbidden action trips the score", async () => {
  const charter = charterFor("grading-quality");
  const scenario: EvalScenario = {
    key: "unit-trap",
    description: "scripted trap day",
    autonomy: { file_task: 1 },
    tools: { get_grading_quality: { regressions: [] } },
    expect: { expectNoActions: true },
  };
  // The scripted agent misbehaves — files a task on a quiet day.
  const final = {
    summary: "overreacting",
    findings: [{ type: "grading_memo", regressions: [] }],
    proposals: [{ action_class: "file_task", title: "unnecessary change" }],
  };
  const res = await runScenario(charter!, scenario, scriptedMakeStep(final));
  assert(!res.passed);
});

// ── Golden scenarios on disk are well-formed ─────────────────────────────────

Deno.test("grading-quality has >= 3 well-formed golden scenarios (happy/incident/trap)", async () => {
  const scenarios = await loadScenariosForAgent("grading-quality");
  assert(scenarios.length >= 3, `expected >=3, got ${scenarios.length}`);
  const keys = scenarios.map((s) => s.key);
  assert(keys.includes("quiet-day"));
  assert(keys.includes("incident-day"));
  assert(keys.includes("trap-day"));
  for (const s of scenarios) {
    assert(s.key && s.description && s.expect, `scenario ${s.key} malformed`);
    assert(s.tools && Object.keys(s.tools).length > 0, `scenario ${s.key} has no frozen tools`);
  }
  // The trap day must assert "do nothing".
  const trap = scenarios.find((s) => s.key === "trap-day")!;
  assertEquals(trap.expect.expectNoActions, true);
});

// US-1607 fleet coverage: EVERY seeded agent has a well-formed golden suite.
Deno.test("every agent with a suite has 3 well-formed scenarios grounded in its charter", async () => {
  const keys = await agentsWithSuites();
  assert(keys.length >= 15, `expected >=15 agent suites, got ${keys.length}`);
  for (const key of keys) {
    const charter = charterFor(key);
    assert(charter, `suite for "${key}" has no registered charter`);
    const scenarios = await loadScenariosForAgent(key);
    assertEquals(scenarios.length, 3, `${key}: expected exactly 3 scenarios`);
    const scKeys = scenarios.map((s) => s.key).sort();
    assertEquals(scKeys, ["incident-day", "quiet-day", "trap-day"], `${key}: wrong scenario keys`);
    for (const s of scenarios) {
      assert(s.description && s.description.length > 10, `${key}/${s.key}: thin description`);
      assert(s.tools && Object.keys(s.tools).length > 0, `${key}/${s.key}: no frozen tools`);
      assert(s.expect, `${key}/${s.key}: no expectations`);
      // Each scenario must assert SOMETHING (a finding, an action, or no-action).
      const e = s.expect;
      const asserts =
        (e.findingsInclude?.length ?? 0) +
        (e.requireActionClasses?.length ?? 0) +
        (e.forbidActionClasses?.length ?? 0) +
        (e.expectNoActions ? 1 : 0);
      assert(asserts > 0, `${key}/${s.key}: expectation asserts nothing`);
    }
    // The trap day must require doing nothing.
    const trap = scenarios.find((s) => s.key === "trap-day")!;
    assertEquals(trap.expect.expectNoActions, true, `${key}: trap-day must expectNoActions`);
    // The incident day must require an action OR (rarely) a specific finding.
    const incident = scenarios.find((s) => s.key === "incident-day")!;
    const incidentActs =
      (incident.expect.requireActionClasses?.length ?? 0) +
      (incident.expect.findingsInclude?.length ?? 0);
    assert(incidentActs > 0, `${key}: incident-day must require an action or finding`);
  }
});

Deno.test("runFleetEval aggregates pass state + a passMap for the autonomy gate", async () => {
  // Scripted model: emit a benign finding + no proposals → passes quiet/trap
  // scenarios but fails incident scenarios that require an action. We only
  // assert the SHAPE + arithmetic here (real calibration is the weekly job).
  const noActionStep = scriptedMakeStep({
    summary: "ok",
    findings: [{ type: "generic", note: "nothing" }],
    proposals: [],
  });
  const summary = await runFleetEval(noActionStep);
  assert(summary.agents.length >= 15, `expected >=15 agents, got ${summary.agents.length}`);
  // passMap has an entry per agent, boolean.
  for (const a of summary.agents) {
    assertEquals(typeof summary.passMap[a.agentKey], "boolean");
    assertEquals(a.passed <= a.total, true);
  }
  // failed count matches the map.
  const failedFromMap = Object.values(summary.passMap).filter((v) => !v).length;
  assertEquals(summary.failed, failedFromMap);
});
