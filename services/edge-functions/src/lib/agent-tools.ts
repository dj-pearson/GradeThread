// US-1585 / AGENTIC-OS Phase 0 (Module A): the agent tool registry v1.
//
// Agents see the world ONLY through this typed, allowlisted, audited registry
// (AGENTIC_OS.md §2 guardrails 1–2). v1 ships READ-ONLY tools that wrap EXISTING
// operator libraries / RPCs — no agent can mutate anything and every access is
// attributable. Write tools are deferred to US-1587 so the kernel can run at L0
// (observe) immediately.
//
// Each tool: { name, description, inputSchema (JSON schema), class, handler }.
// Dispatch (execute):
//   1. allowlist gate — a tool not in agents.config.tools is invisible in the
//      model's tool list AND rejected here if called anyway (defense in depth);
//   2. schema validation — invalid input returns a STRUCTURED tool error to the
//      model (the run continues), never throws;
//   3. audit — every genuine invocation writes an admin_audit_log entry
//      (agent key, tool, redacted input) via the system actor, in addition to
//      the agent_run_steps row the kernel already records;
//   4. handler — an operator-scope read; a throw is caught and returned as a
//      structured error.
//
// SECURITY (US-268 / tenant-isolation skill): handlers read OPERATOR tables and
// RPCs only. The one multi-tenant table touched (marketplace_connections) is
// returned as cross-tenant AGGREGATE counts — never raw rows, ids, handles, or
// any user PII. All reads use the service-role client at operator scope.

import type Anthropic from "@anthropic-ai/sdk";
import type { AgentRow, AgentToolRegistry } from "./agent-kernel.ts";
import { supabaseAdmin } from "./supabase.ts";
import { aggregateJobStats, failingJobCount, type RawRun } from "./ops-jobs.ts";
import { resolveRevenueWindow } from "./revenue-window.ts";
import { type AuditLogInput, writeSystemAuditLog } from "./audit-log.ts";
import { redact, redactError } from "./log-redact.ts";

// ── JSON-schema (minimal) validation ─────────────────────────────────────────

export interface JsonSchema {
  type: "object";
  properties?: Record<string, PropSchema>;
  required?: string[];
}
interface PropSchema {
  type: "string" | "number" | "integer" | "boolean" | "array" | "object";
  enum?: unknown[];
  minimum?: number;
  maximum?: number;
  description?: string;
}

export type Validation =
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; errors: string[] };

function typeOk(v: unknown, t: PropSchema["type"]): boolean {
  switch (t) {
    case "string":
      return typeof v === "string";
    case "boolean":
      return typeof v === "boolean";
    case "number":
      return typeof v === "number" && Number.isFinite(v);
    case "integer":
      return typeof v === "number" && Number.isInteger(v);
    case "array":
      return Array.isArray(v);
    case "object":
      return v !== null && typeof v === "object" && !Array.isArray(v);
  }
}

// Lenient validator: enforces required keys, per-prop type / enum / range on
// PROVIDED keys, and ignores unknown keys. Enough to reject malformed model
// input without pulling a full JSON-schema dependency.
export function validateToolInput(schema: JsonSchema, input: Record<string, unknown>): Validation {
  const errors: string[] = [];
  for (const req of schema.required ?? []) {
    if (!(req in input) || input[req] === undefined || input[req] === null) {
      errors.push(`missing required "${req}"`);
    }
  }
  for (const [key, spec] of Object.entries(schema.properties ?? {})) {
    if (!(key in input) || input[key] === undefined) continue;
    const v = input[key];
    if (!typeOk(v, spec.type)) {
      errors.push(`"${key}" must be ${spec.type}`);
      continue;
    }
    if (spec.enum && !spec.enum.includes(v)) {
      errors.push(`"${key}" must be one of ${JSON.stringify(spec.enum)}`);
    }
    if (typeof v === "number") {
      if (typeof spec.minimum === "number" && v < spec.minimum) errors.push(`"${key}" < ${spec.minimum}`);
      if (typeof spec.maximum === "number" && v > spec.maximum) errors.push(`"${key}" > ${spec.maximum}`);
    }
  }
  return errors.length ? { ok: false, errors } : { ok: true, value: input };
}

function clampInt(v: unknown, dflt: number, min: number, max: number): number {
  const n = typeof v === "number" && Number.isFinite(v) ? Math.floor(v) : dflt;
  return Math.min(max, Math.max(min, n));
}

// ── Tool definitions ─────────────────────────────────────────────────────────

export type ToolClass = "read" | "write";

export interface ToolContext {
  io: ToolIO;
  agentKey: string;
  agentId: string;
  now: number;
}

export interface AgentToolDef {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  class: ToolClass;
  handler: (input: Record<string, unknown>, ctx: ToolContext) => Promise<unknown>;
}

