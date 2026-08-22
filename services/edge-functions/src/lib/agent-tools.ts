// US-1585 / AGENTIC-OS Phase 0 (Module A): the agent tool registry v1.
//
// Agents see the world ONLY through this typed, allowlisted, audited registry
// (vault/70-agent/agentic-os-map.md §2 guardrails 1–2). v1 ships READ-ONLY tools that wrap EXISTING
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
import { unifiedHelpCorpusEnabled } from "./support-tools.ts";
import { fetchAllPages } from "./paged-read.ts";
import { isPlaceholderRelease, resolveRelease } from "./release-identity.ts";
import { aggregateJobStats, failingJobCount, isRunnableJob, type RawRun } from "./ops-jobs.ts";
import { CRON_REGISTRY, DEFAULT_JOB_SECRET_ENV } from "./cron-runs.ts";
import { correlateIncidents, type Signal } from "./sentinel.ts";
import { assembleGradingMemo, gatherGradingTelemetry } from "./grading-quality.ts";
import { assembleFinanceMemo, type PayoutRow, type ReconFlag } from "./finance-agent.ts";
import { centsToDollars } from "./affiliate-payout-math.ts";
import { assembleIntegrationsMemo, type RotationState } from "./integrations-watchdog.ts";
import { type ActionRow, assemblePricingMemo, type CurveRow, type SuggestionRow } from "./pricing-agent.ts";
import { assembleMarketplaceOpsMemo, type BatchRow } from "./marketplace-ops-agent.ts";
import { type AbuseSignal, assembleTrustSafetyMemo } from "./trust-safety-agent.ts";
import {
  type AgentLatestRun,
  assembleCeoBriefContext,
  type MetricInput,
  type PendingAction,
} from "./ceo-brief.ts";
import { assembleGrowthMemo } from "./growth-agent.ts";
import { assembleCronFleetReport, type JobRun, type MaintenanceInterval } from "./cron-fleet-governance.ts";
import {
  assembleReleaseMemo,
  compareRelease,
  detectDeploy,
  nextReleaseState,
  type ReleaseMetrics,
  type ReleaseState,
} from "./release-verify.ts";
import {
  assembleExperimentsMemo,
  type DripVariantRow,
  type NewsletterAbRow,
  normalizeDripVariants,
  normalizeNewsletterAb,
  normalizePromptRollout,
  type PromptRolloutRow,
} from "./experiments-governor.ts";
import {
  assembleTriageMemo,
  type KbEntry,
  normalizeClassification,
  prepareExcerpt,
  type TriageTicket,
} from "./support-triage.ts";
import {
  assembleMarketingPortfolioMemo,
  type ChannelWeek,
  type CoordinationStats,
  type SendDay,
  type TopicItem,
} from "./marketing-portfolio.ts";
import {
  assembleLifecycleMemo,
  type CohortWeek,
  type FunnelStep,
  type TrialCohort,
} from "./user-lifecycle.ts";
import { type ReorderReviewQueueResult, reorderReviewQueue } from "./review-queue-order.ts";
import { notifyUser } from "./notify.ts";
import { bustSettingCache, getSetting } from "./system-settings.ts";
import { marketingOptedOutEmail } from "./drip-graph.ts";

// US-1599: the shared marketing send cap setting (mirrors marketing-coordinator's
// FREQUENCY_CAP_SETTING; kept as a literal here to avoid importing the heavy
// coordinator module into the tool registry).
const MARKETING_FREQ_CAP_SETTING = "marketing_frequency_cap_per_day";
import { resolveRevenueWindow } from "./revenue-window.ts";
import { type AuditLogInput, writeSystemAuditLog } from "./audit-log.ts";
import { redact, redactError } from "./log-redact.ts";

// ── JSON-schema (minimal) validation ─────────────────────────────────────────

export interface JsonSchema {
  type: "object";
  properties?: Record<string, PropSchema>;
  required?: string[];
}
type PropType = "string" | "number" | "integer" | "boolean" | "array" | "object" | "null";
interface PropSchema {
  /** A single JSON-schema type, or a union (e.g. ["string","null"] for a nullable field). */
  type: PropType | PropType[];
  enum?: unknown[];
  minimum?: number;
  maximum?: number;
  description?: string;
  /** Element schema for `type: "array"` (recursive; the lenient validator doesn't descend). */
  items?: PropSchema;
  /** Nested object shape for `type: "object"` (recursive). */
  properties?: Record<string, PropSchema>;
  /** Required nested keys for `type: "object"`. */
  required?: string[];
}

export type Validation =
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; errors: string[] };

