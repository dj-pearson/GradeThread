// US-1585: agent tool registry v1. Types are erased (side-effect-free); the
// runtime values are dynamic-imported after the env is primed (agent-tools.ts
// pulls in supabase.ts, which throws without env). Mirrors agent-kernel_test.ts.
import { assert, assertEquals } from "@std/assert";
import type { AgentRow } from "../lib/agent-kernel.ts";
import type { ToolIO } from "../lib/agent-tools.ts";
import type { AuditLogInput } from "../lib/audit-log.ts";
import type { RawRun } from "../lib/ops-jobs.ts";

Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-key");
const { createAgentToolRegistry, validateToolInput } = await import("../lib/agent-tools.ts");

const NOW = 1_700_000_000_000;

function fakeIO(over: Partial<ToolIO> = {}): { io: ToolIO; audits: AuditLogInput[] } {
  const audits: AuditLogInput[] = [];
  const io: ToolIO = {
    fetchCronRuns: () => Promise.resolve([]),
    fetchOpsEvents: () => Promise.resolve([]),
    fetchWebhookDeadLetters: () => Promise.resolve([]),
    fetchEmailDeadLetters: () => Promise.resolve([]),
    countSupportTickets: () => Promise.resolve(0),
    fetchMarketplaceConnections: () => Promise.resolve([]),
    rpc: () => Promise.resolve(null),
    audit: (i) => {
      audits.push(i);
      return Promise.resolve();
    },
    now: () => NOW,
    runJob: () => Promise.resolve({ ok: true, status: 200 }),
    requeueEmailDeadLetter: () => Promise.resolve(true),
    resolveAgentTaskProject: () => Promise.resolve("proj-1"),
    insertAdminTask: () => Promise.resolve({ id: "task-1" }),
    reorderReviewQueue: () =>
      Promise.resolve({
        persisted: true,
        count: 0,
        setting_key: "grading.review_queue_order",
        rationale: "No pending reviews to reorder.",
        top: [],
      }),
    ...over,
  };
  return { io, audits };
}

function agent(tools: string[]): AgentRow {
  return {
    id: "a1",
    key: "sentinel",
    name: "Sentinel",
    module_letter: "H",
    status: "enabled",
    autonomy: {},
    config: { tools },
  };
}

// ── Allowlist ────────────────────────────────────────────────────────────────

Deno.test("registry: only allowlisted tools are visible + isAllowed reflects it", () => {
  const reg = createAgentToolRegistry(fakeIO().io);
  const a = agent(["get_cron_health", "get_ops_events"]);
  assertEquals(reg.anthropicTools(a).map((t) => t.name).sort(), ["get_cron_health", "get_ops_events"]);
  assertEquals(reg.isAllowed(a, "get_cron_health"), true);
  assertEquals(reg.isAllowed(a, "get_dead_letters"), false); // not in allowlist
  assertEquals(reg.isAllowed(a, "nonexistent_tool"), false); // not a real tool
});

Deno.test("registry: a non-allowlisted tool is rejected at dispatch", async () => {
  const { io, audits } = fakeIO();
  const reg = createAgentToolRegistry(io);
  const res = await reg.execute(agent(["get_cron_health"]), "get_ops_events", {}) as {
    error?: { code?: string };
  };
  assertEquals(res.error?.code, "tool_not_allowed");
  assertEquals(audits.length, 0); // rejected before any audit/handler
});

// ── Schema validation ────────────────────────────────────────────────────────

Deno.test("registry: invalid input returns a structured error (run continues)", async () => {
  const { io, audits } = fakeIO();
  const reg = createAgentToolRegistry(io);
  const res = await reg.execute(agent(["get_cron_health"]), "get_cron_health", { limit: "not-a-number" }) as {
    error?: { code?: string };
  };
  assertEquals(res.error?.code, "invalid_input");
  assertEquals(audits.length, 0); // never reached the handler
});

Deno.test("validateToolInput: required, type, enum, range", () => {
  const schema = {
    type: "object" as const,
    properties: {
      severity: { type: "string" as const, enum: ["info", "warning", "critical"] },
      limit: { type: "integer" as const, minimum: 1, maximum: 10 },
    },
    required: ["severity"],
  };
  assertEquals(validateToolInput(schema, { severity: "info", limit: 5 }).ok, true);
  assertEquals(validateToolInput(schema, {}).ok, false); // missing required
  assertEquals(validateToolInput(schema, { severity: "nope" }).ok, false); // bad enum
  assertEquals(validateToolInput(schema, { severity: "info", limit: 99 }).ok, false); // out of range
  assertEquals(validateToolInput(schema, { severity: "info", limit: "5" }).ok, false); // wrong type
  // Unknown keys are ignored (lenient).
  assertEquals(validateToolInput(schema, { severity: "info", extra: 1 }).ok, true);
});

// ── Representative handler happy path ────────────────────────────────────────

Deno.test("registry: get_cron_health returns aggregated health + audits the call", async () => {
  const runs: RawRun[] = [
    {
      job_name: "billing-reconciliation",
      status: "succeeded",
      http_status: 200,
      duration_ms: 42,
      rows_processed: 3,
      triggered_by: "cron",
      created_at: new Date(NOW - 1000).toISOString(),
    },
    {
      job_name: "billing-reconciliation",
      status: "failed",
      http_status: 500,
      duration_ms: 10,
      rows_processed: null,
      triggered_by: "cron",
      created_at: new Date(NOW - 2000).toISOString(),
    },
  ];
  const { io, audits } = fakeIO({ fetchCronRuns: () => Promise.resolve(runs) });
  const reg = createAgentToolRegistry(io);
  const res = await reg.execute(agent(["get_cron_health"]), "get_cron_health", {}) as {
    failing: number;
    jobs: Array<{ name: string; last_status: string | null }>;
  };
  assertEquals(typeof res.failing, "number");
  assert(Array.isArray(res.jobs));
  // get_cron_health returns the FULL cron registry (order-independent), so find
  // the job we injected runs for rather than assuming it lands at index 0.
  const billing = res.jobs.find((j) => j.name === "billing-reconciliation");
  assert(billing, "billing-reconciliation should appear in the health map");
  // The invocation was audited exactly once with the tool id.
  assertEquals(audits.length, 1);
  assertEquals(audits[0].targetId, "get_cron_health");
  assertEquals(audits[0].action, "agent.tool_invoked");
});

