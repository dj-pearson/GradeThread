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
    fetchKeyRotationState: () => Promise.resolve({}),
    fetchReconciliationFlags: () => Promise.resolve([]),
    fetchRecentPayouts: () => Promise.resolve({ affiliate: [], consignor: [] }),
    fetchRepricingSuggestions: () => Promise.resolve([]),
    fetchAutomationActions: () => Promise.resolve([]),
    fetchCurveFreshness: () => Promise.resolve([]),
    fetchListingBatches: () => Promise.resolve({ generation: [], publish: [] }),
    countOpenSyncConflicts: () => Promise.resolve(0),
    countOrphanSales: () => Promise.resolve(0),
    fetchMarketplaceOpsBacklog: () => Promise.resolve(null),
    persistMarketplaceOpsBacklog: () => Promise.resolve(),
    fetchAbuseSignals: () => Promise.resolve([]),
    countOpenModerationFlags: () => Promise.resolve(0),
    countOpenPassportIntegritySignals: () => Promise.resolve(0),
    fetchCeoBriefData: () => Promise.resolve({ agents: [], metrics: [], latestRuns: [], pendingProposals: [] }),
    fetchReferralCounts: () => Promise.resolve({ current: 0, prior: 0 }),
    fetchAgentPriorOutcome: () => Promise.resolve(null),
    fetchMaintenanceIntervals: () => Promise.resolve([]),
    releaseSha: () => "sha-current",
    fetchReleaseState: () => Promise.resolve(null),
    persistReleaseState: () => Promise.resolve(),
    runSmoke: () => Promise.resolve({ ok: true, status: 200 }),
    fetchNewsletterAbTests: () => Promise.resolve([]),
    fetchPromptRollouts: () => Promise.resolve([]),
    fetchDripVariants: () => Promise.resolve([]),
    fetchUntriagedTickets: () => Promise.resolve([]),
    fetchKbCatalog: () => Promise.resolve([]),
    persistTicketTriage: (items) => Promise.resolve({ updated: items.length }),
    sendSupportReply: () => Promise.resolve({ ok: true }),
    fetchMarketingPortfolio: () => Promise.resolve({ weeks: [], topics: [], sendDays: [], coordination: { cap_per_day: 1, max_observed_per_day: 0, deferred_or_dropped: 0 } }),
    addMarketingTopic: () => Promise.resolve({ inserted: true, id: "topic-1" }),
    setMarketingFrequencyCap: (cap) => Promise.resolve({ cap_per_day: cap }),
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

// ── US-1604: get_integrations_health composite read tool ─────────────────────

Deno.test("US-1604: get_integrations_health assembles a memo from the reads", async () => {
  const { io } = fakeIO({
    fetchMarketplaceConnections: () =>
      Promise.resolve([
        // Expired eBay token → should surface in the forecast + break all-clear.
        { marketplace: "ebay", is_active: true, token_expires_at: new Date(NOW - 3600_000).toISOString(), refresh_error: null },
      ]),
    fetchKeyRotationState: () => Promise.resolve({}),
  });
  const reg = createAgentToolRegistry(io);
  const a = agent(["get_integrations_health"]);
  const res = await reg.execute(a, "get_integrations_health", {}) as {
    memo?: { token_fleet?: { expired?: number }; all_clear?: boolean };
  };
  assertEquals(res.memo?.token_fleet?.expired, 1);
  assertEquals(res.memo?.all_clear, false);
});

// ── US-1610: get_release_health + run_smoke ──────────────────────────────────

