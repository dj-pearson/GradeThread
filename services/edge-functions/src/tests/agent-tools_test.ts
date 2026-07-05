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
  assertEquals(res.jobs[0].name, "billing-reconciliation");
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
