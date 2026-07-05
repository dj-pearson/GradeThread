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
import { aggregateJobStats, failingJobCount, isRunnableJob, type RawRun } from "./ops-jobs.ts";
import { CRON_REGISTRY, DEFAULT_JOB_SECRET_ENV } from "./cron-runs.ts";
import { correlateIncidents, type Signal } from "./sentinel.ts";
import { assembleGradingMemo, gatherGradingTelemetry } from "./grading-quality.ts";
import { assembleFinanceMemo, type PayoutRow, type ReconFlag } from "./finance-agent.ts";
import { assembleIntegrationsMemo, type RotationState } from "./integrations-watchdog.ts";
import { type ActionRow, assemblePricingMemo, type CurveRow, type SuggestionRow } from "./pricing-agent.ts";
import { assembleMarketplaceOpsMemo, type BatchRow } from "./marketplace-ops-agent.ts";
import { type AbuseSignal, assembleTrustSafetyMemo } from "./trust-safety-agent.ts";
import { type ReorderReviewQueueResult, reorderReviewQueue } from "./review-queue-order.ts";
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
  // Set ONLY on the executeWrite (approved-proposal) path — a write tool refuses
  // to act unless it is present.
  authorizedBy?: string | null;
  proposalId?: string | null;
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
  id: string | null;
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
  // US-1604: operator-maintained map secret → last-rotated ISO (system_settings
  // `security.key_rotation_state`). Metadata only — never any secret material.
  fetchKeyRotationState(): Promise<RotationState>;
  // US-1596: OPEN billing-reconciliation divergences (operator billing data).
  fetchReconciliationFlags(limit: number): Promise<ReconFlag[]>;
  // US-1596: recent affiliate + consignor payout-run outcomes since an ISO time.
  fetchRecentPayouts(sinceIso: string): Promise<{ affiliate: PayoutRow[]; consignor: PayoutRow[] }>;
  // US-1601: cross-tenant repricing suggestions, automation actions, and price-
  // curve freshness (aggregate audit only — the agent never edits any of them).
  fetchRepricingSuggestions(sinceIso: string): Promise<SuggestionRow[]>;
  fetchAutomationActions(sinceIso: string): Promise<ActionRow[]>;
  fetchCurveFreshness(): Promise<CurveRow[]>;
  // US-1598: FlipDesk pipeline aggregates (operator-scope; counts + batch ids +
  // ages only, never a raw tenant row or PII).
  fetchListingBatches(): Promise<{ generation: BatchRow[]; publish: BatchRow[] }>;
  countOpenSyncConflicts(): Promise<number>;
  countOrphanSales(): Promise<number>;
  // Backlog time-series watermark (system_settings operator bookkeeping) for the
  // "vs yesterday" trend — read the prior point, record the current one.
  fetchMarketplaceOpsBacklog(): Promise<number | null>;
  persistMarketplaceOpsBacklog(total: number): Promise<void>;
  // US-1597: open abuse signals (operator T&S data — ids + evidence, no PII) +
  // open moderation / passport-integrity queue depths.
  fetchAbuseSignals(limit: number): Promise<AbuseSignal[]>;
  countOpenModerationFlags(): Promise<number>;
  countOpenPassportIntegritySignals(): Promise<number>;
  // ── Write-side (used only by executeWrite / approved proposals) ──
  // Re-fire a registered cron job by key over the internal job rails.
  runJob(jobKey: string): Promise<{ ok: boolean; status: number; error?: string }>;
  // Re-queue an email dead-letter (status dead_letter → pending). Returns
  // whether a row was actually re-queued.
  requeueEmailDeadLetter(id: string): Promise<boolean>;
  // Resolve (find-or-create) the standing "Agent Proposals" task project id.
  resolveAgentTaskProject(): Promise<string | null>;
  insertAdminTask(
    row: { project_id: string; title: string; body: string | null; priority: string; created_by: string | null },
  ): Promise<{ id: string } | null>;
  // Recompute the info-value ranking of the pending human-review queue and
  // persist the recommended order (US-1658). Grade-safe: never mutates a grade,
  // prompt, threshold, or calibration — an advisory ordering artifact only.
  reorderReviewQueue(
    opts: { limit: number; authorizedBy: string; proposalId: string | null },
  ): Promise<ReorderReviewQueueResult>;
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
        .select("id, provider, last_error, attempt_count, created_at")
        .eq("status", "unresolved")
        .order("created_at", { ascending: true })
        .limit(limit);
      return (data ?? []) as DeadLetterRow[];
    },
    fetchEmailDeadLetters: async (limit) => {
      const { data } = await supabaseAdmin
        .from("email_deliveries")
        .select("id, last_error, attempt_count, created_at")
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
    fetchKeyRotationState: async () => {
      const { data } = await supabaseAdmin
        .from("system_settings")
        .select("value")
        .eq("key", "security.key_rotation_state")
        .maybeSingle();
      const v = (data as { value?: unknown } | null)?.value;
      return v && typeof v === "object" && !Array.isArray(v) ? v as RotationState : {};
    },
    fetchReconciliationFlags: async (limit) => {
      const { data } = await supabaseAdmin
        .from("billing_reconciliation_flags")
        .select("subject_user_id, kind, db_status, expected_status, db_plan, expected_plan, detected_at")
        .eq("status", "open")
        .order("detected_at", { ascending: true })
        .limit(limit);
      return (data ?? []) as ReconFlag[];
    },
    fetchRecentPayouts: async (sinceIso) => {
      const [{ data: aff }, { data: cons }] = await Promise.all([
        supabaseAdmin.from("affiliate_payouts")
          .select("status, amount, error, created_at").gte("created_at", sinceIso).limit(1000),
        supabaseAdmin.from("consignor_payouts")
          .select("status, amount, error, created_at").gte("created_at", sinceIso).limit(1000),
      ]);
      return {
        affiliate: ((aff ?? []) as Array<Record<string, unknown>>).map((r) => ({
          status: String(r.status), amount: Number(r.amount ?? 0),
          error: (r.error as string | null) ?? null, created_at: String(r.created_at),
        })),
        consignor: ((cons ?? []) as Array<Record<string, unknown>>).map((r) => ({
          status: String(r.status), amount: Number(r.amount ?? 0),
          error: (r.error as string | null) ?? null, created_at: String(r.created_at),
        })),
      };
    },
    fetchRepricingSuggestions: async (sinceIso) => {
      const { data } = await supabaseAdmin
        .from("repricing_suggestions")
        .select("listing_id, user_id, reason_code, status, suggested_price_cents, applied_at, created_at")
        .gte("created_at", sinceIso)
        .limit(5000);
      return (data ?? []) as SuggestionRow[];
    },
    fetchAutomationActions: async (sinceIso) => {
      const { data } = await supabaseAdmin
        .from("flipdesk_automation_actions")
        .select("rule_id, user_id, listing_id, action_type, created_at")
        .gte("created_at", sinceIso)
        .limit(5000);
      return (data ?? []) as ActionRow[];
    },
    fetchCurveFreshness: async () => {
      const { data } = await supabaseAdmin
        .from("condition_price_curves")
        .select("category_id, refreshed_at")
        .order("refreshed_at", { ascending: true })
        .limit(2000);
      return (data ?? []) as CurveRow[];
    },
    fetchListingBatches: async () => {
      const [{ data: gen }, { data: pub }] = await Promise.all([
        supabaseAdmin.from("listing_generation_batches")
          .select("id, status, updated_at").order("updated_at", { ascending: true }).limit(3000),
        supabaseAdmin.from("listing_publish_batches")
          .select("id, status, updated_at").order("updated_at", { ascending: true }).limit(3000),
      ]);
      return { generation: (gen ?? []) as BatchRow[], publish: (pub ?? []) as BatchRow[] };
    },
    countOpenSyncConflicts: async () => {
      const { count } = await supabaseAdmin
        .from("flipdesk_sync_conflicts")
        .select("id", { count: "exact", head: true })
        .is("resolved_at", null);
      return count ?? 0;
    },
    countOrphanSales: async () => {
      const { count } = await supabaseAdmin
        .from("flipdesk_ebay_orphan_sales")
        .select("id", { count: "exact", head: true });
      return count ?? 0;
    },
    fetchMarketplaceOpsBacklog: async () => {
      const { data } = await supabaseAdmin
        .from("system_settings")
        .select("value")
        .eq("key", "marketplace_ops.backlog_snapshot")
        .maybeSingle();
      const v = (data as { value?: { total?: unknown } } | null)?.value?.total;
      return typeof v === "number" && Number.isFinite(v) ? v : null;
    },
    persistMarketplaceOpsBacklog: async (total) => {
      await supabaseAdmin.from("system_settings").upsert(
        {
          key: "marketplace_ops.backlog_snapshot",
          value: { total, at: new Date().toISOString() },
          value_type: "json",
          default_value: { total: 0 },
          description: "US-1598 Marketplace Ops agent backlog watermark (for the vs-yesterday trend)",
          category: "flipdesk",
        },
        { onConflict: "key" },
      );
    },
    fetchAbuseSignals: async (limit) => {
      const { data } = await supabaseAdmin
        .from("abuse_signals")
        .select("id, signal_type, severity, subject_user_id, evidence, first_seen_at")
        .eq("status", "open")
        .order("first_seen_at", { ascending: true })
        .limit(limit);
      return (data ?? []) as AbuseSignal[];
    },
    countOpenModerationFlags: async () => {
      const { count } = await supabaseAdmin
        .from("content_moderation_flags")
        .select("id", { count: "exact", head: true })
        .eq("status", "open");
      return count ?? 0;
    },
    countOpenPassportIntegritySignals: async () => {
      const { count } = await supabaseAdmin
        .from("passport_integrity_signals")
        .select("id", { count: "exact", head: true });
      return count ?? 0;
    },
    runJob: async (jobKey) => {
      // Only registered, runnable cron jobs — never an arbitrary URL.
      if (!isRunnableJob(jobKey)) return { ok: false, status: 0, error: "unknown_or_unrunnable_job" };
      const def = CRON_REGISTRY.find((d) => d.name === jobKey);
      if (!def) return { ok: false, status: 0, error: "not_registered" };
      const secret = Deno.env.get(def.secretEnv ?? DEFAULT_JOB_SECRET_ENV);
      if (!secret) return { ok: false, status: 503, error: "job_secret_unconfigured" };
      const base = `http://localhost:${Deno.env.get("PORT") || "8787"}`;
      try {
        const res = await fetch(`${base}${def.endpoint}`, {
          method: "POST",
          headers: { "X-Internal-Job-Secret": secret, "X-Triggered-By": "agent:proposal" },
          signal: AbortSignal.timeout(120_000),
        });
        return { ok: res.ok, status: res.status };
      } catch (err) {
        return { ok: false, status: 0, error: err instanceof Error ? err.message : "fetch_failed" };
      }
    },
    requeueEmailDeadLetter: async (id) => {
      const { data: row } = await supabaseAdmin
        .from("email_deliveries")
        .select("attempts")
        .eq("id", id)
        .eq("status", "dead_letter")
        .maybeSingle();
      if (!row) return false;
      const attempts = (row as { attempts?: number }).attempts ?? 0;
      const { data } = await supabaseAdmin
        .from("email_deliveries")
        .update({
          status: "pending",
          next_attempt_at: new Date().toISOString(),
          max_attempts: attempts + 3,
          last_error: null,
        } as never)
        .eq("id", id)
        .eq("status", "dead_letter")
        .select("id")
        .maybeSingle();
      return !!data;
    },
    resolveAgentTaskProject: async () => {
      const TITLE = "Agent Proposals";
      const { data: found } = await supabaseAdmin
        .from("admin_task_projects")
        .select("id")
        .eq("title", TITLE)
        .maybeSingle();
      if (found) return (found as { id: string }).id;
      const { data: created } = await supabaseAdmin
        .from("admin_task_projects")
        .insert({ title: TITLE } as never)
        .select("id")
        .single();
      return (created as { id: string } | null)?.id ?? null;
    },
    insertAdminTask: async (row) => {
      const { data } = await supabaseAdmin
        .from("admin_tasks")
        .insert({
          project_id: row.project_id,
          title: row.title,
          body: row.body,
          priority: row.priority,
          created_by: row.created_by,
        } as never)
        .select("id")
        .single();
      return (data as { id: string } | null) ?? null;
    },
    reorderReviewQueue: (opts) =>
      reorderReviewQueue({
        limit: opts.limit,
        nowMs: Date.now(),
        computedBy: opts.authorizedBy,
        proposalId: opts.proposalId,
      }),
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
          id: r.id,
          provider: r.provider ?? "unknown",
          attempt_count: r.attempt_count ?? 0,
          last_error: r.last_error ? redact(r.last_error) : null,
        })),
      };
    },
  },
  {
    name: "get_incidents",
    description: "Correlated incidents: co-occurring cron failures, unresolved dead letters, and warning/critical ops events already grouped by subsystem + time window into a small set of root-cause incidents (Sentinel's primary input). Empty list = healthy.",
    class: "read",
    inputSchema: {
      type: "object",
      properties: {
        since_hours: { type: "integer", minimum: 1, maximum: 168 },
        window_minutes: { type: "integer", minimum: 1, maximum: 720 },
      },
    },
    handler: async (input, ctx) => {
      const sinceHours = typeof input.since_hours === "number" ? input.since_hours : 24;
      const sinceMs = ctx.now - sinceHours * 3600_000;
      const windowMs = (typeof input.window_minutes === "number" ? input.window_minutes : 30) * 60_000;

      const [runs, webhooks, emails, events] = await Promise.all([
        ctx.io.fetchCronRuns(4000),
        ctx.io.fetchWebhookDeadLetters(200),
        ctx.io.fetchEmailDeadLetters(200),
        ctx.io.fetchOpsEvents({ severity: undefined, sinceIso: new Date(sinceMs).toISOString(), limit: 200 }),
      ]);

      const signals: Signal[] = [];
      for (const r of runs) {
        if (r.status !== "failed") continue;
        if (Date.parse(r.created_at) < sinceMs) continue;
        signals.push({ subsystem: r.job_name, kind: "cron_failure", ref: r.job_name, at: r.created_at });
      }
      for (const d of [...webhooks, ...emails]) {
        if (Date.parse(d.created_at) < sinceMs) continue;
        const source = d.provider === "email" ? "email" : "webhook";
        signals.push({
          subsystem: `${source}:${d.provider ?? "unknown"}`,
          kind: "dead_letter",
          ref: d.id ?? "",
          at: d.created_at,
          detail: d.last_error ? redact(d.last_error) : undefined,
        });
      }
      for (const e of events) {
        if (e.severity !== "warning" && e.severity !== "critical") continue;
        signals.push({
          subsystem: e.source ?? e.type,
          kind: "ops_event",
          ref: e.id,
          at: e.created_at,
          detail: e.title ?? e.type,
        });
      }

      const incidents = correlateIncidents(signals, windowMs);
      return { incident_count: incidents.length, incidents };
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
    name: "get_grading_quality",
    description: "Weekly grading-quality telemetry pre-assembled into a memo: per-category + per-prompt-version accuracy (MAE/agreement), what regressed vs improved, calibration gaps, exemplar-pool coverage holes, and review-queue depth. Read-only; the Grading Quality agent's primary input.",
    class: "read",
    inputSchema: { type: "object", properties: {} },
    handler: async () => {
      const telemetry = await gatherGradingTelemetry();
      return { memo: assembleGradingMemo(telemetry), telemetry };
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
  {
    name: "get_integrations_health",
    description: "Integrations Watchdog memo (US-1604): pre-assembled vendor health verdicts (from ops events), the OAuth token-fleet expiry forecast (expired / 7d / 30d by marketplace), the key-rotation calendar (overdue / due-soon / baseline-needed, from KEY_ROTATION.md encoded as data), and an email deliverability watch. Read-about-credentials only — expiry metadata + cadences, never secret material.",
    class: "read",
    inputSchema: {
      type: "object",
      properties: { since_hours: { type: "integer", minimum: 1, maximum: 168, description: "ops-event window for vendor health" } },
    },
    handler: async (input, ctx) => {
      const sinceHours = typeof input.since_hours === "number" ? input.since_hours : 24;
      const sinceIso = new Date(ctx.now - sinceHours * 3600_000).toISOString();
      const [connections, opsEvents, emailDead, rotationState] = await Promise.all([
        ctx.io.fetchMarketplaceConnections(),
        ctx.io.fetchOpsEvents({ sinceIso, limit: 200 }),
        ctx.io.fetchEmailDeadLetters(500),
        ctx.io.fetchKeyRotationState(),
      ]);
      const memo = assembleIntegrationsMemo({
        connections,
        opsEvents: opsEvents.map((e) => ({
          type: e.type,
          severity: e.severity,
          source: e.source,
          created_at: e.created_at,
        })),
        rotationState,
        emailDeadLetters: emailDead.length,
        nowMs: ctx.now,
      });
      return { memo };
    },
  },
  {
    name: "get_finance_health",
    description: "Finance agent memo (US-1596): open billing-reconciliation divergences ranked by materiality (with evidence), affiliate + consignor payout-run sanity, a current-vs-trailing revenue delta, and the AI-spend-vs-revenue profitability doc (reuses the ai_profitability RPC). Read-only — the agent narrates and files tasks; it never moves money.",
    class: "read",
    inputSchema: {
      type: "object",
      properties: { since_days: { type: "integer", minimum: 1, maximum: 90, description: "payout-run lookback window" } },
    },
    handler: async (input, ctx) => {
      const sinceDays = clampInt(input.since_days, 7, 1, 90);
      const sinceIso = new Date(ctx.now - sinceDays * 24 * 3600_000).toISOString();
      // Two trailing 30-day windows for the revenue baseline comparison.
      const WIN = 30 * 24 * 3600_000;
      const curEnd = new Date(ctx.now).toISOString();
      const curStart = new Date(ctx.now - WIN).toISOString();
      const priorStart = new Date(ctx.now - 2 * WIN).toISOString();
      const [reconFlags, payouts, revenueCurrent, revenuePrior, aiProfitability] = await Promise.all([
        ctx.io.fetchReconciliationFlags(500),
        ctx.io.fetchRecentPayouts(sinceIso),
        ctx.io.rpc("revenue_dashboard", { p_start: curStart, p_end: curEnd, p_granularity: "day" }),
        ctx.io.rpc("revenue_dashboard", { p_start: priorStart, p_end: curStart, p_granularity: "day" }),
        ctx.io.rpc("ai_profitability", { p_period: "30d" }),
      ]);
      const memo = assembleFinanceMemo({
        reconFlags,
        affiliatePayouts: payouts.affiliate,
        consignorPayouts: payouts.consignor,
        revenueCurrent,
        revenuePrior,
        aiProfitability,
        nowMs: ctx.now,
      });
      return { memo };
    },
  },
  {
    name: "get_pricing_health",
    description: "Pricing agent memo (US-1601): cross-tenant repricing efficacy (apply-rate by reason code), ping-ponging listings (applied prices oscillating), churning automation rules, and price-guide / condition-curve staleness. Aggregates only — the agent audits and reports; it never edits a tenant's rules or prices.",
    class: "read",
    inputSchema: {
      type: "object",
      properties: { since_days: { type: "integer", minimum: 1, maximum: 90, description: "lookback window for suggestions + rule actions" } },
    },
    handler: async (input, ctx) => {
      const sinceDays = clampInt(input.since_days, 14, 1, 90);
      const sinceIso = new Date(ctx.now - sinceDays * 24 * 3600_000).toISOString();
      const [suggestions, actions, curves] = await Promise.all([
        ctx.io.fetchRepricingSuggestions(sinceIso),
        ctx.io.fetchAutomationActions(sinceIso),
        ctx.io.fetchCurveFreshness(),
      ]);
      const memo = assemblePricingMemo({ suggestions, actions, curves, nowMs: ctx.now });
      return { memo };
    },
  },
  {
    name: "get_marketplace_ops_health",
    description: "Marketplace Ops agent memo (US-1598): per-marketplace connection verdicts, generation + publish batch backlog (stuck/failed counts + the top stuck items with age and the reclaim cron that owns each), open sync-conflict + orphan-sale counts, and the backlog trend vs the prior run. Operator-scope aggregates only — no raw tenant rows or PII. Unstick paths go through existing reclaim/sweep jobs.",
    class: "read",
    inputSchema: { type: "object", properties: {} },
    handler: async (_input, ctx) => {
      const [connections, batches, openSyncConflicts, orphanSales, priorBacklogTotal] = await Promise.all([
        ctx.io.fetchMarketplaceConnections(),
        ctx.io.fetchListingBatches(),
        ctx.io.countOpenSyncConflicts(),
        ctx.io.countOrphanSales(),
        ctx.io.fetchMarketplaceOpsBacklog(),
      ]);
      const memo = assembleMarketplaceOpsMemo({
        connections,
        generationBatches: batches.generation,
        publishBatches: batches.publish,
        openSyncConflicts,
        orphanSales,
        priorBacklogTotal,
        nowMs: ctx.now,
      });
      // Record this run's backlog as the next run's "yesterday" (operator
      // bookkeeping only — a single integer watermark, no tenant data).
      await ctx.io.persistMarketplaceOpsBacklog(memo.backlog.total).catch(() => {});
      return { memo };
    },
  },
  {
    name: "get_trust_safety_health",
    description: "Trust & Safety agent memo (US-1597): open abuse signals ranked by severity (with rationale), cross-account rings (shared payment / phash / disposable-email signals spanning >=2 accounts, with the linked account ids as evidence), and open moderation + passport-integrity queue depths. Operator-scope ids + evidence only — no emails, titles, or image bytes.",
    class: "read",
    inputSchema: {
      type: "object",
      properties: { limit: { type: "integer", minimum: 1, maximum: 2000, description: "max open abuse signals to rank" } },
    },
    handler: async (input, ctx) => {
      const limit = clampInt(input.limit, 500, 1, 2000);
      const [abuseSignals, openModerationFlags, openPassportIntegritySignals] = await Promise.all([
        ctx.io.fetchAbuseSignals(limit),
        ctx.io.countOpenModerationFlags(),
        ctx.io.countOpenPassportIntegritySignals(),
      ]);
      const memo = assembleTrustSafetyMemo({
        abuseSignals,
        openModerationFlags,
        openPassportIntegritySignals,
        nowMs: ctx.now,
      });
      return { memo };
    },
  },

  // ── Write tools (class 'write') — NEVER exposed to the run loop; executed
  //    ONLY via executeWrite on the approved-proposal path (US-1587). Each is
  //    reversible/compensatable by design. ──
  {
    name: "retry_job",
    description: "Re-fire a registered scheduled job (cron) by its key over the internal job rails. Only jobs present in the cron registry are accepted.",
    class: "write",
    inputSchema: {
      type: "object",
      properties: { job_key: { type: "string", description: "the registered cron job name" } },
      required: ["job_key"],
    },
    handler: async (input, ctx) => {
      if (!ctx.authorizedBy) return { error: { code: "unauthorized", message: "write requires an approved proposal" } };
      const jobKey = String(input.job_key);
      const r = await ctx.io.runJob(jobKey);
      return { job: jobKey, ...r };
    },
  },
  {
    name: "requeue_dead_letter",
    description: "Re-queue a dead-lettered delivery so the retry machinery re-attempts it. v1 supports email dead-letters.",
    class: "write",
    inputSchema: {
      type: "object",
      properties: {
        source: { type: "string", enum: ["email", "webhook"] },
        id: { type: "string" },
      },
      required: ["source", "id"],
    },
    handler: async (input, ctx) => {
      if (!ctx.authorizedBy) return { error: { code: "unauthorized", message: "write requires an approved proposal" } };
      if (input.source !== "email") {
        return { error: { code: "unsupported", message: "webhook replay is not supported via the agent tool in v1; use the admin console" } };
      }
      const requeued = await ctx.io.requeueEmailDeadLetter(String(input.id));
      return { source: "email", id: String(input.id), requeued };
    },
  },
  {
    name: "create_admin_task",
    description: "File an admin task (in the standing 'Agent Proposals' project) for an operator to action.",
    class: "write",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string" },
        body: { type: "string" },
        priority: { type: "string", enum: ["low", "medium", "high"] },
      },
      required: ["title"],
    },
    handler: async (input, ctx) => {
      if (!ctx.authorizedBy) return { error: { code: "unauthorized", message: "write requires an approved proposal" } };
      const projectId = await ctx.io.resolveAgentTaskProject();
      if (!projectId) return { error: { code: "no_project", message: "could not resolve the Agent Proposals project" } };
      const task = await ctx.io.insertAdminTask({
        project_id: projectId,
        title: String(input.title),
        body: typeof input.body === "string" ? input.body : null,
        priority: typeof input.priority === "string" ? input.priority : "medium",
        created_by: ctx.authorizedBy ?? null,
      });
      return { task_id: task?.id ?? null };
    },
  },
  {
    name: "reorder_review_queue",
    description:
      "Recompute the information-value ranking of the pending human-review queue (US-1558 active-learning routing) and persist the recommended order + rationale as an advisory artifact so high-signal reviews surface first. Grade-safe: NEVER changes a grade, prompt, confidence threshold, or calibration — ordering only, and the queue keeps its SLA starvation guard.",
    class: "write",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "integer", minimum: 1, maximum: 500, description: "max pending reviews to rank" },
      },
    },
    handler: async (input, ctx) => {
      if (!ctx.authorizedBy) return { error: { code: "unauthorized", message: "write requires an approved proposal" } };
      const limit = clampInt(input.limit, 200, 1, 500);
      return await ctx.io.reorderReviewQueue({
        limit,
        authorizedBy: ctx.authorizedBy,
        proposalId: ctx.proposalId ?? null,
      });
    },
  },
];

