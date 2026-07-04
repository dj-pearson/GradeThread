// US-1585: the agent tool registry — agents see the world ONLY through these
// typed, allowlisted, audited tools. v1 is read-only: every handler is an
// operator-scope AGGREGATE (counts, sums, previews) so no tool can return raw
// tenant PII, and every invocation is attributable (audit-log row + the
// kernel's agent_run_steps transcript).
//
// Mechanics:
//  - input is validated against the tool's JSON schema BEFORE the handler
//    runs; invalid input returns a structured { error } to the model and the
//    run continues (the model can correct itself);
//  - the per-agent allowlist (agents.config.tool_allowlist) filters the
//    model-visible tool list in the kernel AND is re-checked at dispatch, so
//    a hallucinated call to an off-list tool is rejected even if it slips in;
//  - handlers take an injectable client so tests never touch a live DB.

import { supabaseAdmin } from "./supabase.ts";
import { redact } from "./log-redact.ts";
import { writeSystemAuditLog } from "./audit-log.ts";
import type { AgentTool } from "./agent-kernel.ts";

// ── Minimal JSON-schema validation (the subset our tools use) ───────────────

export interface ToolSchema {
  type: "object";
  properties: Record<
    string,
    { type: "string" | "number" | "integer" | "boolean"; enum?: readonly string[]; description?: string }
  >;
  required?: readonly string[];
}

/** Null = valid; otherwise a human-readable error the model can act on. */
export function validateToolInput(
  schema: ToolSchema,
  input: unknown,
): string | null {
  if (input == null || typeof input !== "object" || Array.isArray(input)) {
    return "input must be a JSON object";
  }
  const obj = input as Record<string, unknown>;
  for (const key of schema.required ?? []) {
    if (obj[key] === undefined || obj[key] === null) {
      return `missing required field '${key}'`;
    }
  }
  for (const [key, value] of Object.entries(obj)) {
    const prop = schema.properties[key];
    if (!prop) return `unknown field '${key}'`;
    if (value === undefined || value === null) continue;
    const t = prop.type;
    if (t === "integer") {
      if (typeof value !== "number" || !Number.isInteger(value)) {
        return `field '${key}' must be an integer`;
      }
    } else if (typeof value !== t) {
      return `field '${key}' must be a ${t}`;
    }
    if (prop.enum && !prop.enum.includes(value as string)) {
      return `field '${key}' must be one of: ${prop.enum.join(", ")}`;
    }
  }
  return null;
}

// ── Registry types ───────────────────────────────────────────────────────────

/** The narrow query surface handlers use (test-fakeable). */
// deno-lint-ignore no-explicit-any
export type ToolDb = any;

export interface RegisteredTool {
  name: string;
  description: string;
  class: "read" | "write";
  inputSchema: ToolSchema;
  handler(input: Record<string, unknown>, db: ToolDb): Promise<unknown>;
}

function windowStartIso(input: Record<string, unknown>, defaultHours: number): string {
  const hours = typeof input.window_hours === "number" && input.window_hours > 0
    ? Math.min(input.window_hours, 24 * 30)
    : defaultHours;
  return new Date(Date.now() - hours * 3_600_000).toISOString();
}

const WINDOW_PROP = {
  window_hours: {
    type: "number" as const,
    description: "Lookback window in hours (default varies per tool, max 720).",
  },
};

// ── The v1 read tools ────────────────────────────────────────────────────────