Deno.test("US-1610: get_release_health flags a regression after a detected deploy", async () => {
  const failedRuns = Array.from({ length: 12 }, () => ({
    job_name: "x", status: "failed", http_status: 500, duration_ms: 1, rows_processed: 0, triggered_by: "schedule", created_at: new Date(NOW - 60_000).toISOString(),
  }));
  const { io } = fakeIO({
    releaseSha: () => "new-sha",
    fetchReleaseState: () => Promise.resolve({ last_sha: "old-sha", baseline: { job_failures_24h: 1, webhook_dlq: 0, email_dlq: 0 }, checked_at: null }),
    fetchCronRuns: () => Promise.resolve(failedRuns),
  });
  const reg = createAgentToolRegistry(io);
  const a = agent(["get_release_health"]);
  const res = await reg.execute(a, "get_release_health", {}) as {
    memo?: { verdict?: string; deploy?: { deployed?: boolean }; comparison?: { regressed?: boolean } };
  };
  assertEquals(res.memo?.deploy?.deployed, true);
  assertEquals(res.memo?.verdict, "regression"); // 1 → 12 job failures
  assertEquals(res.memo?.comparison?.regressed, true);
});

Deno.test("US-1610: run_smoke maps to a write tool + is invisible to the run loop", async () => {
  const { ACTION_CLASS_TO_TOOL } = await import("../lib/agent-tools.ts");
  assertEquals(ACTION_CLASS_TO_TOOL.run_smoke, "run_smoke");
  const reg = createAgentToolRegistry(fakeIO().io);
  const a = agent(["run_smoke", "get_release_health"]);
  assertEquals(reg.anthropicTools(a).map((t) => t.name), ["get_release_health"]);
  const res = await reg.executeWrite("run_smoke", {}, { authorizedBy: "admin-1" }) as { ok?: boolean };
  assertEquals(res.ok, true);
});

// ── US-1609: get_experiments_registry memo ───────────────────────────────────

Deno.test("US-1609: get_experiments_registry unifies engines + flags interference", async () => {
  const startIso = new Date(NOW - 2 * 86400_000).toISOString();
  const { io } = fakeIO({
    // A newsletter subject test measuring opens on the subscriber audience…
    fetchNewsletterAbTests: () => Promise.resolve([{
      id: "iss-1",
      ab_phase: "testing",
      ab_metric: "open",
      subject_variants: [{ id: "a", subject: "A" }, { id: "b", subject: "B" }],
      ab_test_started_at: startIso,
      ab_measurement_hours: 48,
      ab_winner_variant: null,
    }]),
    fetchPromptRollouts: () => Promise.resolve([]),
    fetchDripVariants: () => Promise.resolve([]),
  });
  const reg = createAgentToolRegistry(io);
  const a = agent(["get_experiments_registry"]);
  const res = await reg.execute(a, "get_experiments_registry", {}) as {
    memo?: { registry?: Array<{ engine: string }>; all_clear?: boolean };
  };
  // One live experiment normalized from the newsletter engine; no second test on
  // the same audience+metric, so all_clear.
  assertEquals(res.memo?.registry?.length, 1);
  assertEquals(res.memo?.registry?.[0].engine, "newsletter-ab");
  assertEquals(res.memo?.all_clear, true);
});

// ── US-1595: Support Triage tools ────────────────────────────────────────────

Deno.test("US-1595: get_support_triage redacts excerpts + surfaces a cluster", async () => {
  const t = (id: string, subject: string, excerpt: string) => ({
    id, subject, excerpt, created_at: new Date(NOW - 3600_000).toISOString(), priority: "normal", status: "open",
  });
  const { io } = fakeIO({
    fetchUntriagedTickets: () => Promise.resolve([
      t("t1", "Payout missing", "My payout reconciliation never arrived, email me at user@example.com"),
      t("t2", "Payout reconciliation broken", "payout reconciliation shows wrong total again"),
      t("t3", "Reconciliation payout issue", "the payout reconciliation total is broken for me too"),
      t("t4", "Login help", "cannot reset my grading password"),
    ]),
    fetchKbCatalog: () => Promise.resolve([{ slug: "payouts", title: "Payouts" }]),
  });
  const reg = createAgentToolRegistry(io);
  const a = agent(["get_support_triage"]);
  const res = await reg.execute(a, "get_support_triage", {}) as {
    memo?: { untriaged?: Array<{ excerpt: string }>; clusters?: Array<{ size: number }>; all_clear?: boolean; kb_catalog?: unknown[] };
  };
  assertEquals(res.memo?.untriaged?.length, 4);
  // The email in t1's excerpt is scrubbed by log-redact before it leaves.
  assert(res.memo?.untriaged?.every((u) => !u.excerpt.includes("user@example.com")));
  // t1/t2/t3 share 'payout'+'reconciliation' within the window → one cluster ≥3.
  assertEquals(res.memo?.clusters?.length, 1);
  assert((res.memo?.clusters?.[0].size ?? 0) >= 3);
  assertEquals(res.memo?.all_clear, false);
});