// Map an agent_proposals.action_class → the write tool that executes it.
export const ACTION_CLASS_TO_TOOL: Record<string, string> = {
  retry_job: "retry_job",
  requeue_dead_letter: "requeue_dead_letter",
  file_task: "create_admin_task",
  // US-1658: the Grading Quality agent's review-queue reorder (adjust_queue).
  adjust_queue: "reorder_review_queue",
  // US-1597: Trust & Safety account actions route to an admin task on the fraud
  // console (never an auto-suspend); hard-capped at L1 so a human always signs
  // off. The proposal payload carries the {title, body} create_admin_task needs.
  suspend_account: "create_admin_task",
  require_step_up: "create_admin_task",
  deny_claim: "create_admin_task",
};

export const AGENT_TOOLS: readonly AgentToolDef[] = TOOL_LIST;
const BY_NAME = new Map(TOOL_LIST.map((t) => [t.name, t]));

// The per-agent allowlist: `config.tools` (US-1585) or the `tool_allowlist` alias.
function allowlistOf(agent: AgentRow): string[] {
  const t = agent.config?.tools ?? agent.config?.tool_allowlist;
  return Array.isArray(t) ? t.filter((x): x is string => typeof x === "string") : [];
}

// The kernel's AgentToolRegistry, plus the executeWrite path the proposal
// executor (US-1587) uses to run an approved write action.
export interface AgentToolRegistryV2 extends AgentToolRegistry {
  executeWrite(
    name: string,
    input: unknown,
    ctx: { authorizedBy: string; proposalId?: string | null },
  ): Promise<unknown>;
}