export const AGENT_TOOLS: Record<string, RegisteredTool> = {
  get_cron_health: {
    name: "get_cron_health",
    description:
      "Recent cron-job outcomes: per job, the latest status, last finish time, and failure count in the window.",
    class: "read",
    inputSchema: { type: "object", properties: { ...WINDOW_PROP } },
    async handler(input, db) {
      const since = windowStartIso(input, 24);
      const { data, error } = await db
        .from("cron_runs")
        .select("job_name, status, created_at, duration_ms")
        .gte("created_at", since)
        .order("created_at", { ascending: false })
        .limit(1000);
      if (error) return { error: error.message };
      const byJob = new Map<
        string,
        { latest: string; latestAt: string; failures: number; runs: number }
      >();
      for (const row of (data ?? []) as Array<Record<string, string>>) {
        const entry = byJob.get(row.job_name) ?? {
          latest: row.status,
          latestAt: row.created_at,
          failures: 0,
          runs: 0,
        };
        entry.runs += 1;
        if (row.status !== "success" && row.status !== "skipped") entry.failures += 1;
        byJob.set(row.job_name, entry);
      }
      return { since, jobs: Object.fromEntries(byJob) };
    },
  },

  get_ops_events: {
    name: "get_ops_events",
    description:
      "Operational events in a window, filterable by minimum severity. Returns counts by severity plus the most recent event summaries.",
    class: "read",
    inputSchema: {
      type: "object",
      properties: {
        ...WINDOW_PROP,
        min_severity: { type: "string", enum: ["info", "warning", "critical"] },
      },
    },
    async handler(input, db) {
      const since = windowStartIso(input, 24);
      let query = db
        .from("ops_events")
        .select("severity, type, title, created_at")
        .gte("created_at", since)
        .order("created_at", { ascending: false })
        .limit(200);
      if (input.min_severity === "critical") {
        query = query.eq("severity", "critical");
      } else if (input.min_severity === "warning") {
        query = query.in("severity", ["warning", "critical"]);
      }
      const { data, error } = await query;
      if (error) return { error: error.message };
      const rows = (data ?? []) as Array<Record<string, string>>;
      const counts: Record<string, number> = {};
      for (const r of rows) counts[r.severity] = (counts[r.severity] ?? 0) + 1;
      return {
        since,
        counts,
        recent: rows.slice(0, 25).map((r) => ({
          severity: r.severity,
          type: r.type,
          title: redact(r.title ?? "").slice(0, 300),
          at: r.created_at,
        })),
      };
    },
  },

  get_dead_letters: {
    name: "get_dead_letters",
    description:
      "Unresolved dead-lettered work (failed webhooks/jobs awaiting replay): count plus redacted previews of the newest entries.",
    class: "read",
    inputSchema: { type: "object", properties: { ...WINDOW_PROP } },
    async handler(input, db) {
      const since = windowStartIso(input, 24 * 7);
      const { data, error, count } = await db
        .from("webhook_dead_letters")
        .select("provider, event_type, error_message, created_at", { count: "exact" })
        .eq("status", "unresolved")
        .gte("created_at", since)
        .order("created_at", { ascending: false })
        .limit(20);
      if (error) return { error: error.message };
      return {
        since,
        unresolved: count ?? (data ?? []).length,
        recent: ((data ?? []) as Array<Record<string, string>>).map((r) => ({
          provider: r.provider,
          eventType: r.event_type,
          error: redact(r.error_message ?? "").slice(0, 200),
          at: r.created_at,
        })),
      };
    },
  },

  get_system_health: {
    name: "get_system_health",
    description:
      "One composite health snapshot: cron failures, critical ops events, and unresolved dead letters over the last 24h.",
    class: "read",
    inputSchema: { type: "object", properties: {} },
    async handler(_input, db) {
      const since = new Date(Date.now() - 24 * 3_600_000).toISOString();
      const [cron, events, dead] = await Promise.all([
        db.from("cron_runs").select("id", { count: "exact", head: true })
          .not("status", "in", "(success,skipped)").gte("created_at", since),
        db.from("ops_events").select("id", { count: "exact", head: true })
          .eq("severity", "critical").gte("created_at", since),
        db.from("webhook_dead_letters").select("id", { count: "exact", head: true })
          .eq("status", "unresolved"),
      ]);
      const err = cron.error ?? events.error ?? dead.error;
      if (err) return { error: err.message };
      return {
        since,
        cron_failures_24h: cron.count ?? 0,
        critical_events_24h: events.count ?? 0,
        unresolved_dead_letters: dead.count ?? 0,
      };
    },
  },

  get_ai_spend: {
    name: "get_ai_spend",
    description:
      "AI spend aggregated by feature over a window: call counts, tokens, and cost in USD.",
    class: "read",
    inputSchema: { type: "object", properties: { ...WINDOW_PROP } },
    async handler(input, db) {
      const since = windowStartIso(input, 24);
      const { data, error } = await db
        .from("ai_usage_events")
        .select("phase, cost_usd, input_tokens, output_tokens")
        .gte("created_at", since)
        .limit(10_000);
      if (error) return { error: error.message };
      const byFeature: Record<
        string,
        { calls: number; costUsd: number; tokensIn: number; tokensOut: number }
      > = {};
      for (const row of (data ?? []) as Array<Record<string, number | string>>) {
        const f = String(row.phase ?? "unknown");
        const agg = byFeature[f] ?? { calls: 0, costUsd: 0, tokensIn: 0, tokensOut: 0 };
        agg.calls += 1;
        agg.costUsd += Number(row.cost_usd ?? 0);
        agg.tokensIn += Number(row.input_tokens ?? 0);
        agg.tokensOut += Number(row.output_tokens ?? 0);
        byFeature[f] = agg;
      }
      for (const agg of Object.values(byFeature)) {
        agg.costUsd = Number(agg.costUsd.toFixed(4));
      }
      return { since, byFeature };
    },
  },

  get_support_ticket_stats: {
    name: "get_support_ticket_stats",
    description:
      "Support queue shape: ticket counts by status plus how many arrived in the window. Aggregates only.",
    class: "read",
    inputSchema: { type: "object", properties: { ...WINDOW_PROP } },
    async handler(input, db) {
      const since = windowStartIso(input, 24);
      const { data, error } = await db
        .from("support_tickets")
        .select("status, created_at")
        .limit(10_000);
      if (error) return { error: error.message };
      const rows = (data ?? []) as Array<Record<string, string>>;
      const byStatus: Record<string, number> = {};
      let newInWindow = 0;
      for (const r of rows) {
        byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
        if (r.created_at >= since) newInWindow += 1;
      }
      return { since, byStatus, newInWindow, total: rows.length };
    },
  },

  get_review_queue_stats: {
    name: "get_review_queue_stats",
    description:
      "Human grading-review queue: pending review count and how many grades were flagged for review in the window.",
    class: "read",
    inputSchema: { type: "object", properties: { ...WINDOW_PROP } },
    async handler(input, db) {
      const since = windowStartIso(input, 24);
      const [pending, flagged] = await Promise.all([
        db.from("human_reviews").select("id", { count: "exact", head: true })
          .is("adjusted_score", null),
        db.from("grade_reports").select("id", { count: "exact", head: true })
          .eq("needs_human_review", true).gte("created_at", since),
      ]);
      const err = pending.error ?? flagged.error;
      if (err) return { error: err.message };
      return {
        since,
        pending_reviews: pending.count ?? 0,
        flagged_in_window: flagged.count ?? 0,
      };
    },
  },

  get_revenue_window: {
    name: "get_revenue_window",
    description:
      "Marketplace revenue over a window: sale count and gross sale total in USD. Aggregates only — no per-user rows.",
    class: "read",
    inputSchema: { type: "object", properties: { ...WINDOW_PROP } },
    async handler(input, db) {
      const since = windowStartIso(input, 24 * 7);
      const { data, error } = await db
        .from("sales")
        .select("sale_price, sale_date")
        .gte("sale_date", since)
        .limit(10_000);
      if (error) return { error: error.message };
      const rows = (data ?? []) as Array<{ sale_price: number | null }>;
      const gross = rows.reduce((sum, r) => sum + Number(r.sale_price ?? 0), 0);
      return { since, sales: rows.length, gross_usd: Number(gross.toFixed(2)) };
    },
  },

  get_marketplace_health: {
    name: "get_marketplace_health",
    description:
      "Marketplace connection fleet health: connection counts by platform and how many carry a refresh error or an expired access token. Cross-tenant AGGREGATES only.",
    class: "read",
    inputSchema: { type: "object", properties: {} },
    async handler(_input, db) {
      const { data, error } = await db
        .from("marketplace_connections")
        .select("marketplace, is_active, refresh_error, token_expires_at")
        .limit(10_000);
      if (error) return { error: error.message };
      const now = new Date().toISOString();
      const byPlatform: Record<
        string,
        { total: number; active: number; refreshErrors: number; tokenExpired: number }
      > = {};
      for (const row of (data ?? []) as Array<Record<string, string | boolean | null>>) {
        const p = String(row.marketplace ?? "unknown");
        const agg = byPlatform[p] ??
          { total: 0, active: 0, refreshErrors: 0, tokenExpired: 0 };
        agg.total += 1;
        if (row.is_active) agg.active += 1;
        if (row.refresh_error) agg.refreshErrors += 1;
        if (
          typeof row.token_expires_at === "string" &&
          row.token_expires_at < now
        ) agg.tokenExpired += 1;
        byPlatform[p] = agg;
      }
      return { byPlatform };
    },
  },
};

