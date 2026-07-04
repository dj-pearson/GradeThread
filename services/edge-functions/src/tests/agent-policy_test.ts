// US-1586: the autonomy ladder — resolution + defaults, kill-switch
// precedence, write-intent dispatch per level, and breach demotion.
import { assert, assertEquals } from "@std/assert";

Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);
import type { PolicyAgent, PolicyDb } from "../lib/agent-policy.ts";
const {
  ACTION_CLASSES,
  dispatchWriteIntent,
  isExecutionHalted,
  isGlobalAgentPause,
  recordPolicyBreach,
  resolveAutonomy,
} = await import("../lib/agent-policy.ts");

function agent(
  autonomy: Record<string, unknown> | null = null,
  status = "enabled",
): PolicyAgent {
  return { id: "a1", key: "sentinel", status, autonomy };
}

interface FakeState {
  settings: Record<string, unknown>;
  settingsThrow?: boolean;
  proposals: Array<Record<string, unknown>>;
  autonomyWrites: Array<{ agentId: string; autonomy: Record<string, unknown> }>;
}

function fakeDb(state: FakeState): PolicyDb {
  return {
    readSetting(key) {
      if (state.settingsThrow) return Promise.reject(new Error("db down"));
      return Promise.resolve(state.settings[key]);
    },
    upsertProposal(row) {
      state.proposals.push(row);
      return Promise.resolve(`prop-${state.proposals.length}`);
    },
    persistAutonomy(agentId, autonomy) {
      state.autonomyWrites.push({ agentId, autonomy });
      return Promise.resolve();
    },
  };
}

const INTENT = {
  actionClass: "retry_job",
  title: "Retry the payout sync job",
  summary: "3 consecutive failures with the same transient error.",
  payload: { tool: "retry_job", args: { job: "payout-sync" } },
};

// ── Ladder resolution ────────────────────────────────────────────────────────

Deno.test("resolveAutonomy: numbers, L-strings, defaults, garbage", () => {
  assertEquals(resolveAutonomy(agent({ retry_job: 2 }), "retry_job"), 2);
  assertEquals(resolveAutonomy(agent({ retry_job: "L3" }), "retry_job"), 3);
  assertEquals(resolveAutonomy(agent({ retry_job: "1" }), "retry_job"), 1);
  // Unknown class, missing map, malformed values → ALWAYS L0.
  assertEquals(resolveAutonomy(agent({ retry_job: 2 }), "draft_reply"), 0);
  assertEquals(resolveAutonomy(agent(null), "retry_job"), 0);
  assertEquals(resolveAutonomy(agent({ retry_job: "yes" }), "retry_job"), 0);
  assertEquals(resolveAutonomy(agent({ retry_job: 7 }), "retry_job"), 0);
  assertEquals(resolveAutonomy(agent({ retry_job: -1 }), "retry_job"), 0);
});

Deno.test("the action-class taxonomy carries the six charter classes", () => {
  for (
    const cls of [
      "file_task",
      "retry_job",
      "requeue_dead_letter",
      "draft_reply",
      "adjust_queue",
      "run_playbook",
    ]
  ) {
    assert((ACTION_CLASSES as readonly string[]).includes(cls), cls);
  }
});

// ── Kill switches ────────────────────────────────────────────────────────────

Deno.test("global pause halts even an ENABLED agent (precedence)", async () => {
  const db = fakeDb({ settings: { "agents.pause": true }, proposals: [], autonomyWrites: [] });
  assert(await isExecutionHalted(agent({ retry_job: 3 }), db));
  const outcome = await dispatchWriteIntent(agent({ retry_job: 3 }), INTENT, db);
  assertEquals(outcome.kind, "halted");
});

Deno.test("per-agent pause halts without consulting the global switch", async () => {
  const db = fakeDb({ settings: {}, proposals: [], autonomyWrites: [] });
  assert(await isExecutionHalted(agent({}, "paused"), db));
});