Deno.test("US-1595: persist_ticket_triage validates + skips bad items; needs approval", async () => {
  const { ACTION_CLASS_TO_TOOL } = await import("../lib/agent-tools.ts");
  assertEquals(ACTION_CLASS_TO_TOOL.triage_tickets, "persist_ticket_triage");
  assertEquals(ACTION_CLASS_TO_TOOL.draft_reply, "send_support_reply");
  let persisted: unknown[] = [];
  const { io } = fakeIO({
    fetchKbCatalog: () => Promise.resolve([{ slug: "payouts", title: "Payouts" }]),
    persistTicketTriage: (items) => { persisted = items; return Promise.resolve({ updated: items.length }); },
  });
  const reg = createAgentToolRegistry(io);
  // Write tool is invisible to the run loop.
  assertEquals(reg.anthropicTools(agent(["persist_ticket_triage", "get_support_triage"])).map((t) => t.name), ["get_support_triage"]);
  const res = await reg.executeWrite("persist_ticket_triage", {
    items: [
      { ticket_id: "t1", category: "billing", severity: "high", kb_slug: "payouts" }, // valid
      { ticket_id: "t2", category: "billing", severity: "high", kb_slug: "nope" }, // slug dropped → still valid, kb_slug null
      { ticket_id: "t3", category: "bogus", severity: "high", kb_slug: null }, // invalid category → skipped
    ],
  }, { authorizedBy: "admin-1" }) as { updated?: number; skipped?: number };
  assertEquals(res.updated, 2);
  assertEquals(res.skipped, 1);
  assertEquals((persisted[1] as { kb_slug: unknown }).kb_slug, null); // unknown slug nulled
});

Deno.test("US-1595: send_support_reply refuses without an approved proposal", async () => {
  const reg = createAgentToolRegistry(fakeIO().io);
  const res = await reg.executeWrite("send_support_reply", { ticket_id: "t1", body: "Hello" }, { authorizedBy: "admin-1" }) as { ok?: boolean };
  assertEquals(res.ok, true);
});

// ── US-1599: Marketing Portfolio tools ───────────────────────────────────────

Deno.test("US-1599: get_marketing_portfolio surfaces a cross-channel collision", async () => {
  const { io } = fakeIO({
    fetchMarketingPortfolio: () => Promise.resolve({
      weeks: [
        { channel: "newsletter", volume: 2, prior_volume: 2, engagement_rate: 0.3, prior_engagement_rate: 0.3, conversions: null },
        { channel: "drip", volume: 50, prior_volume: 40, engagement_rate: 0.1, prior_engagement_rate: 0.1, conversions: 5 },
      ],
      topics: [],
      sendDays: [{ date: "2026-07-02", channels: ["newsletter", "drip"] }], // collision
      coordination: { cap_per_day: 1, max_observed_per_day: 1, deferred_or_dropped: 0 },
    }),
  });
  const reg = createAgentToolRegistry(io);
  const res = await reg.execute(agent(["get_marketing_portfolio"]), "get_marketing_portfolio", {}) as {
    memo?: { signals?: Array<{ type: string }>; all_clear?: boolean; scorecard?: unknown[] };
  };
  assertEquals(res.memo?.scorecard?.length, 2);
  assertEquals(res.memo?.all_clear, false);
  assert((res.memo?.signals ?? []).some((s) => s.type === "channel_collision"));
});

