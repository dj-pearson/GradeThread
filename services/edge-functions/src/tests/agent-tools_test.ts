// US-1585: the tool registry — schema rejection, allowlist rejection at
// dispatch, a representative handler happy path, and the audit trail.
import { assert, assertEquals } from "@std/assert";

Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);
import type { ToolSchema } from "../lib/agent-tools.ts";
const { AGENT_TOOLS, buildKernelTools, dispatchTool, validateToolInput } =
  await import("../lib/agent-tools.ts");

// ── Fake db: a chainable query stub that resolves to canned rows ────────────

// deno-lint-ignore no-explicit-any
function fakeDb(rowsByTable: Record<string, any[]>) {
  return {
    from(table: string) {
      const rows = rowsByTable[table] ?? [];
      // deno-lint-ignore no-explicit-any
      const chain: any = {
        select: () => chain,
        gte: () => chain,
        lte: () => chain,
        eq: () => chain,
        neq: () => chain,
        not: () => chain,
        in: () => chain,
        is: () => chain,
        order: () => chain,
        limit: () => chain,
        then: (
          resolve: (v: { data: unknown[]; error: null; count: number }) => void,
        ) => resolve({ data: rows, error: null, count: rows.length }),
      };
      return chain;
    },
  };
}

const noAudit = () => Promise.resolve();

// ── Schema validation ────────────────────────────────────────────────────────

const SCHEMA: ToolSchema = {
  type: "object",
  properties: {
    window_hours: { type: "number" },
    min_severity: { type: "string", enum: ["info", "warning", "critical"] },
    limit: { type: "integer" },
  },
  required: ["window_hours"],
};

Deno.test("schema: valid input passes, every violation names the field", () => {
  assertEquals(validateToolInput(SCHEMA, { window_hours: 24 }), null);
  assert(validateToolInput(SCHEMA, "not an object")!.includes("object"));
  assert(validateToolInput(SCHEMA, {})!.includes("window_hours"));
  assert(
    validateToolInput(SCHEMA, { window_hours: "24" })!.includes("must be a number"),
  );
  assert(
    validateToolInput(SCHEMA, { window_hours: 1, limit: 1.5 })!.includes("integer"),
  );
  assert(
    validateToolInput(SCHEMA, { window_hours: 1, min_severity: "loud" })!
      .includes("one of"),
  );
  assert(
    validateToolInput(SCHEMA, { window_hours: 1, bogus: true })!.includes("unknown"),
  );
});

Deno.test("schema rejection returns a structured error via dispatch (run continues)", async () => {
  const result = await dispatchTool(
    "sentinel",
    "get_ops_events",
    ["get_ops_events"],
    { min_severity: "loud" },
    fakeDb({}),
    noAudit,
  );
  assertEquals(result.ok, false);
  assert(String((result.result as { error: string }).error).includes("invalid input"));
});

// ── Allowlist ────────────────────────────────────────────────────────────────

Deno.test("a tool off the allowlist is rejected at dispatch", async () => {
  const result = await dispatchTool(
    "sentinel",
    "get_ai_spend",
    ["get_cron_health"], // spend NOT allowed
    {},
    fakeDb({}),
    noAudit,
  );
  assertEquals(result.ok, false);
  assert(String((result.result as { error: string }).error).includes("allowlist"));
});

Deno.test("buildKernelTools exposes ONLY the allowlisted slice", () => {
  const tools = buildKernelTools("sentinel", ["get_cron_health", "ghost_tool"]);
  assertEquals(Object.keys(tools), ["get_cron_health"]); // ghost invisible
});

// ── Representative handler happy path ────────────────────────────────────────

Deno.test("get_cron_health aggregates per job with failure counts", async () => {
  const db = fakeDb({
    cron_runs: [
      { job_name: "sync", status: "success", created_at: "2026-07-04T02:00:00Z" },
      { job_name: "sync", status: "error", created_at: "2026-07-04T01:00:00Z" },
      { job_name: "digest", status: "success", created_at: "2026-07-04T01:30:00Z" },
    ],
  });
  const result = await dispatchTool(
    "sentinel",
    "get_cron_health",
    ["get_cron_health"],
    {},
    db,
    noAudit,
  );
  assert(result.ok);
  const jobs = (result.result as {
    jobs: Record<string, { latest: string; failures: number; runs: number }>;
  }).jobs;
  assertEquals(jobs.sync.runs, 2);
  assertEquals(jobs.sync.failures, 1);
  assertEquals(jobs.sync.latest, "success"); // newest row wins
  assertEquals(jobs.digest.failures, 0);
});

Deno.test("get_marketplace_health returns cross-tenant AGGREGATES only", async () => {
  const db = fakeDb({
    marketplace_connections: [
      { marketplace: "ebay", is_active: true, refresh_error: null, token_expires_at: "2099-01-01" },
      { marketplace: "ebay", is_active: false, refresh_error: "invalid_grant", token_expires_at: "2020-01-01" },
    ],
  });
  const result = await dispatchTool(
    "ops",
    "get_marketplace_health",
    ["get_marketplace_health"],
    {},
    db,
    noAudit,
  );
  assert(result.ok);
  const ebay = (result.result as {
    byPlatform: Record<string, Record<string, number>>;
  }).byPlatform.ebay;
  assertEquals(ebay.total, 2);
  assertEquals(ebay.active, 1);
  assertEquals(ebay.refreshErrors, 1);
  assertEquals(ebay.tokenExpired, 1);
  // No user ids, handles, or tokens in the payload.
  const raw = JSON.stringify(result.result);
  assert(!raw.includes("user_id") && !raw.includes("token_encrypted"));
});

// ── Audit trail ──────────────────────────────────────────────────────────────

Deno.test("every successful invocation writes an audit entry with redacted input", async () => {
  const entries: Array<{ action: string; details: Record<string, unknown> }> = [];
  const result = await dispatchTool(
    "sentinel",
    "get_ops_events",
    ["get_ops_events"],
    { min_severity: "critical" },
    fakeDb({ ops_events: [] }),
    (entry) => {
      entries.push(entry);
      return Promise.resolve();
    },
  );
  assert(result.ok);
  assertEquals(entries.length, 1);
  assertEquals(entries[0].action, "agent_tool_invocation");
  assertEquals(entries[0].details.agent, "sentinel");
  assertEquals(entries[0].details.tool, "get_ops_events");
});

Deno.test("an audit-write failure never takes the tool down", async () => {
  const result = await dispatchTool(
    "sentinel",
    "get_system_health",
    ["get_system_health"],
    {},
    fakeDb({}),
    () => Promise.reject(new Error("audit db down")),
  );
  assert(result.ok); // the read still served
});

// ── Registry hygiene ─────────────────────────────────────────────────────────

Deno.test("v1 registry: all nine tools present and read-class", () => {
  const names = Object.keys(AGENT_TOOLS).sort();
  assertEquals(names, [
    "get_ai_spend",
    "get_cron_health",
    "get_dead_letters",
    "get_marketplace_health",
    "get_ops_events",
    "get_revenue_window",
    "get_review_queue_stats",
    "get_support_ticket_stats",
    "get_system_health",
  ]);
  for (const tool of Object.values(AGENT_TOOLS)) {
    assertEquals(tool.class, "read");
    assertEquals(tool.inputSchema.type, "object");
  }
});