// ── IO seam (DI for tests) ───────────────────────────────────────────────────

interface OpsEventRow {
  id: string;
  type: string;
  severity: string;
  title: string | null;
  source: string | null;
  created_at: string;
  acknowledged_at: string | null;
}
interface DeadLetterRow {
  provider: string | null;
  last_error: string | null;
  attempt_count: number | null;
  created_at: string;
}
interface ConnRow {
  marketplace: string | null;
  is_active: boolean | null;
  token_expires_at: string | null;
  refresh_error: string | null;
}

export interface ToolIO {
  fetchCronRuns(limit: number): Promise<RawRun[]>;
  fetchOpsEvents(opts: {
    severity?: string;
    type?: string;
    unacknowledged?: boolean;
    sinceIso?: string;
    limit: number;
  }): Promise<OpsEventRow[]>;
  fetchWebhookDeadLetters(limit: number): Promise<DeadLetterRow[]>;
  fetchEmailDeadLetters(limit: number): Promise<DeadLetterRow[]>;
  countSupportTickets(status: string): Promise<number>;
  fetchMarketplaceConnections(): Promise<ConnRow[]>;
  rpc(name: string, args?: Record<string, unknown>): Promise<unknown>;
  audit(input: AuditLogInput): Promise<void>;
  now(): number;
}

export function prodToolIO(): ToolIO {
  return {
    fetchCronRuns: async (limit) => {
      const { data } = await supabaseAdmin
        .from("cron_runs")
        .select("job_name, status, http_status, duration_ms, rows_processed, triggered_by, created_at")
        .order("created_at", { ascending: false })
        .limit(limit);
      return (data ?? []) as RawRun[];
    },
    fetchOpsEvents: async (opts) => {
      let q = supabaseAdmin
        .from("ops_events")
        .select("id, type, severity, title, source, created_at, acknowledged_at")
        .order("created_at", { ascending: false })
        .limit(opts.limit);
      if (opts.severity) q = q.eq("severity", opts.severity);
      if (opts.type) q = q.eq("type", opts.type);
      if (opts.unacknowledged) q = q.is("acknowledged_at", null);
      if (opts.sinceIso) q = q.gte("created_at", opts.sinceIso);
      const { data } = await q;
      return (data ?? []) as OpsEventRow[];
    },
    fetchWebhookDeadLetters: async (limit) => {
      const { data } = await supabaseAdmin
        .from("webhook_dead_letters")
        .select("provider, last_error, attempt_count, created_at")
        .eq("status", "unresolved")
        .order("created_at", { ascending: true })
        .limit(limit);
      return (data ?? []) as DeadLetterRow[];
    },
    fetchEmailDeadLetters: async (limit) => {
      const { data } = await supabaseAdmin
        .from("email_deliveries")
        .select("last_error, attempt_count, created_at")
        .eq("status", "dead_letter")
        .order("created_at", { ascending: true })
        .limit(limit);
      return ((data ?? []) as Array<Omit<DeadLetterRow, "provider">>).map((r) => ({
        provider: "email",
        ...r,
      }));
    },
    countSupportTickets: async (status) => {
      const { count } = await supabaseAdmin
        .from("support_tickets")
        .select("id", { count: "exact", head: true })
        .eq("status", status);
      return count ?? 0;
    },
    fetchMarketplaceConnections: async () => {
      const { data } = await supabaseAdmin
        .from("marketplace_connections")
        .select("marketplace, is_active, token_expires_at, refresh_error");
      return (data ?? []) as ConnRow[];
    },
    rpc: async (name, args) => {
      const { data } = await supabaseAdmin.rpc(name, (args ?? {}) as never);
      return data;
    },
    audit: (input) => writeSystemAuditLog(input),
    now: () => Date.now(),
  };
}

// ── The read tools (v1) ──────────────────────────────────────────────────────