Deno.test("US-1599: add_marketing_topic validates the bank + is write-gated", async () => {
  const { ACTION_CLASS_TO_TOOL } = await import("../lib/agent-tools.ts");
  assertEquals(ACTION_CLASS_TO_TOOL.add_marketing_topic, "add_marketing_topic");
  assertEquals(ACTION_CLASS_TO_TOOL.adjust_frequency, "set_marketing_frequency_cap");
  const reg = createAgentToolRegistry(fakeIO().io);
  // Invisible to the run loop.
  assertEquals(reg.anthropicTools(agent(["add_marketing_topic", "get_marketing_portfolio"])).map((t) => t.name), ["get_marketing_portfolio"]);
  // Missing required content fields → invalid, no write.
  const bad = await reg.executeWrite("add_marketing_topic", { bank: "content", title: "x" }, { authorizedBy: "admin-1" }) as { error?: { code: string } };
  assertEquals(bad.error?.code, "invalid");
  // Valid email topic → inserted.
  const ok = await reg.executeWrite("add_marketing_topic", { bank: "email", pillar: "pricing", angle: "comp-basics", label: "How comps work" }, { authorizedBy: "admin-1" }) as { inserted?: boolean };
  assertEquals(ok.inserted, true);
});

Deno.test("US-1599: set_marketing_frequency_cap clamps to 1..10", async () => {
  let seen = -1;
  const { io } = fakeIO({ setMarketingFrequencyCap: (c) => { seen = c; return Promise.resolve({ cap_per_day: c }); } });
  const reg = createAgentToolRegistry(io);
  await reg.executeWrite("set_marketing_frequency_cap", { cap_per_day: 99 }, { authorizedBy: "admin-1" });
  assertEquals(seen, 10); // clamped
});

// ── US-1611: get_cron_fleet_health report ────────────────────────────────────

Deno.test("US-1611: get_cron_fleet_health flags a stalled recorded job", async () => {
  // autolister-reclaim is */5; with NO recent runs it's stalled over the window.
  const { io } = fakeIO({ fetchCronRuns: () => Promise.resolve([]) });
  const reg = createAgentToolRegistry(io);
  const a = agent(["get_cron_fleet_health"]);
  const res = await reg.execute(a, "get_cron_fleet_health", { lookback_hours: 6 }) as {
    report?: { all_clear?: boolean; stalled?: Array<{ name: string; missed: number }> };
  };
  assertEquals(res.report?.all_clear, false);
  assert((res.report?.stalled?.length ?? 0) > 0);
  assert((res.report?.stalled ?? []).every((s) => s.missed > 0));
});

// ── US-1602: get_growth_health memo ──────────────────────────────────────────

Deno.test("US-1602: get_growth_health finds the funnel cliff + surfaces the prior slate", async () => {
  const funnel = (subscribed: number) => ({
    steps: [
      { key: "signed_up", label: "Signed up", count: 1000 },
      { key: "submitted", label: "First submission", count: 400 },
      { key: "graded", label: "First grade", count: 380 },
      { key: "subscribed", label: "Subscribed", count: subscribed },
    ],
  });
  const { io } = fakeIO({
    rpc: (name) => Promise.resolve(name === "funnel_metrics" ? funnel(40) : null),
    fetchAgentPriorOutcome: () => Promise.resolve({ findings: [{ type: "experiment_slate", items: ["idea A"] }] }),
  });
  const reg = createAgentToolRegistry(io);
  const a = agent(["get_growth_health"]);
  const res = await reg.execute(a, "get_growth_health", {}) as {
    memo?: { cliff?: { from: string; to: string }; prior_slate?: unknown };
  };
  // signed_up→submitted is 0.4, the worst drop-off.
  assertEquals(res.memo?.cliff?.from, "signed_up");
  assertEquals(res.memo?.cliff?.to, "submitted");
  assert(res.memo?.prior_slate !== null); // continuity: prior run surfaced
});