Deno.test("a settings read FAILURE halts (fail-closed); a missing row runs", async () => {
  const broken = fakeDb({
    settings: {},
    settingsThrow: true,
    proposals: [],
    autonomyWrites: [],
  });
  assertEquals(await isGlobalAgentPause(broken), true);

  const absent = fakeDb({ settings: {}, proposals: [], autonomyWrites: [] });
  assertEquals(await isGlobalAgentPause(absent), false);
});

// ── Dispatch per level ───────────────────────────────────────────────────────

Deno.test("L0: the intent is dropped and recorded as a would-have finding", async () => {
  const state: FakeState = { settings: {}, proposals: [], autonomyWrites: [] };
  const outcome = await dispatchWriteIntent(agent({}), INTENT, fakeDb(state));
  assertEquals(outcome.kind, "dropped");
  if (outcome.kind === "dropped") {
    assert(String(outcome.finding.note).includes("would have proposed"));
    assertEquals(outcome.finding.action_class, "retry_job");
  }
  assertEquals(state.proposals.length, 0); // nothing persisted
});

Deno.test("L1: the intent becomes a pending proposal with a dedup key", async () => {
  const state: FakeState = { settings: {}, proposals: [], autonomyWrites: [] };
  const outcome = await dispatchWriteIntent(
    agent({ retry_job: 1 }),
    INTENT,
    fakeDb(state),
  );
  assertEquals(outcome.kind, "proposed");
  if (outcome.kind === "proposed") assertEquals(outcome.downgraded, false);
  const row = state.proposals[0];
  assertEquals(row.status, "pending");
  assertEquals(row.action_class, "retry_job");
  assertEquals(row.idempotency_key, "sentinel:retry_job:Retry the payout sync job");
});

Deno.test("L2/L3 downgrade to a proposal WITH the downgrade note (pre-US-1587)", async () => {
  const state: FakeState = { settings: {}, proposals: [], autonomyWrites: [] };
  const outcome = await dispatchWriteIntent(
    agent({ retry_job: "L3" }),
    INTENT,
    fakeDb(state),
  );
  assertEquals(outcome.kind, "proposed");
  if (outcome.kind === "proposed") assertEquals(outcome.downgraded, true);
  const evidence = state.proposals[0].evidence as Record<string, string>;
  assert(evidence.autonomy_note.includes("L3"));
  assert(evidence.autonomy_note.includes("downgraded"));
});

// ── Breach demotion ──────────────────────────────────────────────────────────

Deno.test("a breach demotes one level, persists, and emits a warning", async () => {
  const state: FakeState = { settings: {}, proposals: [], autonomyWrites: [] };
  const events: Array<{ type: string; severity: string; title: string }> = [];
  const demoted = await recordPolicyBreach(
    agent({ retry_job: 2, draft_reply: 1 }),
    "retry_job",
    "executed against the wrong job",
    fakeDb(state),
    // deno-lint-ignore no-explicit-any
    ((type: string, severity: string, payload: any) => {
      events.push({ type, severity, title: payload.title });
      return Promise.resolve();
    }) as never,
  );
  assertEquals(demoted, 1);
  // The OTHER class's level is untouched.
  assertEquals(state.autonomyWrites[0].autonomy, { retry_job: 1, draft_reply: 1 });
  assertEquals(events[0].type, "agent_policy_breach");
  assertEquals(events[0].severity, "warning");
  assert(events[0].title.includes("L1"));
});

Deno.test("demotion floors at L0 — never negative", async () => {
  const state: FakeState = { settings: {}, proposals: [], autonomyWrites: [] };
  const demoted = await recordPolicyBreach(
    agent({}), // already L0 by default
    "retry_job",
    "still misbehaving",
    fakeDb(state),
    (() => Promise.resolve()) as never,
  );
  assertEquals(demoted, 0);
  assertEquals(state.autonomyWrites[0].autonomy.retry_job, 0);
});