function typeOk(v: unknown, t: PropSchema["type"]): boolean {
  // A union type (e.g. ["string","null"]) passes if the value matches any member.
  if (Array.isArray(t)) return t.some((tt) => typeOk(v, tt));
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
    case "null":
      return v === null;
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
/**
 * The NORMALISED shape the agent reports, deliberately not either table's
 * row shape — the two disagree on both fields. webhook_dead_letters carries
 * `error_message` (00124) and `replay_attempts` (00206); email_deliveries
 * carries `last_error` and `attempts` (00095).
 *
 * US-2804: this interface used to name `last_error` and `attempt_count`, and
 * both queries selected those literally. `attempt_count` has never existed in
 * any migration, so PostgREST answered 42703 and the throw below fired on
 * every call. The comment on each read explains why an empty queue must never
 * be reported from a failed read; the read failed every time.
 */
interface DeadLetterRow {
  id: string | null;
  provider: string | null;
  last_error: string | null;
  attempt_count: number | null;
  created_at: string;
}

/** One dead-letter row as the two tables actually store it. */
interface RawDeadLetter {
  id: string | null;
  provider?: string | null;
  error_message?: string | null;
  last_error?: string | null;
  replay_attempts?: number | null;
  attempts?: number | null;
  created_at: string;
}

const normalizeDeadLetter = (
  r: RawDeadLetter,
  provider: string,
): DeadLetterRow => ({
  id: r.id,
  provider: r.provider ?? provider,
  last_error: r.error_message ?? r.last_error ?? null,
  attempt_count: r.replay_attempts ?? r.attempts ?? null,
  created_at: r.created_at,
});
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
  // US-1603: the CEO Brief bundle — the seeded fleet, north-star metrics (this
  // week vs last), each agent's latest succeeded run summary, and pending
  // proposals. Operator-scope aggregates + agent-run summaries only, no PII.
  fetchCeoBriefData(nowMs: number): Promise<{
    agents: Array<{ key: string; name: string }>;
    metrics: MetricInput[];
    latestRuns: AgentLatestRun[];
    pendingProposals: PendingAction[];
  }>;
  // US-1602: referral-program volume in a window + the agent's own prior run
  // outcome (the last experiment slate, for week-over-week continuity).
  fetchReferralCounts(curStartIso: string, curEndIso: string, priorStartIso: string): Promise<{ current: number; prior: number }>;
  fetchAgentPriorOutcome(agentId: string): Promise<unknown>;
  // US-1611: maintenance windows overlapping the lookback (to suppress missed-
  // tick false alarms). Open-ended windows → endMs Infinity.
  fetchMaintenanceIntervals(sinceIso: string): Promise<MaintenanceInterval[]>;
  // US-1610: the running release SHA (RELEASE_SHA env) + the persisted release
  // verification state (last SHA + pre-deploy baseline). Operator bookkeeping.
  releaseSha(): string | null;
  fetchReleaseState(): Promise<ReleaseState | null>;
  persistReleaseState(state: ReleaseState): Promise<void>;
  // US-1610: run a lightweight in-process smoke (the internal /health endpoint).
  runSmoke(): Promise<{ ok: boolean; status: number; error?: string }>;
  // US-1609: live-experiment sources for the Experiments Governor. Each is
  // best-effort (a missing/legacy engine returns []). No tenant data — these are
  // platform-wide experiment definitions, not per-user rows.
  fetchNewsletterAbTests(): Promise<NewsletterAbRow[]>;
  fetchPromptRollouts(): Promise<PromptRolloutRow[]>;
  fetchDripVariants(sinceIso: string): Promise<DripVariantRow[]>;
  // US-1595: Support Triage sources + writes. Untriaged = open + unassigned +
  // not-yet-triaged tickets with their first user message (excerpt); the KB
  // catalog is the suggestion vocabulary. Reads carry raw text — the tool
  // redacts via prepareExcerpt before it leaves the process.
  fetchUntriagedTickets(limit: number): Promise<Array<{ id: string; subject: string; excerpt: string; created_at: string; priority: string; status: string }>>;
  fetchKbCatalog(limit: number): Promise<KbEntry[]>;
  // Write-side (approved proposals only): persist a classification batch onto the
  // ticket rows, and send an operator-approved reply through the support path.
  persistTicketTriage(
    items: Array<{ ticket_id: string; category: string; severity: string; kb_slug: string | null }>,
    nowIso: string,
  ): Promise<{ updated: number }>;
  sendSupportReply(
    input: { ticketId: string; body: string; adminId: string },
  ): Promise<{ ok: boolean; error?: string }>;
  // US-1599: Marketing Portfolio cross-channel sources + engine-level writes.
  // All operator/aggregate data — no per-subscriber rows. Reads are best-effort
  // (a missing source returns an empty rollup).
  fetchMarketingPortfolio(nowMs: number): Promise<{
    weeks: ChannelWeek[];
    topics: TopicItem[];
    sendDays: SendDay[];
    coordination: CoordinationStats;
  }>;
  addMarketingTopic(
    input:
      | { bank: "email"; pillar: string; angle: string; label: string; summary: string }
      | { bank: "content"; surface: string; product: string; title: string; primary_keyword: string; angle: string | null },
  ): Promise<{ inserted: boolean; id: string | null }>;
  setMarketingFrequencyCap(capPerDay: number): Promise<{ cap_per_day: number }>;
  // US-1600: User Lifecycle. Cohort-AGGREGATE reads (no per-user rows leave the
  // seam) + a cohort-enroll write. enrollCohort resolves a whitelisted cohort
  // server-side (never a model-supplied id list), honors marketing opt-out +
  // already-enrolled dedup, and is hard-capped.
  fetchUserLifecycle(nowMs: number): Promise<{
    funnel: FunnelStep[];
    current: CohortWeek;
    prior: CohortWeek;
    trialCohorts: TrialCohort[];
  }>;
  enrollCohort(input: { cohort: string; campaign: string; nowIso: string }): Promise<{ enrolled: number; cohort: string; campaign: string; error?: string }>;
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
      const { data, error: e0 } = await supabaseAdmin
        .from("cron_runs")
        .select("job_name, status, http_status, duration_ms, rows_processed, triggered_by, created_at")
        .order("created_at", { ascending: false })
        .limit(limit);
      if (e0) throw new Error(`fetchCronRuns failed: ${e0.message}`);
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
      const { data, error } = await supabaseAdmin
        .from("webhook_dead_letters")
        .select("id, provider, error_message, replay_attempts, created_at")
        .eq("status", "unresolved")
        .order("created_at", { ascending: true })
        .limit(limit);
      // An empty dead-letter queue means NOTHING IS STUCK, which is the single
      // most reassuring thing this agent can report. A failed read must not be
      // able to say it. Throwing surfaces a tool_error instead; the dispatcher
      // wraps every handler, so this cannot crash the run.
      if (error) throw new Error(`fetchWebhookDeadLetters failed: ${error.message}`);
      return ((data ?? []) as RawDeadLetter[])
        .map((r) => normalizeDeadLetter(r, "webhook"));
    },
    fetchEmailDeadLetters: async (limit) => {
      const { data, error } = await supabaseAdmin
        .from("email_deliveries")
        .select("id, last_error, attempts, created_at")
        .eq("status", "dead_letter")
        .order("created_at", { ascending: true })
        .limit(limit);
      // An empty dead-letter queue means NOTHING IS STUCK, which is the single
      // most reassuring thing this agent can report. A failed read must not be
      // able to say it. Throwing surfaces a tool_error instead; the dispatcher
      // wraps every handler, so this cannot crash the run.
      if (error) throw new Error(`fetchEmailDeadLetters failed: ${error.message}`);
      return ((data ?? []) as RawDeadLetter[])
        .map((r) => normalizeDeadLetter(r, "email"));
    },
    countSupportTickets: async (status) => {
      const { count, error: e0 } = await supabaseAdmin
        .from("support_tickets")
        .select("id", { count: "exact", head: true })
        .eq("status", status);
      if (e0) throw new Error(`countSupportTickets failed: ${e0.message}`);
      return count ?? 0;
    },
    // US-2387: paged, not capped. get_marketplace_health reports AGGREGATE
    // COUNTS to an operator (active / inactive / error / expiring-soon, and a
    // per-marketplace breakdown), so a `.limit(N)` here would not bound the
    // work — it would make every one of those numbers quietly wrong, and wrong
    // in the direction that looks healthy. "3 connections erroring" computed
    // over an arbitrary first slice reads exactly like "3 connections erroring"
    // computed over the fleet.
    //
    // fetchAllPages is exact and still bounded per request, which is the whole
    // reason it exists: it advances by rows RECEIVED and stops only on an EMPTY
    // response, so it is correct whatever `db-max-rows` turns out to be.
    // Ordered by id because an unordered page walk can repeat and skip rows
    // across requests — PostgREST gives no stable order without one, and for a
    // counting read that is silent double-counting.
    fetchMarketplaceConnections: async () => {
      return await fetchAllPages<ConnRow>(async (from, to) => {
        const { data, error } = await supabaseAdmin
          .from("marketplace_connections")
          .select("marketplace, is_active, token_expires_at, refresh_error")
          .order("id", { ascending: true })
          .range(from, to);
        // THROW rather than return [] — a swallowed error is indistinguishable
        // from the end of the data, and here that means reporting a healthy
        // fleet because the read failed.
        if (error) throw new Error(error.message);
        return (data ?? []) as ConnRow[];
      });
    },
    rpc: async (name, args) => {
      // THROW, do not return null. This destructured only `data`, and
      // supabase-js answers { data: null, error } on failure — so a failing RPC
      // became a silent null that the model then reasoned over.
      //
      // It was not hypothetical: revenue_dashboard raises 42703 on EVERY call
      // (US-2663 — its trial cohort selects users.trial_started_at, a column
      // that has never existed on that table), and get_revenue answered
      // { window, revenue: null } with no error for as long as that has been
      // true. Nine io.rpc call sites across five RPCs degraded the same way.
      //
      // system_health is the sharper case: it legitimately refuses an
      // unprivileged caller with 42501, and swallowing that made "healthy but
      // empty" and "not allowed to look" the same answer.
      //
      // Throwing is safe and is the established shape here — fetchMarketplaceConnections
      // directly above does exactly this, for the same stated reason ("here that
      // means reporting a healthy fleet because the read failed"), and the tool
      // dispatcher wraps every handler, turning a throw into a visible
      // { error: { code: "tool_error" } } rather than a crash.
      const { data, error } = await supabaseAdmin.rpc(name, (args ?? {}) as never);
      if (error) throw new Error(`rpc ${name} failed: ${error.message}`);
      return data;
    },
    audit: (input) => writeSystemAuditLog(input),
    now: () => Date.now(),
    fetchKeyRotationState: async () => {
      const { data, error: e0 } = await supabaseAdmin
        .from("system_settings")
        .select("value")
        .eq("key", "security.key_rotation_state")
        .maybeSingle();
      if (e0) throw new Error(`fetchKeyRotationState failed: ${e0.message}`);
      const v = (data as { value?: unknown } | null)?.value;
      return v && typeof v === "object" && !Array.isArray(v) ? v as RotationState : {};
    },
    fetchReconciliationFlags: async (limit) => {
      const { data, error: e0 } = await supabaseAdmin
        .from("billing_reconciliation_flags")
        .select("subject_user_id, kind, db_status, expected_status, db_plan, expected_plan, detected_at")
        .eq("status", "open")
        .order("detected_at", { ascending: true })
        .limit(limit);
      if (e0) throw new Error(`fetchReconciliationFlags failed: ${e0.message}`);
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
        // affiliate_payouts.amount is INTEGER CENTS since US-1655 — convert to USD
        // dollars so the finance memo's dollar math matches consignor_payouts
        // (still numeric dollars) and its $-formatted output.
        affiliate: ((aff ?? []) as Array<Record<string, unknown>>).map((r) => ({
          status: String(r.status), amount: centsToDollars(Number(r.amount ?? 0)),
          error: (r.error as string | null) ?? null, created_at: String(r.created_at),
        })),
        consignor: ((cons ?? []) as Array<Record<string, unknown>>).map((r) => ({
          status: String(r.status), amount: Number(r.amount ?? 0),
          error: (r.error as string | null) ?? null, created_at: String(r.created_at),
        })),
      };
    },
    fetchRepricingSuggestions: async (sinceIso) => {
      const { data, error: e0 } = await supabaseAdmin
        .from("repricing_suggestions")
        .select("listing_id, user_id, reason_code, status, suggested_price_cents, applied_at, created_at")
        .gte("created_at", sinceIso)
        .limit(5000);
      if (e0) throw new Error(`fetchRepricingSuggestions failed: ${e0.message}`);
      return (data ?? []) as SuggestionRow[];
    },
    fetchAutomationActions: async (sinceIso) => {
      const { data, error: e0 } = await supabaseAdmin
        .from("flipdesk_automation_actions")
        .select("rule_id, user_id, listing_id, action_type, created_at")
        .gte("created_at", sinceIso)
        .limit(5000);
      if (e0) throw new Error(`fetchAutomationActions failed: ${e0.message}`);
      return (data ?? []) as ActionRow[];
    },
    fetchCurveFreshness: async () => {
      const { data, error: e0 } = await supabaseAdmin
        .from("condition_price_curves")
        .select("category_id, refreshed_at")
        .order("refreshed_at", { ascending: true })
        .limit(2000);
      if (e0) throw new Error(`fetchCurveFreshness failed: ${e0.message}`);
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
      const { count, error } = await supabaseAdmin
        .from("flipdesk_sync_conflicts")
        .select("id", { count: "exact", head: true })
        .is("resolved_at", null);
      // A failed read must not read as zero. This counts OPEN problems, so
      // returning 0 on an error tells the agent — and then a human — that
      // there are none. Throwing surfaces it as a tool_error instead; the
      // dispatcher wraps every handler, so this cannot crash the run.
      if (error) throw new Error(`countOpenSyncConflicts failed: ${error.message}`);
      return count ?? 0;
    },
    countOrphanSales: async () => {
      const { count, error } = await supabaseAdmin
        .from("flipdesk_ebay_orphan_sales")
        .select("id", { count: "exact", head: true });
      // A failed read must not read as zero. This counts OPEN problems, so
      // returning 0 on an error tells the agent — and then a human — that
      // there are none. Throwing surfaces it as a tool_error instead; the
      // dispatcher wraps every handler, so this cannot crash the run.
      if (error) throw new Error(`countOrphanSales failed: ${error.message}`);
      return count ?? 0;
    },
    fetchMarketplaceOpsBacklog: async () => {
      const { data, error: e0 } = await supabaseAdmin
        .from("system_settings")
        .select("value")
        .eq("key", "marketplace_ops.backlog_snapshot")
        .maybeSingle();
      if (e0) throw new Error(`fetchMarketplaceOpsBacklog failed: ${e0.message}`);
      const v = (data as { value?: { total?: unknown } } | null)?.value?.total;
      return typeof v === "number" && Number.isFinite(v) ? v : null;
    },
    persistMarketplaceOpsBacklog: async (total) => {
      // US-2664 AC4: silent on failure, and the damage lands a day later. This
      // is the watermark the vs-yesterday trend is computed against, so a lost
      // write does not show up as a missing number — it shows up as a WRONG
      // delta tomorrow, which nobody reads as a bug.
      const { error } = await supabaseAdmin.from("system_settings").upsert(
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
      if (error) throw new Error(`persistMarketplaceOpsBacklog failed: ${error.message}`);
    },
    fetchAbuseSignals: async (limit) => {
      const { data, error: e0 } = await supabaseAdmin
        .from("abuse_signals")
        .select("id, signal_type, severity, subject_user_id, evidence, first_seen_at")
        .eq("status", "open")
        .order("first_seen_at", { ascending: true })
        .limit(limit);
      if (e0) throw new Error(`fetchAbuseSignals failed: ${e0.message}`);
      return (data ?? []) as AbuseSignal[];
    },
    countOpenModerationFlags: async () => {
      const { count, error } = await supabaseAdmin
        .from("content_moderation_flags")
        .select("id", { count: "exact", head: true })
        .eq("status", "open");
      // A failed read must not read as zero. This counts OPEN problems, so
      // returning 0 on an error tells the agent — and then a human — that
      // there are none. Throwing surfaces it as a tool_error instead; the
      // dispatcher wraps every handler, so this cannot crash the run.
      if (error) throw new Error(`countOpenModerationFlags failed: ${error.message}`);
      return count ?? 0;
    },
    countOpenPassportIntegritySignals: async () => {
      const { count, error } = await supabaseAdmin
        .from("passport_integrity_signals")
        .select("id", { count: "exact", head: true });
      // A failed read must not read as zero. This counts OPEN problems, so
      // returning 0 on an error tells the agent — and then a human — that
      // there are none. Throwing surfaces it as a tool_error instead; the
      // dispatcher wraps every handler, so this cannot crash the run.
      if (error) throw new Error(`countOpenPassportIntegritySignals failed: ${error.message}`);
      return count ?? 0;
    },
    fetchCeoBriefData: async (nowMs) => {
      const WEEK = 7 * 24 * 3600_000;
      const curStart = new Date(nowMs - WEEK).toISOString();
      const priorStart = new Date(nowMs - 2 * WEEK).toISOString();
      const nowIso = new Date(nowMs).toISOString();
      // A cross-tenant count in [start, end) — operator KPI, never a row.
      const countWindow = async (table: string, startIso: string, endIso: string): Promise<number> => {
        const { count, error: e0 } = await supabaseAdmin
          .from(table)
          .select("id", { count: "exact", head: true })
          .gte("created_at", startIso)
          .lt("created_at", endIso);
        if (e0) throw new Error(`fetchCeoBriefData failed: ${e0.message}`);
        return count ?? 0;
      };
      const metricSpecs: Array<{ name: string; table: string }> = [
        { name: "New signups", table: "users" },
        { name: "Grades issued", table: "grade_reports" },
        { name: "Listings created", table: "listings" },
      ];
      const [agentRows, runRows, proposalRows, ...metricCounts] = await Promise.all([
        supabaseAdmin.from("agents").select("id, key, name"),
        supabaseAdmin.from("agent_runs")
          .select("agent_id, status, outcome, finished_at")
          .eq("status", "succeeded").gte("finished_at", priorStart)
          .order("finished_at", { ascending: false }).limit(1000),
        supabaseAdmin.from("agent_proposals")
          .select("id, agent_id, title").eq("status", "pending").limit(200),
        ...metricSpecs.flatMap((m) => [countWindow(m.table, curStart, nowIso), countWindow(m.table, priorStart, curStart)]),
      ]);
      const agents = ((agentRows.data ?? []) as Array<{ id: string; key: string; name: string }>);
      const keyById = new Map(agents.map((a) => [a.id, a.key]));
      const metrics: MetricInput[] = metricSpecs.map((m, i) => ({
        name: m.name,
        current: (metricCounts[i * 2] as number) ?? 0,
        prior: (metricCounts[i * 2 + 1] as number) ?? 0,
      }));
      // Latest succeeded run per agent (rows are finished_at desc → first wins).
      const seenAgent = new Set<string>();
      const latestRuns: AgentLatestRun[] = [];
      for (const r of (runRows.data ?? []) as Array<{ agent_id: string; status: string; outcome: unknown; finished_at: string | null }>) {
        if (seenAgent.has(r.agent_id)) continue;
        seenAgent.add(r.agent_id);
        const summary = r.outcome && typeof r.outcome === "object"
          ? (r.outcome as { summary?: unknown }).summary
          : null;
        latestRuns.push({
          agent_key: keyById.get(r.agent_id) ?? "(unknown)",
          status: r.status,
          summary: typeof summary === "string" ? summary : null,
          ran_at: r.finished_at,
        });
      }
      const pendingProposals: PendingAction[] = ((proposalRows.data ?? []) as Array<{ id: string; agent_id: string; title: string }>)
        .map((p) => ({ id: p.id, agent_key: keyById.get(p.agent_id) ?? "(unknown)", title: p.title }));
      return { agents: agents.map((a) => ({ key: a.key, name: a.name })), metrics, latestRuns, pendingProposals };
    },
    fetchReferralCounts: async (curStartIso, curEndIso, priorStartIso) => {
      const countWindow = async (startIso: string, endIso: string): Promise<number> => {
        const { count, error: e0 } = await supabaseAdmin
          .from("referral_events")
          .select("id", { count: "exact", head: true })
          .gte("created_at", startIso)
          .lt("created_at", endIso);
        if (e0) throw new Error(`fetchReferralCounts failed: ${e0.message}`);
        return count ?? 0;
      };
      const [current, prior] = await Promise.all([
        countWindow(curStartIso, curEndIso),
        countWindow(priorStartIso, curStartIso),
      ]);
      return { current, prior };
    },
    fetchAgentPriorOutcome: async (agentId) => {
      const { data, error: e0 } = await supabaseAdmin
        .from("agent_runs")
        .select("outcome")
        .eq("agent_id", agentId)
        .eq("status", "succeeded")
        .order("finished_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (e0) throw new Error(`fetchAgentPriorOutcome failed: ${e0.message}`);
      return (data as { outcome?: unknown } | null)?.outcome ?? null;
    },
    // US-2001: resolve across every release env key and treat a placeholder as
    // ABSENT, returning null. This read had the same defect as observability.ts:
    // the image always sets RELEASE_SHA (to "dev" when no build arg is passed),
    // so this returned the string "dev" forever. US-1610 detects a deploy by
    // watching this value CHANGE — a constant "dev" is not an error state, it is
    // a value that never changes, so the release-verify agent has been reporting
    // "no deploy" on every run since it shipped rather than failing loudly.
    // null is deliberate over "unknown": no identity must stay distinguishable
    // from an identity, or the same blindness returns wearing a different word.
    releaseSha: () => {
      const r = resolveRelease((k) => Deno.env.get(k));
      return isPlaceholderRelease(r) ? null : r;
    },
    fetchReleaseState: async () => {
      const { data, error: e0 } = await supabaseAdmin
        .from("system_settings").select("value").eq("key", "release.verify_state").maybeSingle();
      if (e0) throw new Error(`fetchReleaseState failed: ${e0.message}`);
      const v = (data as { value?: unknown } | null)?.value;
      return v && typeof v === "object" && !Array.isArray(v) ? v as ReleaseState : null;
    },
    persistReleaseState: async (state) => {
      // US-2664 AC4: a WRITE that fails silently is worse than a read that
      // does. This one has no return value at all, so the caller's only
      // evidence that the state was recorded is that nothing threw — and
      // without the binding, nothing ever throws. The next release check would
      // then compare against a baseline that was never stored.
      const { error } = await supabaseAdmin.from("system_settings").upsert(
        {
          key: "release.verify_state",
          value: state,
          value_type: "json",
          default_value: { last_sha: null, baseline: null, checked_at: null },
          description: "US-1610 release verification state (last SHA + pre-deploy health baseline)",
          category: "agents",
        },
        { onConflict: "key" },
      );
      if (error) throw new Error(`persistReleaseState failed: ${error.message}`);
    },
    runSmoke: async () => {
      const base = `http://localhost:${Deno.env.get("PORT") || "8787"}`;
      try {
        const res = await fetch(`${base}/health`, { signal: AbortSignal.timeout(15_000) });
        return { ok: res.ok, status: res.status };
      } catch (err) {
        return { ok: false, status: 0, error: err instanceof Error ? err.message : "fetch_failed" };
      }
    },
    fetchNewsletterAbTests: async () => {
      // Only LIVE tests (ab_phase='testing'); the adapter filters again defensively.
      const { data, error: e0 } = await supabaseAdmin
        .from("newsletter_issues")
        .select("id, ab_phase, ab_metric, subject_variants, ab_test_started_at, ab_measurement_hours, ab_winner_variant")
        .eq("ab_phase", "testing")
        .limit(100);
      if (e0) throw new Error(`fetchNewsletterAbTests failed: ${e0.message}`);
      return ((data ?? []) as Array<Record<string, unknown>>).map((r) => ({
        id: String(r.id),
        ab_phase: String(r.ab_phase ?? "none"),
        ab_metric: String(r.ab_metric ?? "open"),
        subject_variants: Array.isArray(r.subject_variants) ? r.subject_variants as Array<{ id: string; subject?: string }> : [],
        ab_test_started_at: (r.ab_test_started_at as string | null) ?? null,
        ab_measurement_hours: (r.ab_measurement_hours as number | null) ?? null,
        ab_winner_variant: (r.ab_winner_variant as string | null) ?? null,
      }));
    },
    fetchPromptRollouts: async () => {
      // Live grading-prompt canaries (US-896): is_canary with a 0<pct<100 slice.
      const { data, error: e0 } = await supabaseAdmin
        .from("ai_prompt_versions")
        .select("version_name, stage, garment_scope, is_canary, rollout_percentage, rollout_started_at")
        .eq("is_canary", true)
        .limit(100);
      if (e0) throw new Error(`fetchPromptRollouts failed: ${e0.message}`);
      return ((data ?? []) as Array<Record<string, unknown>>).map((r) => ({
        version_name: String(r.version_name ?? ""),
        stage: String(r.stage ?? ""),
        garment_scope: (r.garment_scope as string | null) ?? null,
        is_canary: Boolean(r.is_canary),
        rollout_percentage: (r.rollout_percentage as number | null) ?? null,
        rollout_started_at: (r.rollout_started_at as string | null) ?? null,
      }));
    },
    fetchDripVariants: async (sinceIso) => {
      // Aggregate enrollments in the window by (campaign, variant): sends = the
      // enrolled cohort, conversions = those that converted. A/B arms only.
      const { data, error: e0 } = await supabaseAdmin
        .from("drip_enrollments")
        .select("campaign, variant, enrolled_at, converted_at")
        .gte("enrolled_at", sinceIso)
        .not("variant", "is", null)
        .limit(20000);
      if (e0) throw new Error(`fetchDripVariants failed: ${e0.message}`);
      const rows = (data ?? []) as Array<{ campaign: string; variant: string | null; enrolled_at: string | null; converted_at: string | null }>;
      const agg = new Map<string, DripVariantRow>();
      for (const r of rows) {
        if (!r.variant) continue;
        const key = `${r.campaign}${r.variant}`;
        const cur = agg.get(key) ?? { campaign: r.campaign, variant: r.variant, sends: 0, conversions: 0, started_at: r.enrolled_at };
        cur.sends += 1;
        if (r.converted_at) cur.conversions += 1;
        if (r.enrolled_at && (!cur.started_at || r.enrolled_at < cur.started_at)) cur.started_at = r.enrolled_at;
        agg.set(key, cur);
      }
      return [...agg.values()];
    },
    fetchUntriagedTickets: async (limit) => {
      // New/unassigned open tickets that haven't been triaged yet.
      const { data, error: e1 } = await supabaseAdmin
        .from("support_tickets")
        .select("id, subject, priority, status, created_at")
        .in("status", ["open", "pending"])
        .is("assigned_admin_id", null)
        .is("triaged_at", null)
        .order("created_at", { ascending: true })
        .limit(limit);
      if (e1) throw new Error(`fetchUntriagedTickets failed: ${e1.message}`);
      const tickets = (data ?? []) as Array<{ id: string; subject: string; priority: string; status: string; created_at: string }>;
      if (tickets.length === 0) return [];
      // First user message per ticket for the excerpt (one query, then bucket).
      const ids = tickets.map((t) => t.id);
      const { data: msgs, error: e0 } = await supabaseAdmin
        .from("support_ticket_messages")
        .select("ticket_id, body, created_at, is_internal_note")
        .in("ticket_id", ids)
        .eq("is_internal_note", false)
        .order("created_at", { ascending: true });
      if (e0) throw new Error(`fetchUntriagedTickets failed: ${e0.message}`);
      const firstBody = new Map<string, string>();
      for (const m of (msgs ?? []) as Array<{ ticket_id: string; body: string }>) {
        if (!firstBody.has(m.ticket_id)) firstBody.set(m.ticket_id, m.body ?? "");
      }
      return tickets.map((t) => ({
        id: t.id,
        subject: t.subject,
        excerpt: firstBody.get(t.id) ?? "",
        created_at: t.created_at,
        priority: t.priority,
        status: t.status,
      }));
    },
    fetchKbCatalog: async (limit) => {
      // US-2594: same flag as the retrieval tool, and it must move WITH it —
      // a catalog listing one corpus while search reads the other would offer
      // the operator titles the assistant cannot then quote.
      //
      // PUBLIC ONLY on the help side. This catalog exists to show what the
      // assistant can answer from, and the widest audience it answers is the
      // anonymous one; listing `members` titles here would advertise articles
      // most askers cannot be shown.
      // US-2664: an empty catalog says "the assistant has nothing to answer
      // from", which is a real and alarming answer — and was also what a failed
      // read produced. The corpus is EMPTY in production today (US-2618), so
      // the two states look identical from the outside, which is exactly when
      // the distinction is worth having.
      const { data, error } = unifiedHelpCorpusEnabled()
        ? await supabaseAdmin
          .from("help_articles")
          .select("slug, title")
          .eq("status", "published")
          .eq("visibility", "public")
          .order("title", { ascending: true })
          .limit(limit)
        : await supabaseAdmin
          .from("support_kb_articles")
          .select("slug, title")
          .eq("is_published", true)
          .order("title", { ascending: true })
          .limit(limit);
      if (error) throw new Error(`fetchKbCatalog failed: ${error.message}`);
      return ((data ?? []) as Array<{ slug: string; title: string }>).map((r) => ({ slug: String(r.slug), title: String(r.title) }));
    },
    persistTicketTriage: async (items, nowIso) => {
      // Each write is id-scoped; a ticket id is operator-supplied via an approved
      // proposal but we still update strictly by primary key (no cross-tenant
      // surface — support_tickets has no workspace fan-out).
      let updated = 0;
      for (const it of items) {
        const { error, count } = await supabaseAdmin
          .from("support_tickets")
          .update({
            triage_category: it.category,
            triage_severity: it.severity,
            triage_kb_slug: it.kb_slug,
            triaged_at: nowIso,
          } as never, { count: "exact" })
          .eq("id", it.ticket_id);
        // US-2664 AC3: DELIBERATELY does not throw, and this line is why. The
        // loop triages many tickets; `updated` is a count of the ones that
        // actually changed, so a row that failed is already excluded from the
        // answer rather than hidden inside it. Throwing would abandon the
        // tickets after it for the sake of the one that failed, and the caller
        // can already see updated < requested.
        if (!error && (count ?? 0) > 0) updated++;
      }
      return { updated };
    },
    sendSupportReply: async ({ ticketId, body, adminId }) => {
      const { data: ticket, error: e0 } = await supabaseAdmin
        .from("support_tickets")
        .select("id, user_id, subject, status")
        .eq("id", ticketId)
        .maybeSingle();
      if (e0) throw new Error(`sendSupportReply failed: ${e0.message}`);
      if (!ticket) return { ok: false, error: "ticket_not_found" };
      const t = ticket as { user_id: string; subject: string; status: string };
      const { error: insErr } = await supabaseAdmin
        .from("support_ticket_messages")
        .insert({ ticket_id: ticketId, author_user_id: adminId, body, is_internal_note: false } as never);
      if (insErr) return { ok: false, error: "reply_insert_failed" };
      // Bump activity + move an open/pending ticket to 'pending' (awaiting user),
      // and assign to the approving admin — mirrors the /reply route (00223).
      const updates: Record<string, unknown> = { assigned_admin_id: adminId, last_message_at: new Date().toISOString() };
      if (t.status === "open" || t.status === "pending") updates.status = "pending";
      // US-2664 AC3/AC4: unguarded ON PURPOSE. The reply is already saved and
      // the customer will receive it; this is a status bump. Failing the whole
      // tool here would tell the operator the reply was not sent when it was,
      // which is a worse lie than a ticket left in the wrong column.
      await supabaseAdmin.from("support_tickets").update(updates as never).eq("id", ticketId);
      // Notify the user (best-effort; a failed notify never fails the saved reply).
      await notifyUser(t.user_id, {
        type: "system",
        title: "Support replied to your ticket",
        message: "A support agent has replied. Open your support inbox to read it.",
        link: "/dashboard/support",
      }).catch(() => {});
      return { ok: true };
    },
    fetchMarketingPortfolio: async (nowMs) => {
      const WEEK = 7 * 86400_000;
      const weekAgo = new Date(nowMs - WEEK).toISOString();
      const twoWeeks = new Date(nowMs - 2 * WEEK).toISOString();
      // Map a marketing_send_log source → the broadcast channel it belongs to.
      const sourceChannel = (src: string): "newsletter" | "drip" | null =>
        src === "weekly_newsletter" ? "newsletter" : (src === "trial_drip" || src === "win_back" || src === "journey") ? "drip" : null;

      // ── Coordination + collision from marketing_send_log (last 2 weeks) ──
      const { data: sendLog, error: e5 } = await supabaseAdmin
        .from("marketing_send_log")
        .select("recipient, source, sent_at")
        .gte("sent_at", twoWeeks)
        .limit(10000);
      if (e5) throw new Error(`fetchMarketingPortfolio failed: ${e5.message}`);
      const logRows = (sendLog ?? []) as Array<{ recipient: string; source: string; sent_at: string }>;
      // max sends any single recipient got in a day (the cap is per-recipient/day).
      const perRecipientDay = new Map<string, number>();
      // per-day set of distinct broadcast channels (this-week window) for collision.
      const dayChannels = new Map<string, Set<"newsletter" | "drip">>();
      // per-channel weekly volume (this vs prior week).
      const vol = { newsletter: [0, 0], drip: [0, 0] };
      for (const r of logRows) {
        const ts = Date.parse(r.sent_at);
        const day = r.sent_at.slice(0, 10);
        perRecipientDay.set(`${r.recipient}|${day}`, (perRecipientDay.get(`${r.recipient}|${day}`) ?? 0) + 1);
        const ch = sourceChannel(r.source);
        if (ch) {
          const idx = ts >= Date.parse(weekAgo) ? 0 : 1;
          vol[ch][idx] += 1;
          if (idx === 0) {
            const set = dayChannels.get(day) ?? new Set();
            set.add(ch);
            dayChannels.set(day, set);
          }
        }
      }
      const maxObserved = perRecipientDay.size ? Math.max(...perRecipientDay.values()) : 0;
      const capPerDay = await getSetting<number>(MARKETING_FREQ_CAP_SETTING, 1);
      const coordination: CoordinationStats = {
        cap_per_day: typeof capPerDay === "number" ? capPerDay : 1,
        max_observed_per_day: maxObserved,
        deferred_or_dropped: 0, // send-log records sends only; deferrals aren't logged here
      };
      const sendDays: SendDay[] = [...dayChannels.entries()].map(([date, chs]) => ({ date, channels: [...chs] }));

      // ── Drip channel week (enrollments this vs prior week + conversions) ──
      const { data: drip, error: e4 } = await supabaseAdmin
        .from("drip_enrollments")
        .select("enrolled_at, converted_at")
        .gte("enrolled_at", twoWeeks)
        .limit(20000);
      if (e4) throw new Error(`fetchMarketingPortfolio failed: ${e4.message}`);
      let dThis = 0, dPrior = 0, dConv = 0;
      for (const r of (drip ?? []) as Array<{ enrolled_at: string; converted_at: string | null }>) {
        if (Date.parse(r.enrolled_at) >= Date.parse(weekAgo)) { dThis++; if (r.converted_at) dConv++; } else dPrior++;
      }

      // ── Newsletter channel week (issues sent this vs prior week) ──
      const { data: issues, error: e3 } = await supabaseAdmin
        .from("newsletter_issues")
        .select("sent_at")
        .gte("sent_at", twoWeeks)
        .not("sent_at", "is", null)
        .limit(500);
      if (e3) throw new Error(`fetchMarketingPortfolio failed: ${e3.message}`);
      let nThis = 0, nPrior = 0;
      for (const r of (issues ?? []) as Array<{ sent_at: string }>) {
        if (Date.parse(r.sent_at) >= Date.parse(weekAgo)) nThis++; else nPrior++;
      }

      // ── Content channel week (topics consumed this vs prior week) ──
      const { data: posts, error: e2 } = await supabaseAdmin
        .from("content_topics")
        .select("used_at")
        .eq("status", "used")
        .gte("used_at", twoWeeks)
        .limit(1000);
      if (e2) throw new Error(`fetchMarketingPortfolio failed: ${e2.message}`);
      let cThis = 0, cPrior = 0;
      for (const r of (posts ?? []) as Array<{ used_at: string | null }>) {
        if (r.used_at && Date.parse(r.used_at) >= Date.parse(weekAgo)) cThis++; else if (r.used_at) cPrior++;
      }

      const weeks: ChannelWeek[] = [
        { channel: "content", volume: cThis, prior_volume: cPrior, engagement_rate: null, prior_engagement_rate: null, conversions: null },
        { channel: "newsletter", volume: nThis, prior_volume: nPrior, engagement_rate: null, prior_engagement_rate: null, conversions: null },
        { channel: "drip", volume: dThis, prior_volume: dPrior, engagement_rate: dThis > 0 ? Number((dConv / dThis).toFixed(4)) : null, prior_engagement_rate: null, conversions: dConv },
      ];

      // ── Cannibalization inputs: recent blog topics vs recent email angles ──
      const { data: cTopics, error: e1 } = await supabaseAdmin
        .from("content_topics")
        .select("title, primary_keyword, secondary_keywords")
        .gte("created_at", twoWeeks)
        .limit(50);
      if (e1) throw new Error(`fetchMarketingPortfolio failed: ${e1.message}`);
      const { data: eTopics, error: e0 } = await supabaseAdmin
        .from("email_topic_bank")
        .select("label, pillar, angle")
        .eq("status", "active")
        .order("last_used_at", { ascending: false, nullsFirst: false })
        .limit(50);
      if (e0) throw new Error(`fetchMarketingPortfolio failed: ${e0.message}`);
      const topics: TopicItem[] = [
        ...((cTopics ?? []) as Array<{ title: string; primary_keyword: string; secondary_keywords: string[] }>).map((t) => ({
          channel: "content" as const,
          label: t.title,
          keywords: [t.primary_keyword, ...(t.secondary_keywords ?? [])].filter(Boolean),
        })),
        ...((eTopics ?? []) as Array<{ label: string; pillar: string; angle: string }>).map((t) => ({
          channel: "newsletter" as const,
          label: t.label,
          keywords: [t.pillar, ...String(t.angle ?? "").split(/[\s_-]+/)].filter(Boolean),
        })),
      ];

      return { weeks, topics, sendDays, coordination };
    },
    addMarketingTopic: async (input) => {
      if (input.bank === "email") {
        // Evergreen newsletter bank; unique (pillar, angle) makes this idempotent.
        //
        // US-2664 AC1/AC4: `inserted: false` is a LEGITIMATE answer here —
        // ignoreDuplicates means an existing (pillar, angle) returns no row —
        // which is exactly why it must not double as the failure signal. Same
        // value, two meanings, and the agent reports "already in the bank"
        // either way.
        const { data, error } = await supabaseAdmin
          .from("email_topic_bank")
          .upsert(
            { pillar: input.pillar, angle: input.angle, label: input.label, summary: input.summary, source: "manual", status: "active" } as never,
            { onConflict: "pillar,angle", ignoreDuplicates: true },
          )
          .select("id")
          .maybeSingle();
        if (error) throw new Error(`addMarketingTopic failed: ${error.message}`);
        return { inserted: !!data, id: (data as { id: string } | null)?.id ?? null };
      }
      // Blog topic queue (content_topics). generated_by=human, source=research.
      const { data, error } = await supabaseAdmin
        .from("content_topics")
        .insert({
          surface: input.surface,
          product_focus: input.product,
          title: input.title,
          primary_keyword: input.primary_keyword,
          angle: input.angle,
          status: "queued",
          generated_by: "human",
        } as never)
        .select("id")
        .single();
      // Unlike the upsert above, a plain insert with .single() has no
      // legitimate empty result, so inserted:false here was ALWAYS a failure
      // being reported as a no-op.
      if (error) throw new Error(`addMarketingTopic failed: ${error.message}`);
      return { inserted: !!data, id: (data as { id: string } | null)?.id ?? null };
    },
    setMarketingFrequencyCap: async (capPerDay) => {
      // US-2664 AC4: this returns { cap_per_day } unconditionally, so on a
      // failed write the agent reports the NEW cap as if it had been applied
      // while every send still runs under the old one. Worse than a missing
      // answer: a confident wrong one about how often people are emailed.
      const { error } = await supabaseAdmin.from("system_settings").upsert(
        {
          key: MARKETING_FREQ_CAP_SETTING,
          value: capPerDay,
          value_type: "number",
          default_value: 1,
          description: "US-884/1599 shared marketing send cap per recipient per day",
          category: "marketing",
        } as never,
        { onConflict: "key" },
      );
      if (error) throw new Error(`setMarketingFrequencyCap failed: ${error.message}`);
      bustSettingCache(MARKETING_FREQ_CAP_SETTING);
      return { cap_per_day: capPerDay };
    },
    fetchUserLifecycle: async (nowMs) => {
      const WEEK = 7 * 86400_000;
      const weekAgoIso = new Date(nowMs - WEEK).toISOString();
      const twoWeeksIso = new Date(nowMs - 2 * WEEK).toISOString();
      const nowIso = new Date(nowMs).toISOString();
      const in3dIso = new Date(nowMs + 3 * 86400_000).toISOString();
      const in7dIso = new Date(nowMs + WEEK).toISOString();
      const back30dIso = new Date(nowMs - 30 * 86400_000).toISOString();

      // Activation funnel from the funnel_metrics RPC over a 30-day window
      // (cohort counts only — the RPC returns aggregate step counts).
      let funnel: FunnelStep[] = [];
      try {
        const { data, error: e1 } = await supabaseAdmin.rpc("funnel_metrics", { p_start: back30dIso, p_end: nowIso });
        if (e1) throw new Error(`fetchUserLifecycle failed: ${e1.message}`);
        const steps = (data as { steps?: unknown } | null)?.steps;
        if (Array.isArray(steps)) {
          funnel = steps
            .filter((s): s is Record<string, unknown> => !!s && typeof s === "object")
            .map((s) => ({
              key: typeof s.key === "string" ? s.key : String(s.label ?? ""),
              label: typeof s.label === "string" ? s.label : String(s.key ?? ""),
              count: typeof s.count === "number" && Number.isFinite(s.count) ? s.count : 0,
            }));
        }
      } catch { /* no funnel data → empty */ }

      // Drip cohort weeks (this vs prior) — aggregate counts, no user rows leave.
      const { data: enr, error: e0 } = await supabaseAdmin
        .from("drip_enrollments")
        .select("enrolled_at, converted_at, exited_at, exit_reason")
        .gte("enrolled_at", twoWeeksIso)
        .limit(50000);
      if (e0) throw new Error(`fetchUserLifecycle failed: ${e0.message}`);
      const mk = (): CohortWeek => ({ week: "", enrolled: 0, converted: 0, churned: 0 });
      const current = mk(), prior = mk();
      current.week = weekAgoIso.slice(0, 10);
      prior.week = twoWeeksIso.slice(0, 10);
      for (const r of (enr ?? []) as Array<{ enrolled_at: string; converted_at: string | null; exited_at: string | null; exit_reason: string | null }>) {
        const bucket = Date.parse(r.enrolled_at) >= Date.parse(weekAgoIso) ? current : prior;
        bucket.enrolled += 1;
        if (r.converted_at) bucket.converted += 1;
        else if (r.exited_at && r.exit_reason && r.exit_reason !== "converted") bucket.churned += 1;
      }

      // Trial-expiry cohorts — HEAD count queries (no rows returned = no PII).
      const trialCohorts: TrialCohort[] = [];
      try {
        const [c3, c7, cExp] = await Promise.all([
          supabaseAdmin.from("users").select("id", { count: "exact", head: true })
            .eq("subscription_status", "trialing").gte("trial_ends_at", nowIso).lt("trial_ends_at", in3dIso),
          supabaseAdmin.from("users").select("id", { count: "exact", head: true })
            .eq("subscription_status", "trialing").gte("trial_ends_at", in3dIso).lt("trial_ends_at", in7dIso),
          supabaseAdmin.from("users").select("id", { count: "exact", head: true })
            .neq("subscription_status", "active").gte("trial_ends_at", back30dIso).lt("trial_ends_at", nowIso),
        ]);
        trialCohorts.push(
          { bucket: "expiring_3d", count: c3.count ?? 0 },
          { bucket: "expiring_7d", count: c7.count ?? 0 },
          { bucket: "expired_unconverted", count: cExp.count ?? 0 },
        );
      } catch { /* count unavailable → cohorts stay empty */ }

      return { funnel, current, prior, trialCohorts };
    },
    enrollCohort: async ({ cohort, campaign, nowIso }) => {
      // Whitelisted campaign + cohort ONLY — never a model-supplied id list. The
      // cohort is resolved server-side, marketing opt-outs excluded, already-
      // enrolled deduped, and the batch is hard-capped.
      const ENROLL_CAP = 500;
      if (campaign !== "trial_conversion") return { enrolled: 0, cohort, campaign, error: "unknown_campaign" };
      if (cohort !== "trial_expiring_7d") return { enrolled: 0, cohort, campaign, error: "unknown_cohort" };
      const in7dIso = new Date(Date.parse(nowIso) + 7 * 86400_000).toISOString();
      // US-2664: BOTH reads below throw, and this helper is the sharpest case
      // in the file because its two failure modes point in opposite directions.
      //
      // A failed COHORT read returned `{ enrolled: 0 }` with no error, which
      // the agent reports as "nobody's trial is expiring this week" — a
      // confident wrong answer about people we were about to email.
      //
      // A failed DEDUPE read is worse than a wrong number: `already` would come
      // back empty, so everyone already enrolled would be enrolled AGAIN. That
      // is not a missing action, it is a duplicate marketing send to real
      // customers, caused by a query nobody checked.
      const { data: trialists, error: cohortErr } = await supabaseAdmin
        .from("users")
        .select("id, created_at, trial_ends_at, notification_preferences")
        .eq("subscription_status", "trialing")
        .gte("trial_ends_at", nowIso)
        .lt("trial_ends_at", in7dIso)
        .order("trial_ends_at", { ascending: true })
        .limit(ENROLL_CAP);
      if (cohortErr) throw new Error(`enrollCohort failed: ${cohortErr.message}`);
      const candidates = ((trialists ?? []) as Array<{ id: string; created_at: string | null; trial_ends_at: string | null; notification_preferences: Record<string, unknown> | null }>)
        .filter((t) => !marketingOptedOutEmail(t.notification_preferences));
      if (candidates.length === 0) return { enrolled: 0, cohort, campaign };
      const ids = candidates.map((t) => t.id);
      const { data: existing, error: dedupeErr } = await supabaseAdmin
        .from("drip_enrollments").select("user_id").eq("campaign", campaign).in("user_id", ids);
      if (dedupeErr) throw new Error(`enrollCohort failed: ${dedupeErr.message}`);
      const already = new Set((existing ?? []).map((r) => (r as { user_id: string }).user_id));
      const rows = candidates.filter((t) => !already.has(t.id)).map((t) => ({
        user_id: t.id,
        campaign,
        enrolled_at: nowIso,
        trial_started_at: t.created_at,
        signup_week: t.created_at ? t.created_at.slice(0, 10) : null,
        incentive_enabled: false,
        next_evaluation_at: nowIso,
      }));
      if (rows.length === 0) return { enrolled: 0, cohort, campaign };
      const { data: inserted, error: enrollErr } = await supabaseAdmin
        .from("drip_enrollments")
        .upsert(rows as never, { onConflict: "user_id,campaign", ignoreDuplicates: true })
        .select("id");
      // The write itself: `enrolled: 0` on a failed upsert reads as "everyone
      // was already enrolled", which is the one answer that stops anyone
      // looking into it.
      if (enrollErr) throw new Error(`enrollCohort failed: ${enrollErr.message}`);
      return { enrolled: (inserted ?? []).length, cohort, campaign };
    },
    fetchMaintenanceIntervals: async (sinceIso) => {
      // Windows active now OR that ended within the lookback still suppress ticks
      // that fell inside their past interval.
      const { data, error: e0 } = await supabaseAdmin
        .from("maintenance_windows")
        .select("starts_at, ends_at, is_active")
        .or(`ends_at.is.null,ends_at.gte.${sinceIso}`)
        .limit(200);
      if (e0) throw new Error(`fetchMaintenanceIntervals failed: ${e0.message}`);
      return ((data ?? []) as Array<{ starts_at: string | null; ends_at: string | null; is_active: boolean }>)
        .filter((w) => w.is_active || w.ends_at !== null)
        .map((w) => ({
          startMs: w.starts_at ? Date.parse(w.starts_at) : -Infinity,
          endMs: w.ends_at ? Date.parse(w.ends_at) : Infinity,
        }));
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
      // US-2664 AC1/AC4: `false` legitimately means "that id is not sitting in
      // dead_letter" — a real and common answer. It ALSO meant "the query
      // failed", and the caller could not tell which. Throwing separates them,
      // so a false from here now means exactly one thing.
      const { data: row, error: readErr } = await supabaseAdmin
        .from("email_deliveries")
        .select("attempts")
        .eq("id", id)
        .eq("status", "dead_letter")
        .maybeSingle();
      if (readErr) throw new Error(`requeueEmailDeadLetter failed: ${readErr.message}`);
      if (!row) return false;
      const attempts = (row as { attempts?: number }).attempts ?? 0;
      const { data, error } = await supabaseAdmin
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
      if (error) throw new Error(`requeueEmailDeadLetter failed: ${error.message}`);
      return !!data;
    },
    resolveAgentTaskProject: async () => {
      const TITLE = "Agent Proposals";
      const { data: found, error: e1 } = await supabaseAdmin
        .from("admin_task_projects")
        .select("id")
        .eq("title", TITLE)
        .maybeSingle();
      if (e1) throw new Error(`resolveAgentTaskProject failed: ${e1.message}`);
      if (found) return (found as { id: string }).id;
      const { data: created, error: e0 } = await supabaseAdmin
        .from("admin_task_projects")
        .insert({ title: TITLE } as never)
        .select("id")
        .single();
      if (e0) throw new Error(`resolveAgentTaskProject failed: ${e0.message}`);
      return (created as { id: string } | null)?.id ?? null;
    },
    insertAdminTask: async (row) => {
      // US-2664 AC4: a successful insert with .single() ALWAYS returns a row,
      // so null could only ever mean failure — and the caller had to infer
      // that from an absence. Throwing makes null unreachable and names the
      // reason instead. The agent files these as follow-up work; a swallowed
      // failure means it reports a task it did not create.
      const { data, error } = await supabaseAdmin
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
      if (error) throw new Error(`insertAdminTask failed: ${error.message}`);
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
    description: "Integrations Watchdog memo (US-1604): pre-assembled vendor health verdicts (from ops events), the OAuth token-fleet expiry forecast (expired / 7d / 30d by marketplace), the key-rotation calendar (overdue / due-soon / baseline-needed, from vault/10-ops/key-rotation.md encoded as data), and an email deliverability watch. Read-about-credentials only — expiry metadata + cadences, never secret material.",
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
  {
    name: "get_ceo_brief",
    description: "CEO Brief context (US-1603): headline north-star metrics this week vs last, each seeded agent's LATEST succeeded-run summary (for attribution), pending fleet proposals, and coverage / degraded flags. Attribution is only permitted for agents that actually ran — assembled honestly so the narrator never fabricates a cause.",
    class: "read",
    inputSchema: { type: "object", properties: {} },
    handler: async (_input, ctx) => {
      const data = await ctx.io.fetchCeoBriefData(ctx.now);
      const context = assembleCeoBriefContext({
        nowMs: ctx.now,
        agents: data.agents,
        metrics: data.metrics,
        latestRuns: data.latestRuns,
        pendingProposals: data.pendingProposals,
      });
      return { context };
    },
  },
  {
    name: "get_growth_health",
    description: "Growth agent memo (US-1602): the acquisition funnel (funnel_metrics) with step-to-step conversions, the worst drop-off ('cliff'), week-over-week conversion regressions, referral-program health, and the PRIOR run's experiment slate for continuity. Aggregates only. The agent narrates + ranks experiment ideas; it does not start experiments.",
    class: "read",
    inputSchema: { type: "object", properties: {} },
    handler: async (_input, ctx) => {
      const WEEK = 7 * 24 * 3600_000;
      const curEnd = new Date(ctx.now).toISOString();
      const curStart = new Date(ctx.now - WEEK).toISOString();
      const priorStart = new Date(ctx.now - 2 * WEEK).toISOString();
      const [currentFunnel, priorFunnel, referrals, priorSlate] = await Promise.all([
        ctx.io.rpc("funnel_metrics", { p_start: curStart, p_end: curEnd }),
        ctx.io.rpc("funnel_metrics", { p_start: priorStart, p_end: curStart }),
        ctx.io.fetchReferralCounts(curStart, curEnd, priorStart),
        ctx.io.fetchAgentPriorOutcome(ctx.agentId),
      ]);
      const memo = assembleGrowthMemo({
        currentFunnel,
        priorFunnel,
        referralsCurrent: referrals.current,
        referralsPrior: referrals.prior,
        priorSlate,
      });
      return { memo };
    },
  },
  {
    name: "get_cron_fleet_health",
    description: "Cron-fleet governance report (US-1611): the diff between the CRON_REGISTRY schedule and cron_runs reality — per-job missed-tick detection (a scheduled slot with no run), duration creep, and a fleet scorecard of stalled/slow jobs. Missed ticks inside a maintenance window are suppressed (no false alarms). Read-only.",
    class: "read",
    inputSchema: {
      type: "object",
      properties: { lookback_hours: { type: "integer", minimum: 1, maximum: 168, description: "window for missed-tick + creep analysis" } },
    },
    handler: async (input, ctx) => {
      const lookbackHours = clampInt(input.lookback_hours, 24, 1, 168);
      const lookbackMs = lookbackHours * 3600_000;
      const sinceIso = new Date(ctx.now - lookbackMs).toISOString();
      const [runs, maintenance] = await Promise.all([
        ctx.io.fetchCronRuns(20000),
        ctx.io.fetchMaintenanceIntervals(sinceIso),
      ]);
      const runsByJob: Record<string, JobRun[]> = {};
      for (const r of runs) {
        // US-2312: carry the outcome through, so the agent's read-tool and the
        // cron-fleet alert keep sharing ONE data path and cannot disagree about
        // whether a ticking-but-failing job is healthy.
        (runsByJob[r.job_name] ??= []).push({
          created_at: r.created_at,
          duration_ms: r.duration_ms,
          status: r.status,
          rows_processed: r.rows_processed,
          // US-2668: the same reason — without http_status the read-tool's
          // report would compute always_failing:false for every job while the
          // alert computed it correctly.
          http_status: r.http_status,
        });
      }
      const report = assembleCronFleetReport({
        registry: CRON_REGISTRY,
        runsByJob,
        maintenance,
        nowMs: ctx.now,
        lookbackMs,
      });
      return { report };
    },
  },
  {
    name: "get_release_health",
    description: "Release verification memo (US-1610): detects a deploy (RELEASE_SHA change) and, when one is found, compares post-deploy health metrics (24h cron failures, webhook + email dead-letter depths) to the pre-deploy baseline against config thresholds — a regression, a clean verdict, or no-deploy. Read-only; the agent never rolls back.",
    class: "read",
    inputSchema: { type: "object", properties: {} },
    handler: async (_input, ctx) => {
      const currentSha = ctx.io.releaseSha();
      const [state, runs, webhooks, emails] = await Promise.all([
        ctx.io.fetchReleaseState(),
        ctx.io.fetchCronRuns(4000),
        ctx.io.fetchWebhookDeadLetters(500),
        ctx.io.fetchEmailDeadLetters(500),
      ]);
      const since = ctx.now - 24 * 3600_000;
      const jobFailures = runs.filter((r) =>
        (r.status === "failed" || r.status === "error") && Date.parse(r.created_at) >= since
      ).length;
      const metrics: ReleaseMetrics = { job_failures_24h: jobFailures, webhook_dlq: webhooks.length, email_dlq: emails.length };
      const deploy = detectDeploy(currentSha, state?.last_sha ?? null);
      const comparison = deploy.deployed
        ? compareRelease(state?.baseline ?? null, metrics)
        : { regressions: [], regressed: false, comparable: false };
      const memo = assembleReleaseMemo(deploy, metrics, comparison);
      // Roll the baseline forward (operator bookkeeping — no tenant data).
      await ctx.io.persistReleaseState(nextReleaseState(deploy, metrics, new Date(ctx.now).toISOString())).catch(() => {});
      return { memo };
    },
  },
  {
    name: "get_experiments_registry",
    description: "Experiments Governor memo (US-1609): a unified registry of every LIVE A/B across three engines (newsletter subject tests, grading-prompt canaries, drip variants) plus three portfolio checks — interference (same audience + metric, overlapping windows), underpowered reads presented as wins, and experiments past their decision date. Read-only; the agent never stops/promotes an experiment.",
    class: "read",
    inputSchema: { type: "object", properties: {} },
    handler: async (_input, ctx) => {
      const sinceIso = new Date(ctx.now - 30 * 86400_000).toISOString(); // drip cohort window
      const [newsletter, prompts, drip] = await Promise.all([
        ctx.io.fetchNewsletterAbTests().catch(() => [] as NewsletterAbRow[]),
        ctx.io.fetchPromptRollouts().catch(() => [] as PromptRolloutRow[]),
        ctx.io.fetchDripVariants(sinceIso).catch(() => [] as DripVariantRow[]),
      ]);
      const registry = [
        ...normalizeNewsletterAb(newsletter),
        ...normalizePromptRollout(prompts),
        ...normalizeDripVariants(drip),
      ];
      const memo = assembleExperimentsMemo(registry, ctx.now);
      return { memo };
    },
  },
  {
    name: "get_support_triage",
    description: "Support Triage memo (US-1595): new/unassigned open tickets awaiting triage (id, subject, a PII-REDACTED excerpt, current priority, age), any detected issue clusters (N similar tickets in a window → one Sentinel-correlation candidate), and the KB article catalog (slug + title) to suggest from. Read-only; classification + replies are approval-gated proposals the agent emits.",
    class: "read",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "integer", minimum: 1, maximum: 100, description: "max untriaged tickets to pull" },
      },
    },
    handler: async (input, ctx) => {
      const limit = clampInt(input.limit, 40, 1, 100);
      const [rawTickets, kb] = await Promise.all([
        ctx.io.fetchUntriagedTickets(limit),
        ctx.io.fetchKbCatalog(60),
      ]);
      const tickets: TriageTicket[] = rawTickets.map((t) => ({
        id: t.id,
        subject: prepareExcerpt(t.subject), // subjects can carry PII too
        excerpt: prepareExcerpt(t.excerpt),
        created_ms: Date.parse(t.created_at) || ctx.now,
        priority: t.priority,
        status: t.status,
      }));
      const memo = assembleTriageMemo(tickets, kb, ctx.now);
      return { memo };
    },
  },
  {
    name: "get_marketing_portfolio",
    description: "Marketing Portfolio memo (US-1599): a per-channel scorecard (content, newsletter, drip — weekly volume + engagement trend + conversions) plus the CROSS-CHANNEL signals the per-engine tuners can't see — audience fatigue (combined send pressure vs the cap), topic cannibalization (blog vs newsletter keyword overlap), and same-day channel collisions — and a ranked next-week focus list. Engine-level aggregates only; no per-subscriber data. Read-only.",
    class: "read",
    inputSchema: { type: "object", properties: {} },
    handler: async (_input, ctx) => {
      const { weeks, topics, sendDays, coordination } = await ctx.io.fetchMarketingPortfolio(ctx.now);
      const memo = assembleMarketingPortfolioMemo(weeks, topics, sendDays, coordination);
      return { memo };
    },
  },
  {
    name: "get_user_lifecycle",
    description: "User Lifecycle memo (US-1600): COHORT-LEVEL only — an activation-stall diagnosis (which funnel step + hypothesis), a churn-risk narrative vs the prior week (conversion/churn deltas), and winback sizing (expired-unconverted reachable + trials expiring soon). The tool aggregates before returning; NO per-user row, id, or PII is ever included. Read-only.",
    class: "read",
    inputSchema: { type: "object", properties: {} },
    handler: async (_input, ctx) => {
      const { funnel, current, prior, trialCohorts } = await ctx.io.fetchUserLifecycle(ctx.now);
      const memo = assembleLifecycleMemo(funnel, current, prior, trialCohorts);
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
    name: "run_smoke",
    description: "Run a lightweight in-process smoke check (the internal /health endpoint) to actively verify a release. Reversible/read-only in effect; returns ok + HTTP status.",
    class: "write",
    inputSchema: { type: "object", properties: {} },
    handler: async (_input, ctx) => {
      if (!ctx.authorizedBy) return { error: { code: "unauthorized", message: "write requires an approved proposal" } };
      return await ctx.io.runSmoke();
    },
  },
  {
    name: "persist_ticket_triage",
    description:
      "Persist a batch of Support Triage classifications (US-1595) onto the support_tickets rows the admin support UI renders — category, severity, suggested KB slug + a triaged_at stamp. Advisory metadata only: it NEVER changes a ticket's status, assignee, or priority, and never sends a message. Each item is validated (known category/severity, KB slug must exist) and invalid items are skipped.",
    class: "write",
    inputSchema: {
      type: "object",
      properties: {
        items: {
          type: "array",
          items: {
            type: "object",
            properties: {
              ticket_id: { type: "string" },
              category: { type: "string" },
              severity: { type: "string" },
              kb_slug: { type: ["string", "null"] },
            },
            required: ["ticket_id", "category", "severity"],
          },
        },
      },
      required: ["items"],
    },
    handler: async (input, ctx) => {
      if (!ctx.authorizedBy) return { error: { code: "unauthorized", message: "write requires an approved proposal" } };
      const rawItems = Array.isArray(input.items) ? input.items : [];
      // Validate against the live KB catalog so a hallucinated slug never persists.
      const kb = await ctx.io.fetchKbCatalog(200);
      const knownSlugs = new Set(kb.map((k) => k.slug));
      const items = rawItems
        .map((it) => normalizeClassification(it, knownSlugs))
        .filter((x): x is NonNullable<typeof x> => x !== null)
        .map((x) => ({ ticket_id: x.ticket_id, category: x.category, severity: x.severity, kb_slug: x.kb_slug }));
      if (items.length === 0) return { updated: 0, skipped: rawItems.length };
      const { updated } = await ctx.io.persistTicketTriage(items, new Date(ctx.now).toISOString());
      return { updated, skipped: rawItems.length - items.length };
    },
  },
  {
    name: "send_support_reply",
    description:
      "Send an operator-APPROVED support reply (US-1595). Inserts the drafted reply as a public ticket message through the normal support path (bumps the ticket to 'pending', assigns the approving operator, notifies the customer). Only ever runs on an approved draft_reply proposal — the agent never sends unsupervised. Sends the body verbatim; no editing here.",
    class: "write",
    inputSchema: {
      type: "object",
      properties: {
        ticket_id: { type: "string" },
        body: { type: "string" },
      },
      required: ["ticket_id", "body"],
    },
    handler: async (input, ctx) => {
      if (!ctx.authorizedBy) return { error: { code: "unauthorized", message: "write requires an approved proposal" } };
      const ticketId = typeof input.ticket_id === "string" ? input.ticket_id : "";
      const body = typeof input.body === "string" ? input.body.trim() : "";
      if (!ticketId || !body) return { error: { code: "invalid", message: "ticket_id and body are required" } };
      return await ctx.io.sendSupportReply({ ticketId, body, adminId: ctx.authorizedBy });
    },
  },
  {
    name: "add_marketing_topic",
    description:
      "Add ONE topic to a marketing topic bank (US-1599) — the newsletter evergreen bank (bank:'email') or the blog topic queue (bank:'content'). Engine-level lever: it queues an angle the per-engine assembler will draw from; it does NOT write or send anything to a subscriber. Email bank is idempotent on (pillar, angle).",
    class: "write",
    inputSchema: {
      type: "object",
      properties: {
        bank: { type: "string", enum: ["email", "content"] },
        // email bank
        pillar: { type: "string" },
        angle: { type: "string" },
        label: { type: "string" },
        summary: { type: "string" },
        // content bank
        surface: { type: "string", enum: ["blog", "social"] },
        product: { type: "string", enum: ["gradethread", "flipdesk", "both"] },
        title: { type: "string" },
        primary_keyword: { type: "string" },
      },
      required: ["bank"],
    },
    handler: async (input, ctx) => {
      if (!ctx.authorizedBy) return { error: { code: "unauthorized", message: "write requires an approved proposal" } };
      if (input.bank === "email") {
        const pillar = typeof input.pillar === "string" ? input.pillar.trim() : "";
        const angle = typeof input.angle === "string" ? input.angle.trim() : "";
        const label = typeof input.label === "string" ? input.label.trim() : "";
        if (!pillar || !angle || !label) return { error: { code: "invalid", message: "email topic needs pillar, angle, label" } };
        return await ctx.io.addMarketingTopic({ bank: "email", pillar, angle, label, summary: typeof input.summary === "string" ? input.summary : "" });
      }
      if (input.bank === "content") {
        const surface = input.surface === "blog" || input.surface === "social" ? input.surface : "";
        const product = ["gradethread", "flipdesk", "both"].includes(String(input.product)) ? String(input.product) : "";
        const title = typeof input.title === "string" ? input.title.trim() : "";
        const primaryKeyword = typeof input.primary_keyword === "string" ? input.primary_keyword.trim() : "";
        if (!surface || !product || !title || !primaryKeyword) {
          return { error: { code: "invalid", message: "content topic needs surface, product, title, primary_keyword" } };
        }
        return await ctx.io.addMarketingTopic({
          bank: "content",
          surface,
          product,
          title,
          primary_keyword: primaryKeyword,
          angle: typeof input.angle === "string" ? input.angle : null,
        });
      }
      return { error: { code: "invalid", message: "bank must be 'email' or 'content'" } };
    },
  },
  {
    name: "set_marketing_frequency_cap",
    description:
      "Set the shared marketing send cap per recipient per day (US-1599 / US-884). Engine-level lever: it changes the coordination cap every marketing engine already honors; it touches no send or subscriber. Clamped to 1..10. Use to relieve audience fatigue.",
    class: "write",
    inputSchema: {
      // No minimum/maximum here on purpose (US-1599 clamp contract): the handler
      // CLAMPS out-of-range values into 1..10 via clampInt rather than rejecting
      // them, so a proposal of e.g. 99 is coerced to 10 instead of erroring. A
      // schema max would make the clamp unreachable (validateToolInput rejects
      // first) and turn "set it high" into an error the run loop can't self-heal.
      type: "object",
      properties: { cap_per_day: { type: "integer" } },
      required: ["cap_per_day"],
    },
    handler: async (input, ctx) => {
      if (!ctx.authorizedBy) return { error: { code: "unauthorized", message: "write requires an approved proposal" } };
      const cap = clampInt(input.cap_per_day, 1, 1, 10);
      return await ctx.io.setMarketingFrequencyCap(cap);
    },
  },
  {
    name: "enroll_cohort",
    description:
      "Enrol a DEFINED cohort in an EXISTING drip campaign (US-1600). The cohort is resolved server-side from a whitelist (never a model-supplied user list) — marketing opt-outs are excluded, already-enrolled users are deduped, and the batch is hard-capped. All delivery still flows through the drip engine + the marketing-frequency caps; this sends nothing itself. v1 supports cohort 'trial_expiring_7d' into campaign 'trial_conversion'.",
    class: "write",
    inputSchema: {
      // No schema-level `required` on purpose: the handler is the single
      // validation authority and rejects BOTH missing AND empty-string fields
      // with code "invalid" (schema `required` misses empty strings and would
      // return a different code "invalid_input"). Mirrors add_marketing_topic.
      type: "object",
      properties: {
        cohort: { type: "string", description: "a supported cohort key (e.g. trial_expiring_7d)" },
        campaign: { type: "string", description: "an existing drip campaign (e.g. trial_conversion)" },
      },
    },
    handler: async (input, ctx) => {
      if (!ctx.authorizedBy) return { error: { code: "unauthorized", message: "write requires an approved proposal" } };
      const cohort = typeof input.cohort === "string" ? input.cohort.trim() : "";
      const campaign = typeof input.campaign === "string" ? input.campaign.trim() : "";
      if (!cohort || !campaign) return { error: { code: "invalid", message: "cohort and campaign are required" } };
      return await ctx.io.enrollCohort({ cohort, campaign, nowIso: new Date(ctx.now).toISOString() });
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
  // US-1610: the Release agent's active smoke check.
  run_smoke: "run_smoke",
  // US-1595: Support Triage — persist a classification batch; a drafted reply
  // sends through the support path on approval.
  triage_tickets: "persist_ticket_triage",
  draft_reply: "send_support_reply",
  // US-1599: Marketing Portfolio engine-level levers.
  add_marketing_topic: "add_marketing_topic",
  adjust_frequency: "set_marketing_frequency_cap",
  // US-1600: User Lifecycle cohort enrollment (delivery stays in the drip engine).
  enroll_cohort: "enroll_cohort",
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