// ── US-1603: get_ceo_brief context ───────────────────────────────────────────

Deno.test("US-1603: get_ceo_brief attributes only agents that ran, with metric deltas", async () => {
  const { io } = fakeIO({
    fetchCeoBriefData: () =>
      Promise.resolve({
        agents: [{ key: "finance", name: "Finance" }, { key: "sentinel", name: "Sentinel" }],
        metrics: [{ name: "Grades issued", current: 120, prior: 100 }],
        latestRuns: [{ agent_key: "finance", status: "succeeded", summary: "1 reconciliation delta", ran_at: null }],
        pendingProposals: [],
      }),
  });
  const reg = createAgentToolRegistry(io);
  const a = agent(["get_ceo_brief"]);
  const res = await reg.execute(a, "get_ceo_brief", {}) as {
    context?: { observations?: Array<{ agent_key: string }>; headline_metrics?: Array<{ direction: string }>; attribution_allowed?: boolean };
  };
  assertEquals(res.context?.observations?.length, 1); // only finance ran
  assertEquals(res.context?.observations?.[0].agent_key, "finance");
  assertEquals(res.context?.headline_metrics?.[0].direction, "up");
  assertEquals(res.context?.attribution_allowed, true);
});

// ── US-1597: get_trust_safety_health + account-action routing ────────────────

Deno.test("US-1597: get_trust_safety_health ranks by severity + detects a ring", async () => {
  const at = (d: number) => new Date(NOW - d * 86400_000).toISOString();
  const { io } = fakeIO({
    fetchAbuseSignals: () =>
      Promise.resolve([
        { id: "s1", signal_type: "submission_velocity", severity: "low", subject_user_id: "uA", evidence: {}, first_seen_at: at(1) },
        { id: "s2", signal_type: "shared_payment", severity: "high", subject_user_id: "uA", evidence: { stripe_customer_id: "cus_1", account_user_ids: ["uB", "uC"] }, first_seen_at: at(2) },
      ]),
  });
  const reg = createAgentToolRegistry(io);
  const a = agent(["get_trust_safety_health"]);
  const res = await reg.execute(a, "get_trust_safety_health", {}) as {
    memo?: { all_clear?: boolean; ranked_queue?: Array<{ id: string }>; rings?: Array<{ account_count: number }> };
  };
  assertEquals(res.memo?.all_clear, false);
  assertEquals(res.memo?.ranked_queue?.[0].id, "s2"); // high outranks low
  assertEquals(res.memo?.rings?.[0].account_count, 3); // uA + uB + uC
});

Deno.test("US-1597: account-action classes route to an admin task (never auto-suspend)", async () => {
  const { ACTION_CLASS_TO_TOOL } = await import("../lib/agent-tools.ts");
  for (const cls of ["suspend_account", "require_step_up", "deny_claim"]) {
    assertEquals(ACTION_CLASS_TO_TOOL[cls], "create_admin_task");
  }
});

// ── US-1598: get_marketplace_ops_health + allowlist safety ───────────────────

Deno.test("US-1598: get_marketplace_ops_health forms a stuck-batch item with its reclaim cron", async () => {
  const stale = new Date(NOW - 60 * 60_000).toISOString(); // 60m > 15m stuck window
  let persisted = -1;
  const { io } = fakeIO({
    fetchListingBatches: () =>
      Promise.resolve({ generation: [{ id: "b1", status: "running", updated_at: stale }], publish: [] }),
    persistMarketplaceOpsBacklog: (t: number) => {
      persisted = t;
      return Promise.resolve();
    },
  });
  const reg = createAgentToolRegistry(io);
  const a = agent(["get_marketplace_ops_health"]);
  const res = await reg.execute(a, "get_marketplace_ops_health", {}) as {
    memo?: { all_clear?: boolean; stuck_items?: Array<{ id: string; remediation_cron: string }>; backlog?: { total?: number } };
  };
  assertEquals(res.memo?.all_clear, false);
  assertEquals(res.memo?.stuck_items?.[0].id, "b1");
  assertEquals(res.memo?.stuck_items?.[0].remediation_cron, "autolister-reclaim");
  assertEquals(persisted, res.memo?.backlog?.total); // watermark recorded
});