const TOOL_LIST: AgentToolDef[] = [
  {
    name: "get_cron_health",
    description: "Recent scheduled-job (cron) health: per-job last status, success rate, and consecutive failures, plus a count of currently-failing jobs.",
    class: "read",
    inputSchema: {
      type: "object",
      properties: { limit: { type: "integer", minimum: 1, maximum: 20000, description: "rows of cron history to scan" } },
    },
    handler: async (input, ctx) => {
      const runs = await ctx.io.fetchCronRuns(clampInt(input.limit, 4000, 1, 20000));
      const summaries = aggregateJobStats(runs, new Date(ctx.now));
      return {
        failing: failingJobCount(summaries),
        jobs: summaries.map((s) => ({
          name: s.name,
          last_status: s.last_status,
          success_rate: s.success_rate,
          consecutive_failures: s.consecutive_failures,
          last_run_at: s.last_run_at,
        })),
      };
    },
  },
  {
    name: "get_ops_events",
    description: "A filterable window of operational events (info/warning/critical). Filter by severity, type, unacknowledged-only, and a recent-hours window.",
    class: "read",
    inputSchema: {
      type: "object",
      properties: {
        severity: { type: "string", enum: ["info", "warning", "critical"] },
        type: { type: "string" },
        unacknowledged: { type: "boolean" },
        since_hours: { type: "integer", minimum: 1, maximum: 720 },
        limit: { type: "integer", minimum: 1, maximum: 200 },
      },
    },
    handler: async (input, ctx) => {
      const sinceHours = typeof input.since_hours === "number" ? input.since_hours : undefined;
      const sinceIso = sinceHours ? new Date(ctx.now - sinceHours * 3600_000).toISOString() : undefined;
      const rows = await ctx.io.fetchOpsEvents({
        severity: typeof input.severity === "string" ? input.severity : undefined,
        type: typeof input.type === "string" ? input.type : undefined,
        unacknowledged: input.unacknowledged === true,
        sinceIso,
        limit: clampInt(input.limit, 50, 1, 200),
      });
      // Return sanitized fields only — never the raw payload (may carry PII).
      return {
        count: rows.length,
        events: rows.map((e) => ({
          id: e.id,
          type: e.type,
          severity: e.severity,
          title: e.title,
          source: e.source,
          created_at: e.created_at,
          acknowledged: e.acknowledged_at !== null,
        })),
      };
    },
  },
  {
    name: "get_dead_letters",
    description: "Unresolved webhook + email dead-letters as aggregate counts by source/provider, with the oldest age and redacted last-error samples.",
    class: "read",
    inputSchema: {
      type: "object",
      properties: { limit: { type: "integer", minimum: 1, maximum: 500 } },
    },
    handler: async (input, ctx) => {
      const limit = clampInt(input.limit, 200, 1, 500);
      const [webhooks, emails] = await Promise.all([
        ctx.io.fetchWebhookDeadLetters(limit),
        ctx.io.fetchEmailDeadLetters(limit),
      ]);
      const all = [
        ...webhooks.map((r) => ({ source: "webhook", ...r })),
        ...emails.map((r) => ({ source: "email", ...r })),
      ];
      const byProvider: Record<string, number> = {};
      let oldestAgeSeconds = 0;
      for (const r of all) {
        const key = `${r.source}:${r.provider ?? "unknown"}`;
        byProvider[key] = (byProvider[key] ?? 0) + 1;
        const age = Math.floor((ctx.now - Date.parse(r.created_at)) / 1000);
        if (Number.isFinite(age) && age > oldestAgeSeconds) oldestAgeSeconds = age;
      }
      return {
        total: all.length,
        webhook: webhooks.length,
        email: emails.length,
        by_provider: byProvider,
        oldest_age_seconds: oldestAgeSeconds,
        samples: all.slice(0, 10).map((r) => ({
          source: r.source,
          provider: r.provider ?? "unknown",
          attempt_count: r.attempt_count ?? 0,
          last_error: r.last_error ? redact(r.last_error) : null,
        })),
      };
    },
  },
  {
    name: "get_system_health",
    description: "Overall platform health metrics (queues, latency, error rates) from the system_health aggregate.",
    class: "read",
    inputSchema: { type: "object", properties: {} },
    handler: (_input, ctx) => ctx.io.rpc("system_health"),
  },
  {
    name: "get_ai_spend",
    description: "AI budget status per feature: limit, current spend, percent, and whether it has breached. Optionally filter to one feature.",
    class: "read",
    inputSchema: {
      type: "object",
      properties: { feature: { type: "string" } },
    },
    handler: async (input, ctx) => {
      const rows = (await ctx.io.rpc("ai_budget_status")) as Array<Record<string, unknown>> | null;
      const list = Array.isArray(rows) ? rows : [];
      const feature = typeof input.feature === "string" ? input.feature : null;
      const filtered = feature ? list.filter((r) => r.feature === feature) : list;
      return {
        budgets: filtered.map((r) => ({
          feature: r.feature,
          period: r.period,
          limit_usd: r.limitUsd,
          spend_usd: r.spendUsd,
          pct: r.pct,
          breached: r.breached,
          action: r.action,
          enabled: r.enabled,
        })),
      };
    },
  },
  {
    name: "get_support_ticket_stats",
    description: "Support ticket queue counts by status (open, pending) and the active backlog total.",
    class: "read",
    inputSchema: { type: "object", properties: {} },
    handler: async (_input, ctx) => {
      const [open, pending] = await Promise.all([
        ctx.io.countSupportTickets("open"),
        ctx.io.countSupportTickets("pending"),
      ]);
      return { open, pending, active_total: open + pending };
    },
  },
  {
    name: "get_review_queue_stats",
    description: "Grading human-review queue depth (open reviews awaiting a human) from the system_health aggregate.",
    class: "read",
    inputSchema: { type: "object", properties: {} },
    handler: async (_input, ctx) => {
      const health = (await ctx.io.rpc("system_health")) as { queues?: Record<string, unknown> } | null;
      return { queues: health?.queues ?? {} };
    },
  },
  {
    name: "get_revenue_window",
    description: "Revenue dashboard aggregate over a named period (mtd, qtd, or ytd). Returns the resolved window plus the server-aggregated revenue document.",
    class: "read",
    inputSchema: {
      type: "object",
      properties: { period: { type: "string", enum: ["mtd", "qtd", "ytd"] } },
    },
    handler: async (input, ctx) => {
      const w = resolveRevenueWindow({
        period: typeof input.period === "string" ? input.period : "mtd",
        now: new Date(ctx.now),
      });
      const revenue = await ctx.io.rpc("revenue_dashboard", {
        p_start: w.start,
        p_end: w.end,
        p_granularity: w.granularity,
      });
      return { window: w, revenue };
    },
  },
  {
    name: "get_marketplace_health",
    description: "Cross-tenant marketplace-connection health as AGGREGATE counts (by marketplace and by state: active, inactive, error, expiring-soon). No per-seller rows or PII.",
    class: "read",
    inputSchema: { type: "object", properties: {} },
    handler: async (_input, ctx) => {
      const conns = await ctx.io.fetchMarketplaceConnections();
      const soonMs = 7 * 24 * 3600_000;
      const byMarketplace: Record<string, number> = {};
      let active = 0, inactive = 0, withError = 0, expiringSoon = 0;
      for (const c of conns) {
        const mk = c.marketplace ?? "unknown";
        byMarketplace[mk] = (byMarketplace[mk] ?? 0) + 1;
        if (c.is_active) active++;
        else inactive++;
        if (c.refresh_error) withError++;
        if (c.token_expires_at) {
          const dt = Date.parse(c.token_expires_at) - ctx.now;
          if (dt > 0 && dt < soonMs) expiringSoon++;
        }
      }
      return {
        total: conns.length,
        active,
        inactive,
        with_error: withError,
        expiring_soon: expiringSoon,
        by_marketplace: byMarketplace,
      };
    },
  },
];

