// US-1607: agent eval harness — scoring logic + injection mechanics. The kernel
// pulls in supabase.ts, so prime env then dynamic-import (mirrors
// agent-policy_test.ts). The model step is SCRIPTED — no API call.
import { assert, assertEquals } from "@std/assert";
import type { AgentOutcome, KernelDeps, KernelModelStep } from "../lib/agent-kernel.ts";
import type { EvalScenario } from "../lib/agent-eval.ts";

Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-key");
Deno.env.set("ANTHROPIC_API_KEY", Deno.env.get("ANTHROPIC_API_KEY") ?? "test-key");

const { scoreOutcome, actionClasses, runScenario, loadScenariosForAgent } = await import(
  "../lib/agent-eval.ts"
);
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