Deno.test("registry: a handler throw is caught and returned as a structured error", async () => {
  const { io } = fakeIO({
    fetchCronRuns: () => Promise.reject(new Error("db down")),
  });
  const reg = createAgentToolRegistry(io);
  const res = await reg.execute(agent(["get_cron_health"]), "get_cron_health", {}) as {
    error?: { code?: string };
  };
  assertEquals(res.error?.code, "tool_error");
});

// ── Write tools are invisible + unexecutable in the run loop (US-1587) ────────

Deno.test("registry: write tools are hidden from the run loop and refused at dispatch", async () => {
  const reg = createAgentToolRegistry(fakeIO().io);
  const a = agent(["retry_job", "get_cron_health"]); // allowlists a write + a read
  // Not surfaced as an Anthropic tool, and isAllowed is false for the run loop.
  assertEquals(reg.anthropicTools(a).map((t) => t.name), ["get_cron_health"]);
  assertEquals(reg.isAllowed(a, "retry_job"), false);
  // Even if the model calls it, execute refuses (never runs the side effect).
  const res = await reg.execute(a, "retry_job", { job_key: "x" }) as { error?: { code?: string } };
  assertEquals(res.error?.code, "write_tool_forbidden");
});

Deno.test("registry: executeWrite runs an approved write tool + audits it", async () => {
  const { io, audits } = fakeIO({ runJob: () => Promise.resolve({ ok: true, status: 202 }) });
  const reg = createAgentToolRegistry(io);
  const res = await reg.executeWrite("retry_job", { job_key: "reprice-scan" }, {
    authorizedBy: "admin-1",
    proposalId: "p1",
  }) as { ok?: boolean; status?: number };
  assertEquals(res.ok, true);
  assertEquals(res.status, 202);
  assertEquals(audits.at(-1)?.action, "agent.write_tool_executed");
});

Deno.test("registry: executeWrite refuses a read-tool name", async () => {
  const reg = createAgentToolRegistry(fakeIO().io);
  const res = await reg.executeWrite("get_cron_health", {}, { authorizedBy: "admin-1" }) as {
    error?: { code?: string };
  };
  assertEquals(res.error?.code, "not_a_write_tool");
});

Deno.test("registry: a write tool refuses to act without authorization context", async () => {
  // Directly executing a write tool's handler-path without authorizedBy is
  // impossible via execute (forbidden) — executeWrite always sets authorizedBy —
  // but the handler's own guard is the last line of defense.
  const { io } = fakeIO();
  const reg = createAgentToolRegistry(io);
  // A missing job_key still validates-fails first (schema), proving the schema
  // gate runs before the side effect.
  const res = await reg.executeWrite("retry_job", {}, { authorizedBy: "admin" }) as {
    error?: { code?: string };
  };
  assertEquals(res.error?.code, "invalid_input");
});

// ── US-1658: reorder_review_queue write tool ─────────────────────────────────

Deno.test("US-1658: adjust_queue maps to the reorder_review_queue write tool", async () => {
  const { ACTION_CLASS_TO_TOOL } = await import("../lib/agent-tools.ts");
  assertEquals(ACTION_CLASS_TO_TOOL.adjust_queue, "reorder_review_queue");
});

Deno.test("US-1658: reorder_review_queue is a write tool — invisible to the run loop", () => {
  const reg = createAgentToolRegistry(fakeIO().io);
  // Even if an agent allowlists it, a write tool is never surfaced or runnable.
  const a = agent(["reorder_review_queue", "get_cron_health"]);
  assertEquals(reg.anthropicTools(a).map((t) => t.name), ["get_cron_health"]);
  assertEquals(reg.isAllowed(a, "reorder_review_queue"), false);
});

Deno.test("US-1658: executeWrite(reorder_review_queue) runs on the approved path + passes authorization", async () => {
  let seen: { limit: number; authorizedBy: string; proposalId: string | null } | null = null;
  const { io, audits } = fakeIO({
    reorderReviewQueue: (opts) => {
      seen = opts;
      return Promise.resolve({
        persisted: true,
        count: 3,
        setting_key: "grading.review_queue_order",
        rationale: "Reordered 3 pending reviews by information value.",
        top: [{ rank: 1, report_id: "r1", info_value: 0.7, sla_floated: false }],
      });
    },
  });
  const reg = createAgentToolRegistry(io);
  const res = await reg.executeWrite("reorder_review_queue", { limit: 50 }, {
    authorizedBy: "admin-9",
    proposalId: "prop-42",
  }) as { persisted?: boolean; count?: number };
  assertEquals(res.persisted, true);
  assertEquals(res.count, 3);
  // The approving admin + proposal are threaded to the impure orchestration.
  assertEquals(seen!.authorizedBy, "admin-9");
  assertEquals(seen!.proposalId, "prop-42");
  assertEquals(seen!.limit, 50); // schema-clamped default path preserved the input
  assertEquals(audits.at(-1)?.action, "agent.write_tool_executed");
});