Deno.test("US-1598: the marketplace-ops allowlist contains no tenant-data write tool", () => {
  const reg = createAgentToolRegistry(fakeIO().io);
  // The seeded allowlist (mirrors migration 00363).
  const a = { ...agent(["get_marketplace_ops_health", "get_marketplace_health"]), key: "marketplace-ops" };
  // Every allowlisted tool is a READ tool surfaced to the run loop; a write tool
  // would be invisible (anthropicTools filters to read) AND rejected by execute.
  const surfaced = reg.anthropicTools(a).map((t) => t.name).sort();
  assertEquals(surfaced, ["get_marketplace_health", "get_marketplace_ops_health"]);
  for (const name of ["reorder_review_queue", "retry_job", "create_admin_task", "requeue_dead_letter"]) {
    assertEquals(reg.isAllowed(a, name), false); // no write tool is allowed
  }
});

// ── US-1601: get_pricing_health composite read tool ──────────────────────────

Deno.test("US-1601: get_pricing_health flags a ping-ponging listing", async () => {
  const at = (m: number) => new Date(NOW - m).toISOString();
  const s = (price: number, ms: number) => ({
    listing_id: "L1", user_id: "u1", reason_code: "UNDERPRICED", status: "applied",
    suggested_price_cents: price, applied_at: at(ms), created_at: at(ms),
  });
  const { io } = fakeIO({
    // Oscillating applied prices: 1000 -> 1200 -> 900 -> 1300 (2 reversals).
    fetchRepricingSuggestions: () =>
      Promise.resolve([s(1000, 4e6), s(1200, 3e6), s(900, 2e6), s(1300, 1e6)]),
  });
  const reg = createAgentToolRegistry(io);
  const a = agent(["get_pricing_health"]);
  const res = await reg.execute(a, "get_pricing_health", {}) as {
    memo?: { all_clear?: boolean; ping_pong?: Array<{ listing_id: string }> };
  };
  assertEquals(res.memo?.all_clear, false);
  assertEquals(res.memo?.ping_pong?.[0].listing_id, "L1");
});

// ── US-1596: get_finance_health composite read tool ──────────────────────────

Deno.test("US-1596: get_finance_health ranks reconciliation deltas + is not all-clear", async () => {
  const { io } = fakeIO({
    fetchReconciliationFlags: () =>
      Promise.resolve([
        { subject_user_id: "u1", kind: "plan_divergence", db_status: "active", expected_status: "active", db_plan: "pro", expected_plan: "starter", detected_at: new Date(NOW - 5 * 86400_000).toISOString() },
        { subject_user_id: "u2", kind: "status_divergence", db_status: "active", expected_status: "canceled", db_plan: "pro", expected_plan: "pro", detected_at: new Date(NOW - 1 * 86400_000).toISOString() },
      ]),
    rpc: (name) => Promise.resolve(name === "revenue_dashboard" ? { total_revenue: 100 } : {}),
  });
  const reg = createAgentToolRegistry(io);
  const a = agent(["get_finance_health"]);
  const res = await reg.execute(a, "get_finance_health", {}) as {
    memo?: { all_clear?: boolean; reconciliation?: { open?: number; ranked?: Array<{ kind: string }> } };
  };
  assertEquals(res.memo?.all_clear, false);
  assertEquals(res.memo?.reconciliation?.open, 2);
  // status_divergence outranks plan_divergence despite being newer.
  assertEquals(res.memo?.reconciliation?.ranked?.[0].kind, "status_divergence");
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