export const AGENT_TOOLS: readonly AgentToolDef[] = TOOL_LIST;
const BY_NAME = new Map(TOOL_LIST.map((t) => [t.name, t]));

// The per-agent allowlist: `config.tools` (US-1585) or the `tool_allowlist` alias.
function allowlistOf(agent: AgentRow): string[] {
  const t = agent.config?.tools ?? agent.config?.tool_allowlist;
  return Array.isArray(t) ? t.filter((x): x is string => typeof x === "string") : [];
}

// ── The registry (implements the kernel's AgentToolRegistry seam) ────────────

export function createAgentToolRegistry(io: ToolIO = prodToolIO()): AgentToolRegistry {
  return {
    anthropicTools(agent: AgentRow): Anthropic.Tool[] {
      const allow = new Set(allowlistOf(agent));
      return TOOL_LIST.filter((t) => allow.has(t.name)).map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.inputSchema as Anthropic.Tool["input_schema"],
      }));
    },
    isAllowed(agent: AgentRow, name: string): boolean {
      return BY_NAME.has(name) && allowlistOf(agent).includes(name);
    },
    async execute(agent: AgentRow, name: string, rawInput: unknown): Promise<unknown> {
      const tool = BY_NAME.get(name);
      if (!tool || !allowlistOf(agent).includes(name)) {
        return { error: { code: "tool_not_allowed", message: `tool not allowed: ${name}` } };
      }
      const input = rawInput && typeof rawInput === "object" && !Array.isArray(rawInput)
        ? rawInput as Record<string, unknown>
        : {};
      const v = validateToolInput(tool.inputSchema, input);
      if (!v.ok) {
        return { error: { code: "invalid_input", message: "input failed schema validation", details: v.errors } };
      }
      // Audit every genuine invocation (AC4) — best-effort, redacted input.
      await io.audit({
        action: "agent.tool_invoked",
        targetType: "agent_tool",
        targetId: name,
        details: {
          agent_key: agent.key,
          agent_id: agent.id,
          tool: name,
          tool_class: tool.class,
          input: redact(v.value),
        },
      }).catch(() => {});
      const ctx: ToolContext = { io, agentKey: agent.key, agentId: agent.id, now: io.now() };
      try {
        return await tool.handler(v.value, ctx);
      } catch (err) {
        return { error: { code: "tool_error", message: redactError(err) } };
      }
    },
  };
}

// Default production registry (empty-IO-free): wired to the real infrastructure.
export const agentToolRegistry: AgentToolRegistry = createAgentToolRegistry();