// ── The registry (implements the kernel's AgentToolRegistry seam) ────────────

export function createAgentToolRegistry(io: ToolIO = prodToolIO()): AgentToolRegistryV2 {
  // The run loop only ever sees READ tools — write tools are invisible + never
  // executable there (they run only via executeWrite on an approved proposal).
  const isReadAllowed = (agent: AgentRow, name: string): boolean => {
    const tool = BY_NAME.get(name);
    return !!tool && tool.class === "read" && allowlistOf(agent).includes(name);
  };
  return {
    anthropicTools(agent: AgentRow): Anthropic.Tool[] {
      const allow = new Set(allowlistOf(agent));
      return TOOL_LIST.filter((t) => t.class === "read" && allow.has(t.name)).map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.inputSchema as Anthropic.Tool["input_schema"],
      }));
    },
    isAllowed(agent: AgentRow, name: string): boolean {
      return isReadAllowed(agent, name);
    },
    async execute(agent: AgentRow, name: string, rawInput: unknown): Promise<unknown> {
      const tool = BY_NAME.get(name);
      if (!tool || !allowlistOf(agent).includes(name)) {
        return { error: { code: "tool_not_allowed", message: `tool not allowed: ${name}` } };
      }
      // A write tool can never run from the run loop — only via executeWrite.
      if (tool.class !== "read") {
        return { error: { code: "write_tool_forbidden", message: "write tools require an approved proposal" } };
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
    // Execute an approved write action. NOT allowlist-gated (operator approval is
    // the authorization); validates the tool exists + is a write tool, audits,
    // and runs the handler with the authorized context. Lets the handler throw
    // so the proposal executor can mark the proposal failed.
    async executeWrite(name: string, rawInput: unknown, ctx): Promise<unknown> {
      const tool = BY_NAME.get(name);
      if (!tool || tool.class !== "write") {
        return { error: { code: "not_a_write_tool", message: `not a write tool: ${name}` } };
      }
      const input = rawInput && typeof rawInput === "object" && !Array.isArray(rawInput)
        ? rawInput as Record<string, unknown>
        : {};
      const v = validateToolInput(tool.inputSchema, input);
      if (!v.ok) {
        return { error: { code: "invalid_input", message: "input failed schema validation", details: v.errors } };
      }
      await io.audit({
        action: "agent.write_tool_executed",
        targetType: "agent_tool",
        targetId: name,
        details: {
          tool: name,
          proposal_id: ctx.proposalId ?? null,
          authorized_by: ctx.authorizedBy,
          input: redact(v.value),
        },
      }).catch(() => {});
      const tctx: ToolContext = {
        io,
        agentKey: "",
        agentId: "",
        now: io.now(),
        authorizedBy: ctx.authorizedBy,
        proposalId: ctx.proposalId ?? null,
      };
      return await tool.handler(v.value, tctx);
    },
  };
}

// Default production registry (empty-IO-free): wired to the real infrastructure.
export const agentToolRegistry: AgentToolRegistryV2 = createAgentToolRegistry();
