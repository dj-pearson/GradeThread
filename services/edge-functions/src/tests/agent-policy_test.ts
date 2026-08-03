// US-1586: agent policy engine — the autonomy ladder, kill-switch precedence,
// and demotion. Types are erased; runtime values dynamic-imported after the env
// is primed (agent-policy.ts pulls in supabase.ts). Mirrors agent-kernel_test.ts.
import { assert, assertEquals } from "@std/assert";
import type { AgentRow } from "../lib/agent-kernel.ts";
import type { PolicyDeps, AutonomyLevel } from "../lib/agent-policy.ts";

Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-key");
const {
  applyWritePolicy,
  dispatchWriteIntent,
  recordPolicyBreach,
  resolveAutonomy,
  resolveHalt,
} = await import("../lib/agent-policy.ts");

function mk(autonomy: Record<string, unknown>, status = "enabled"): AgentRow {
  return {
    id: "a1",
    key: "sentinel",
    name: "Sentinel",
    module_letter: "H",
    status,
    autonomy,
    config: {},
  };
}

const intent = { actionClass: "retry_job", title: "Retry billing-reconciliation" };

// ── Ladder resolution + default ──────────────────────────────────────────────

Deno.test("resolveAutonomy: default L0, reads grant, clamps out-of-range", () => {
  assertEquals(resolveAutonomy(mk({}), "retry_job"), 0); // ungranted → L0
  assertEquals(resolveAutonomy(mk({ retry_job: 2 }), "retry_job"), 2);
  assertEquals(resolveAutonomy(mk({ retry_job: 9 }), "retry_job"), 3); // clamp high
  assertEquals(resolveAutonomy(mk({ retry_job: -1 }), "retry_job"), 0); // clamp low
  assertEquals(resolveAutonomy(mk({ retry_job: "nonsense" }), "retry_job"), 0); // garbage → L0
});

// US-1597: the Trust & Safety account-action HARD CAP — L1 forever, regardless
// of what the autonomy config (or a future promotion) grants.
Deno.test("resolveAutonomy: trust-safety account actions are hard-capped at L1", () => {
  const ts = (autonomy: Record<string, unknown>): AgentRow => ({ ...mk(autonomy), key: "trust-safety" });
  for (const cls of ["suspend_account", "require_step_up", "deny_claim"]) {
    assertEquals(resolveAutonomy(ts({ [cls]: 3 }), cls), 1); // L3 config → clamped to L1
    assertEquals(resolveAutonomy(ts({ [cls]: 2 }), cls), 1); // L2 → L1
    assertEquals(resolveAutonomy(ts({ [cls]: 1 }), cls), 1); // L1 stays L1
    assertEquals(resolveAutonomy(ts({}), cls), 0); // ungranted still L0 (cap is a ceiling)
  }
  // The cap is agent-specific: another agent with the same class is NOT capped.
  assertEquals(resolveAutonomy(mk({ suspend_account: 3 }), "suspend_account"), 3); // sentinel, uncapped
});

// ── Dispatch by level ────────────────────────────────────────────────────────

Deno.test("dispatchWriteIntent: L0 drops to a would_propose finding", () => {
  const r = dispatchWriteIntent(mk({}), intent, { paused: false });
  assertEquals(r.disposition, "dropped");
  assert(r.disposition === "dropped" && r.finding.reason === "L0_observe");
});

Deno.test("dispatchWriteIntent: L1 becomes a pending proposal (no note)", () => {
  const r = dispatchWriteIntent(mk({ retry_job: 1 }), intent, { paused: false });
  assert(r.disposition === "proposal");
  assertEquals(r.proposal.status, "pending");
  assertEquals(r.note, null);
  assertEquals(r.proposal.policy.would_execute, false);
});

Deno.test("dispatchWriteIntent: L2/L3 proposal carries the deferred-execution note", () => {
  const r = dispatchWriteIntent(mk({ retry_job: 3 }), intent, { paused: false });
  assert(r.disposition === "proposal");
  assert((r.note ?? "").includes("deferred"));
  assertEquals(r.proposal.policy.would_execute, true);
});

Deno.test("dispatchWriteIntent: global pause takes precedence over an L3 grant", () => {
  // Even a fully-trusted (L3), enabled agent is dropped when globally paused.
  const r = dispatchWriteIntent(mk({ retry_job: 3 }, "enabled"), intent, { paused: true });
  assertEquals(r.disposition, "dropped");
  assert(r.disposition === "dropped" && r.finding.reason === "paused");
});