// ── Dispatch: allowlist + validation + audit ────────────────────────────────

export interface DispatchResult {
  ok: boolean;
  result: unknown;
}

export async function dispatchTool(
  agentKey: string,
  toolName: string,
  allowlist: readonly string[],
  input: Record<string, unknown>,
  db: ToolDb = supabaseAdmin,
  audit: (entry: {
    action: string;
    targetType: string;
    details: Record<string, unknown>;
  }) => Promise<void> = writeSystemAuditLog,
): Promise<DispatchResult> {
  const tool = AGENT_TOOLS[toolName];
  // Allowlist re-check at dispatch (AC3): invisibility in the model's tool
  // list is the first line; this is the second.
  if (!tool || !allowlist.includes(toolName)) {
    return {
      ok: false,
      result: { error: `tool '${toolName}' is not on this agent's allowlist` },
    };
  }
  const validationError = validateToolInput(tool.inputSchema, input);
  if (validationError) {
    return { ok: false, result: { error: `invalid input: ${validationError}` } };
  }
  // Attribution: every invocation is auditable even outside run transcripts.
  try {
    await audit({
      action: "agent_tool_invocation",
      targetType: "agent_tool",
      details: {
        agent: agentKey,
        tool: toolName,
        input: redact(input).slice(0, 500),
      },
    });
  } catch {
    // Best-effort: the audit trail must never take the tool down with it.
  }
  const result = await tool.handler(input, db);
  return { ok: true, result };
}

/**
 * The kernel-facing surface: the agent's allowlisted slice of the registry,
 * each tool wrapped with validation + audit via dispatchTool.
 */
export function buildKernelTools(
  agentKey: string,
  allowlist: readonly string[],
  db: ToolDb = supabaseAdmin,
): Record<string, AgentTool> {
  const out: Record<string, AgentTool> = {};
  for (const name of allowlist) {
    const tool = AGENT_TOOLS[name];
    if (!tool) continue; // unknown names are simply invisible
    out[name] = {
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema as unknown as Record<string, unknown>,
      run: async (input) => (await dispatchTool(agentKey, name, allowlist, input, db)).result,
    };
  }
  return out;
}