Deno.test("dispatchWriteIntent: a per-agent paused status also drops", () => {
  const r = dispatchWriteIntent(mk({ retry_job: 3 }, "paused"), intent, { paused: false });
  assertEquals(r.disposition, "dropped");
});

// ── Kill-switch resolution ───────────────────────────────────────────────────

Deno.test("resolveHalt: global pause beats per-agent state; enabled+no-global runs", () => {
  assertEquals(resolveHalt(mk({}, "enabled"), true), { halted: true, reason: "globally_paused" });
  assertEquals(resolveHalt(mk({}, "paused"), false), { halted: true, reason: "agent_paused" });
  assertEquals(resolveHalt(mk({}, "enabled"), false), { halted: false, reason: null });
  // Global precedence even when the agent itself is also paused.
  assertEquals(resolveHalt(mk({}, "paused"), true).reason, "globally_paused");
});

// ── applyWritePolicy (kernel hook) ───────────────────────────────────────────

Deno.test("applyWritePolicy: L0 proposals → findings; L1 kept; invalid surfaced", () => {
  const agent = mk({ retry_job: 1 }); // L1 for retry_job, L0 for everything else
  const outcome = {
    findings: ["pre-existing"],
    proposals: [
      { action_class: "retry_job", title: "retry X" }, // L1 → kept
      { action_class: "file_task", title: "file Y" }, // L0 → finding
      { title: "missing action_class" }, // invalid → finding
    ],
  };
  const routed = applyWritePolicy(agent, outcome, { paused: false });
  assertEquals(routed.proposals.length, 1);
  assertEquals(routed.proposals[0].action_class, "retry_job");
  // original 1 finding + L0 drop + invalid = 3
  assertEquals(routed.findings.length, 3);
});

Deno.test("applyWritePolicy: when paused, even an L2 proposal is dropped to a finding", () => {
  const agent = mk({ retry_job: 2 });
  const routed = applyWritePolicy(
    agent,
    { findings: [], proposals: [{ action_class: "retry_job", title: "retry" }] },
    { paused: true },
  );
  assertEquals(routed.proposals.length, 0);
  assertEquals(routed.findings.length, 1);
});

// ── Demotion (floor at L0) ───────────────────────────────────────────────────

function capturingDeps(): {
  deps: Partial<PolicyDeps>;
  saved: Array<Record<string, unknown>>;
  events: string[];
  paused: string[];
} {
  const saved: Array<Record<string, unknown>> = [];
  const events: string[] = [];
  const paused: string[] = [];
  const deps: Partial<PolicyDeps> = {
    loadAutonomy: () => Promise.resolve({}),
    saveAutonomy: (_id, autonomy) => {
      saved.push(autonomy);
      return Promise.resolve();
    },
    emitBreachEvent: (_agent, actionClass) => {
      events.push(actionClass);
      return Promise.resolve();
    },
    pauseAgent: (id, reason) => {
      paused.push(`${id}:${reason}`);
      return Promise.resolve();
    },
  };
  return { deps, saved, events, paused };
}

Deno.test("recordPolicyBreach: demotes one level and persists + emits", async () => {
  const agent = mk({ retry_job: 2 });
  const cap = capturingDeps();
  // loadAutonomy returns fresh copy so the class is preserved.
  cap.deps.loadAutonomy = () => Promise.resolve({ retry_job: 2 });
  const res = await recordPolicyBreach(agent, "retry_job", "test", cap.deps);
  assertEquals(res, {
    from: 2 as AutonomyLevel,
    to: 1 as AutonomyLevel,
    applied: true,
    halted: false,
  });
  assertEquals(cap.saved.at(-1)?.retry_job, 1);
  assertEquals(cap.events, ["retry_job"]); // a warning event was emitted
  assertEquals(cap.paused, []); // nothing to escalate — the demotion landed
});

Deno.test("recordPolicyBreach: floors at L0 (an already-L0 class stays L0)", async () => {
  const agent = mk({ retry_job: 0 });
  const cap = capturingDeps();
  const res = await recordPolicyBreach(agent, "retry_job", "test", cap.deps);
  assertEquals(res, {
    from: 0 as AutonomyLevel,
    to: 0 as AutonomyLevel,
    applied: true,
    halted: false,
  });
  assertEquals(cap.saved.at(-1)?.retry_job, 0);
});

// ── US-2364: a demotion that does not stick ─────────────────────────────────
//
// The old code was `saveAutonomy(...).catch(() => {})`. An agent that had just
// breached policy stayed at the level it abused, and nothing anywhere recorded
// that the demotion had not happened — the system reported a demotion, the
// operator believed the agent was contained, and it kept its privileges.
//
// Two layers were wrong. The visible one was the empty catch. The deeper one was
// in prodPolicyDeps: supabase-js resolves with `{ data, error }` rather than
// rejecting, and `saveAutonomy` never read `error`, so a refused write returned
// normally and the catch had nothing to catch in the first place.

Deno.test("US-2364: a save failure is retried before it is treated as a failure", async () => {
  const cap = capturingDeps();
  let attempts = 0;
  cap.deps.loadAutonomy = () => Promise.resolve({ retry_job: 2 });
  cap.deps.saveAutonomy = (_id, autonomy) => {
    attempts++;
    if (attempts < 3) return Promise.reject(new Error("transient"));
    cap.saved.push(autonomy);
    return Promise.resolve();
  };
  const res = await recordPolicyBreach(mk({ retry_job: 2 }), "retry_job", "t", cap.deps);
  assertEquals(attempts, 3);
  assertEquals(res.applied, true);
  assertEquals(res.halted, false);
  assertEquals(cap.saved.at(-1)?.retry_job, 1);
  assertEquals(cap.paused, []); // it landed, so nothing is escalated
});

Deno.test("US-2364: a demotion that cannot be persisted PAUSES the agent", async () => {
  // The escalation, and the whole point. An agent that cannot be demoted after a
  // breach is more dangerous than one that is stopped, so it is stopped —
  // resolveHalt already treats status "paused" as halted.
  const cap = capturingDeps();
  cap.deps.saveAutonomy = () => Promise.reject(new Error("rls denied"));
  const res = await recordPolicyBreach(mk({ retry_job: 2 }), "retry_job", "t", cap.deps);
  assertEquals(res.applied, false);
  assertEquals(res.halted, true);
  assertEquals(res.from, 2 as AutonomyLevel);
  assertEquals(cap.paused, ["a1:demotion_failed:retry_job"]);
  assertEquals(cap.saved, []); // nothing was written
});

Deno.test("US-2364: the breach event is emitted even when the demotion fails", async () => {
  // A breach happened whether or not its consequence could be recorded. Dropping
  // the event on the failure path would lose the only trace of the breach at the
  // exact moment the demotion also went missing.
  const cap = capturingDeps();
  cap.deps.saveAutonomy = () => Promise.reject(new Error("nope"));
  await recordPolicyBreach(mk({ retry_job: 2 }), "retry_job", "t", cap.deps);
  assertEquals(cap.events, ["retry_job"]);
});

Deno.test("US-2364: a failed pause still reports, and does not throw", async () => {
  // Worst case: the demotion failed AND the agent could not be paused. The agent
  // is running at the level it abused, so the one thing that must not happen is
  // a silent return — but throwing is no good either, since every caller treats
  // this as fire-and-forget and would swallow it.
  const cap = capturingDeps();
  cap.deps.saveAutonomy = () => Promise.reject(new Error("nope"));
  cap.deps.pauseAgent = () => Promise.reject(new Error("also nope"));
  const res = await recordPolicyBreach(mk({ retry_job: 2 }), "retry_job", "t", cap.deps);
  assertEquals(res.applied, false);
  assertEquals(res.halted, false); // still running, and the result says so
});

Deno.test("US-2364: prodPolicyDeps.saveAutonomy reads the error rather than the promise", async () => {
  // The deeper half of the bug, pinned by source: supabase-js RESOLVES on a
  // refused write. A saveAutonomy that awaits the builder and ignores `error`
  // can never reject, so every retry and escalation above would be unreachable.
  const src = await Deno.readTextFile(new URL("../lib/agent-policy.ts", import.meta.url));
  const at = src.indexOf("saveAutonomy: async (agentId, autonomy) => {");
  assert(at > -1, "prodPolicyDeps.saveAutonomy was renamed");
  const body = src.slice(at, at + 600);
  assert(body.includes("const { error }"), "saveAutonomy ignores the error again");
  assert(body.includes("throw"), "saveAutonomy reads the error but does not throw");
});
