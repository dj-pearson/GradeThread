import { Hono } from "hono";
import { supabaseAdmin } from "../lib/supabase.ts";
import { jsonError } from "../lib/http-errors.ts";
import { writeAuditLog } from "../lib/audit-log.ts";
import { requireStepUp } from "../lib/step-up.ts";
import { clearFeatureFlagCache } from "../lib/feature-flags.ts";
import { deliverEmail } from "../lib/email.ts";
import {
  type DripGraph,
  type DripIncentive,
  isIncentiveEligible,
  type DripStep,
  type DripUserState,
  nextTickIso,
  renderStep,
  simulateJourney,
  validateGraph,
} from "../lib/drip-graph.ts";
import { resolveIncentive } from "../lib/drip-incentive.ts";
import {
  applyOptimizationToGraph,
  DEFAULT_OPTIMIZER_CONFIG,
  optimizeGraph,
  type VariantStats,
} from "../lib/drip-optimizer.ts";
import { requireScope } from "../lib/scope-guard.ts";

// US-946: Trial-conversion drip analytics (read-only) + US-945: the visual
// drip / journey BUILDER backing the admin page (src/pages/admin/drip.tsx).
//
// Mounted at /api/admin/drip, inheriting authMiddleware + adminAuthMiddleware
// (admin JWT + AAL2) from the /api/admin/* group in main.ts.
//
//   GET  /analytics                       — funnel/ROI rollup (RPC, 00253).
//   GET  /campaigns                        — list campaign definitions + status.
//   GET  /campaigns/:c                     — full editable step graph.
//   PUT  /campaigns/:c/graph               — save graph (validated). super_admin
//                                            + fresh MFA step-up + audited.
//   POST /campaigns/:c/status              — pause/resume/kill (kill flips the
//                                            linked feature flag). super_admin +
//                                            step-up + audited.
//   POST /campaigns/:c/validate            — validate a proposed graph (no write).
//   POST /campaigns/:c/preview             — render a step's HTML (no write).
//   POST /campaigns/:c/test-send           — send a rendered step to an admin
//                                            address (audited).
//   POST /campaigns/:c/regenerate          — AI-draft step copy from the brief.
//   GET  /campaigns/:c/enrollments         — live: counts by step + recent exits.
//   GET  /campaigns/:c/users/:userId       — one user's journey + send history.
//   POST /campaigns/:c/simulate            — dry-run the evaluator for a user.
//   GET  /campaigns/:c/optimizer           — US-944: per-step A/B performance +
//                                            recommended self-tuned weights.
//   POST /campaigns/:c/optimizer/apply     — US-944: apply recommended weights
//                                            (and toggle autotune). super_admin +
//                                            step-up + audited.

type AdminEnv = {
  Variables: {
    userId: string;
    adminRole: "admin" | "super_admin";
  };
};

export const adminDripRoutes = new Hono<AdminEnv>();

// US-1560: whole-router scope guard (see lib/admin-scope-map.ts).
adminDripRoutes.use("*", requireScope("growth:write"));

const DAY_MS = 24 * 60 * 60 * 1000;

// Named lookback windows → days. `custom` honors explicit start/end.
const PERIOD_DAYS: Record<string, number> = {
  "30d": 30,
  "90d": 90,
  "180d": 180,
  "365d": 365,
};

// GET /api/admin/drip/analytics?campaign=trial_conversion&period=90d
//     [&start=ISO&end=ISO]  (period=custom)
adminDripRoutes.get("/analytics", async (c) => {
  const campaign = (c.req.query("campaign") ?? "trial_conversion").trim() ||
    "trial_conversion";
  const period = c.req.query("period") ?? "90d";

  let start: string;
  let end: string;

  if (period === "custom") {
    const rawStart = c.req.query("start");
    const rawEnd = c.req.query("end");
    const startMs = rawStart ? Date.parse(rawStart) : NaN;
    const endMs = rawEnd ? Date.parse(rawEnd) : NaN;
    if (Number.isNaN(startMs) || Number.isNaN(endMs) || startMs >= endMs) {
      return c.json({ error: "Invalid custom start/end range" }, 400);
    }
    start = new Date(startMs).toISOString();
    end = new Date(endMs).toISOString();
  } else {
    const days = PERIOD_DAYS[period];
    if (!days) {
      return c.json(
        { error: `Unknown period '${period}' (expected 30d|90d|180d|365d|custom)` },
        400,
      );
    }
    const now = Date.now();
    start = new Date(now - days * DAY_MS).toISOString();
    end = new Date(now).toISOString();
  }

  const { data, error } = await supabaseAdmin.rpc("drip_analytics", {
    p_campaign: campaign,
    p_start: start,
    p_end: end,
  });

  if (error) {
    console.error("[admin-drip] drip_analytics failed:", error);
    return c.json({ error: "Failed to load drip analytics" }, 500);
  }

  return c.json({
    period,
    campaign,
    window: { start, end },
    analytics: data,
    // Stripe stays authoritative for realized conversions/MRR; the RPC reports a
    // reconciliation rate + documented tolerance so the client can surface it.
    stripeSourceOfTruth: true,
  });
});

// ── Builder (US-945) ──

interface CampaignRow {
  campaign: string;
  name: string;
  status: "active" | "paused" | "killed";
  feature_flag_key: string | null;
  // US-935: the campaign declares its conversion goal + target audience.
  goal_event: string;
  audience: string | null;
  graph: DripGraph;
  updated_at: string;
}

async function loadCampaign(campaign: string): Promise<CampaignRow | null> {
  const { data } = await supabaseAdmin
    .from("drip_campaigns")
    .select("campaign, name, status, feature_flag_key, goal_event, audience, graph, updated_at")
    .eq("campaign", campaign)
    .maybeSingle();
  return (data as CampaignRow | null) ?? null;
}

// Derive the dry-run user state from the users row + drip enrollment.
async function loadUserState(
  userId: string,
  campaign: string,
): Promise<(DripUserState & { userId: string; enrolledAtMs: number; email: string | null }) | null> {
  const { data: u } = await supabaseAdmin
    .from("users")
    // US-2398: flipdesk_plan, matching the LIVE tick (drip.ts). Reading the
    // legacy users.plan here would make the dry run disagree with the campaign
    // it is previewing — the one thing a dry run must not do.
    .select(
      "id, email, full_name, flipdesk_plan, subscription_status, trial_ends_at, grades_used_this_month, created_at",
    )
    .eq("id", userId)
    .maybeSingle();
  if (!u) return null;

  const user = u as {
    id: string;
    email: string | null;
    full_name: string | null;
    flipdesk_plan: string | null;
    subscription_status: string | null;
    trial_ends_at: string | null;
    grades_used_this_month: number | null;
    created_at: string | null;
  };

  const { data: enrollment } = await supabaseAdmin
    .from("drip_enrollments")
    .select("enrolled_at, converted_at")
    .eq("user_id", userId)
    .eq("campaign", campaign)
    .order("enrolled_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  const now = Date.now();
  const enrolledAtMs = enrollment?.enrolled_at
    ? Date.parse(enrollment.enrolled_at as string)
    : (user.created_at ? Date.parse(user.created_at) : now);
  const trialEndMs = user.trial_ends_at ? Date.parse(user.trial_ends_at) : null;
  const converted = !!enrollment?.converted_at ||
    user.subscription_status === "active";

  return {
    userId: user.id,
    email: user.email,
    firstName: (user.full_name ?? "").trim().split(/\s+/)[0] || null,
    trialEndsAt: user.trial_ends_at,
    converted,
    plan: user.flipdesk_plan,
    subscriptionStatus: user.subscription_status,
    gradesUsed: user.grades_used_this_month ?? 0,
    trialDaysRemaining: trialEndMs ? Math.ceil((trialEndMs - now) / DAY_MS) : 0,
    daysSinceSignup: Math.floor((now - enrolledAtMs) / DAY_MS),
    enrolledAtMs,
  };
}

// GET /campaigns — list definitions + status + next tick.
adminDripRoutes.get("/campaigns", async (c) => {
  const { data, error } = await supabaseAdmin
    .from("drip_campaigns")
    .select("campaign, name, status, feature_flag_key, goal_event, audience, updated_at")
    .order("campaign");
  if (error) return jsonError(c, 500, "Failed to load campaigns");
  return c.json({ campaigns: data ?? [], nextTick: nextTickIso(Date.now()) });
});

// GET /campaigns/:campaign — full editable step graph.
adminDripRoutes.get("/campaigns/:campaign", async (c) => {
  const row = await loadCampaign(c.req.param("campaign"));
  if (!row) return jsonError(c, 404, "Unknown campaign");
  return c.json({ campaign: row, nextTick: nextTickIso(Date.now()) });
});

// POST /campaigns/:campaign/validate — validate a proposed graph (no write).
adminDripRoutes.post("/campaigns/:campaign/validate", async (c) => {
  let body: { graph?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return jsonError(c, 400, "Invalid JSON body");
  }
  return c.json(validateGraph(body.graph));
});

// PUT /campaigns/:campaign/graph — save the edited graph.
// super_admin + fresh MFA step-up + audited (a bad graph changes live sends).
adminDripRoutes.put("/campaigns/:campaign/graph", async (c) => {
  if (c.get("adminRole") !== "super_admin") {
    return jsonError(c, 403, "Super admin required to edit the drip graph.");
  }
  const stepUp = requireStepUp(c);
  if (stepUp) return stepUp;

  const campaign = c.req.param("campaign");
  let body: { graph?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return jsonError(c, 400, "Invalid JSON body");
  }

  const validation = validateGraph(body.graph);
  if (!validation.ok) {
    return c.json({ error: "Invalid graph", code: "GRAPH_INVALID", errors: validation.errors }, 400);
  }

  const before = await loadCampaign(campaign);
  if (!before) return jsonError(c, 404, "Unknown campaign");

  const { data: after, error } = await supabaseAdmin
    .from("drip_campaigns")
    .update({ graph: body.graph, updated_by: c.get("userId") })
    .eq("campaign", campaign)
    .select("campaign, name, status, feature_flag_key, graph, updated_at")
    .maybeSingle();
  if (error) return jsonError(c, 500, "Failed to save graph");

  await writeAuditLog(c, {
    action: "drip.graph_update",
    targetType: "drip_campaign",
    targetId: campaign,
    before: { graph: before.graph },
    after: { graph: body.graph },
  });

  return c.json({ ok: true, campaign: after });
});

// POST /campaigns/:campaign/status — pause / resume / kill.
// Kill flips the linked feature flag OFF so the engine hard-stops everywhere.
adminDripRoutes.post("/campaigns/:campaign/status", async (c) => {
  if (c.get("adminRole") !== "super_admin") {
    return jsonError(c, 403, "Super admin required to change campaign status.");
  }
  const stepUp = requireStepUp(c);
  if (stepUp) return stepUp;

  const campaign = c.req.param("campaign");
  let body: { action?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return jsonError(c, 400, "Invalid JSON body");
  }
  const action = body.action;
  const STATUS: Record<string, "active" | "paused" | "killed"> = {
    resume: "active",
    pause: "paused",
    kill: "killed",
  };
  if (typeof action !== "string" || !(action in STATUS)) {
    return jsonError(c, 400, "action must be one of: pause, resume, kill");
  }
  const status = STATUS[action];

  const before = await loadCampaign(campaign);
  if (!before) return jsonError(c, 404, "Unknown campaign");

  const { error } = await supabaseAdmin
    .from("drip_campaigns")
    .update({ status, updated_by: c.get("userId") })
    .eq("campaign", campaign);
  if (error) return jsonError(c, 500, "Failed to update status");

  // Kill integrates with the feature-flag kill-switch (US-507): flip the linked
  // flag off so EVERY engine replica stops sending within the cache TTL.
  let flagToggled = false;
  if (action === "kill" && before.feature_flag_key) {
    const { error: flagErr } = await supabaseAdmin
      .from("feature_flags")
      .update({ enabled: false, updated_by: c.get("userId") })
      .eq("key", before.feature_flag_key);
    if (!flagErr) {
      clearFeatureFlagCache();
      flagToggled = true;
    }
  } else if (action === "resume" && before.feature_flag_key) {
    const { error: flagErr } = await supabaseAdmin
      .from("feature_flags")
      .update({ enabled: true, updated_by: c.get("userId") })
      .eq("key", before.feature_flag_key);
    if (!flagErr) {
      clearFeatureFlagCache();
      flagToggled = true;
    }
  }

  await writeAuditLog(c, {
    action: `drip.status_${action}`,
    targetType: "drip_campaign",
    targetId: campaign,
    before: { status: before.status },
    after: { status, flagToggled },
  });

  return c.json({ ok: true, status, flagToggled });
});

// POST /campaigns/:campaign/preview — render a step's HTML for a sample user.
// Body: { step, variantId?, sampleUserId? }. The step is sent from the client so
// the preview reflects UNSAVED edits.
adminDripRoutes.post("/campaigns/:campaign/preview", async (c) => {
  const campaign = c.req.param("campaign");
  let body: {
    step?: unknown;
    variantId?: string;
    sampleUserId?: string;
    incentive?: DripIncentive;
  };
  try {
    body = await c.req.json();
  } catch {
    return jsonError(c, 400, "Invalid JSON body");
  }
  const step = body.step as DripStep | undefined;
  if (!step || !Array.isArray(step.variants) || step.variants.length === 0) {
    return jsonError(c, 400, "step with at least one variant is required");
  }

  let user: DripUserState = { firstName: "Alex", trialEndsAt: new Date(Date.now() + 3 * DAY_MS).toISOString() };
  if (body.sampleUserId) {
    const loaded = await loadUserState(body.sampleUserId, campaign);
    if (loaded) user = loaded;
  }

  // US-942: reflect the incentive in the preview EXACTLY as a real recipient
  // would see it — only when eligible (win-back step, not already-paid) and the
  // campaign incentive resolves against a valid Stripe coupon. `incentive` is
  // taken from the request so unsaved builder edits preview correctly.
  const incentive = isIncentiveEligible(step, user)
    ? (await resolveIncentive(body.incentive ?? null, Date.now()))?.incentive ?? null
    : null;

  const rendered = renderStep(step, user, body.variantId, incentive);
  if (!rendered) return jsonError(c, 400, "Could not render step");
  return c.json(rendered);
});

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// POST /campaigns/:campaign/test-send — send a rendered step to an admin address.
// Body: { step, variantId?, to }. Audited.
adminDripRoutes.post("/campaigns/:campaign/test-send", async (c) => {
  // US-2356 AC2: the recipient is operator-supplied, so this is a
  // content-exfiltration channel as much as a preview — campaign copy can be
  // sent to any address at all. A step-up makes that a deliberate act.
  {
    const stepUp = requireStepUp(c);
    if (stepUp) return stepUp;
  }
  const campaign = c.req.param("campaign");
  let body: { step?: unknown; variantId?: string; to?: string; incentive?: DripIncentive };
  try {
    body = await c.req.json();
  } catch {
    return jsonError(c, 400, "Invalid JSON body");
  }
  const to = (body.to ?? "").trim();
  if (!EMAIL_RE.test(to)) return jsonError(c, 400, "A valid 'to' email is required");
  const step = body.step as DripStep | undefined;
  if (!step || !Array.isArray(step.variants) || step.variants.length === 0) {
    return jsonError(c, 400, "step with at least one variant is required");
  }

  const sampleUser: DripUserState = {
    firstName: "Alex",
    trialEndsAt: new Date(Date.now() + 3 * DAY_MS).toISOString(),
  };
  // US-942: surface the incentive in the test send exactly as a real recipient
  // would (eligible win-back step + valid coupon), so QA sees the real offer.
  const incentive = isIncentiveEligible(step, sampleUser)
    ? (await resolveIncentive(body.incentive ?? null, Date.now()))?.incentive ?? null
    : null;

  const rendered = renderStep(step, sampleUser, body.variantId, incentive);
  if (!rendered) return jsonError(c, 400, "Could not render step");

  const ok = await deliverEmail({
    to,
    subject: `[TEST] ${rendered.subject}`,
    html: `<p style="color:#888;font-size:12px">Drip test send — campaign '${campaign}', step '${step.id}', variant '${rendered.variantId}'.</p>${rendered.html}`,
  });

  await writeAuditLog(c, {
    action: "drip.test_send",
    targetType: "drip_campaign",
    targetId: campaign,
    details: { stepId: step.id, variantId: rendered.variantId, to, delivered: ok },
  });

  if (!ok) return jsonError(c, 502, "Email send failed (check SMTP config)");
  return c.json({ ok: true, to, variantId: rendered.variantId });
});

// POST /campaigns/:campaign/regenerate — AI-draft step copy from the brief.
// Returns proposed { subject, html } for the admin to review and then save via
// PUT graph. Does NOT persist.
adminDripRoutes.post("/campaigns/:campaign/regenerate", async (c) => {
  let body: { brief?: string; instruction?: string; incentiveEnabled?: boolean };
  try {
    body = await c.req.json();
  } catch {
    return jsonError(c, 400, "Invalid JSON body");
  }
  const brief = (body.brief ?? "").trim();
  if (!brief) return jsonError(c, 400, "A brief is required to regenerate copy");

  // Lazy import keeps the AI client (and its env requirements) off the hot path
  // for the read-only endpoints in this router.
  const { getAnthropicClient, getDefaultModel } = await import("../lib/ai-config.ts");
  const { enterAiFeature } = await import("../lib/ai-feature-context.ts");
  enterAiFeature("drip", c.get("userId") ?? null);

  const system = [
    "You write transactional/marketing email copy for GradeThread, a clothing",
    "condition-grading SaaS. Return STRICT JSON: {\"subject\": string, \"html\": string}.",
    "Keep subject < 60 chars. HTML is simple paragraphs only (<p>, <a>).",
    "You MAY use {{firstName}}, {{trialEndsAt}}, and {{incentive}} placeholders.",
    body.incentiveEnabled
      ? "Include the {{incentive}} placeholder once."
      : "Do NOT include {{incentive}}.",
  ].join(" ");
  const userPrompt = [
    `Brief: ${brief}`,
    body.instruction ? `Refinement: ${body.instruction.trim()}` : "",
  ].filter(Boolean).join("\n");

  try {
    const client = getAnthropicClient();
    const resp = await client.messages.create({
      model: getDefaultModel(),
      max_tokens: 1024,
      system,
      messages: [{ role: "user", content: userPrompt }],
    });
    const textBlock = resp.content.find((b) => b.type === "text");
    if (!textBlock || textBlock.type !== "text") {
      return jsonError(c, 502, "AI returned no copy");
    }
    const cleaned = textBlock.text.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
    const parsed = JSON.parse(cleaned) as { subject?: unknown; html?: unknown };
    if (typeof parsed.subject !== "string" || typeof parsed.html !== "string") {
      return jsonError(c, 502, "AI returned malformed copy");
    }
    return c.json({ subject: parsed.subject, html: parsed.html });
  } catch (e) {
    console.error("[admin-drip] regenerate failed:", e instanceof Error ? e.message : String(e));
    return jsonError(c, 502, "Copy generation failed");
  }
});

// GET /campaigns/:campaign/enrollments — live: current count per step + recent
// exits. "Current step" = the highest step ordinal an ACTIVE (not-yet-exited)
// enrollment has been sent.
adminDripRoutes.get("/campaigns/:campaign/enrollments", async (c) => {
  const campaign = c.req.param("campaign");

  // Active enrollments and their latest send step.
  const { data: active, error: aErr } = await supabaseAdmin
    .from("drip_enrollments")
    .select("id")
    .eq("campaign", campaign)
    .is("exited_at", null)
    .limit(5000);
  if (aErr) return jsonError(c, 500, "Failed to load enrollments");
  const activeIds = (active ?? []).map((r) => (r as { id: string }).id);

  const byStep: Record<string, number> = {};
  if (activeIds.length > 0) {
    const { data: sends } = await supabaseAdmin
      .from("drip_sends")
      .select("enrollment_id, step")
      .eq("campaign", campaign)
      .in("enrollment_id", activeIds)
      .limit(50000);
    // Highest step per enrollment.
    const maxByEnrollment = new Map<string, number>();
    for (const s of (sends ?? []) as Array<{ enrollment_id: string; step: number }>) {
      const cur = maxByEnrollment.get(s.enrollment_id);
      if (cur === undefined || s.step > cur) maxByEnrollment.set(s.enrollment_id, s.step);
    }
    // Enrollments with no send yet sit at step 0 (enrolled, not yet contacted).
    let unsent = activeIds.length;
    for (const step of maxByEnrollment.values()) {
      byStep[String(step)] = (byStep[String(step)] ?? 0) + 1;
      unsent--;
    }
    if (unsent > 0) byStep["0"] = (byStep["0"] ?? 0) + unsent;
  }

  // Recent exits (converted / lapsed).
  const { data: exits } = await supabaseAdmin
    .from("drip_enrollments")
    .select("user_id, exited_at, exit_reason, converted_at")
    .eq("campaign", campaign)
    .not("exited_at", "is", null)
    .order("exited_at", { ascending: false })
    .limit(25);

  return c.json({
    activeEnrollments: activeIds.length,
    byStep,
    recentExits: exits ?? [],
  });
});

// GET /campaigns/:campaign/users/:userId — one user's journey + send history.
adminDripRoutes.get("/campaigns/:campaign/users/:userId", async (c) => {
  const campaign = c.req.param("campaign");
  const userId = c.req.param("userId");

  const { data: enrollment } = await supabaseAdmin
    .from("drip_enrollments")
    .select("id, enrolled_at, trial_started_at, converted_at, exited_at, exit_reason, variant, incentive_enabled")
    .eq("campaign", campaign)
    .eq("user_id", userId)
    .order("enrolled_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  let sends: unknown[] = [];
  if (enrollment) {
    const { data } = await supabaseAdmin
      .from("drip_sends")
      .select("step, phase, variant, sent_at, opened_at, clicked_at, unsubscribed")
      .eq("enrollment_id", (enrollment as { id: string }).id)
      .order("step", { ascending: true });
    sends = data ?? [];
  }

  return c.json({ userId, enrollment: enrollment ?? null, sends });
});

// POST /campaigns/:campaign/simulate — dry-run the evaluator for one account.
// Body: { userId }.
adminDripRoutes.post("/campaigns/:campaign/simulate", async (c) => {
  const campaign = c.req.param("campaign");
  let body: { userId?: string };
  try {
    body = await c.req.json();
  } catch {
    return jsonError(c, 400, "Invalid JSON body");
  }
  const userId = (body.userId ?? "").trim();
  if (!userId) return jsonError(c, 400, "userId is required");

  const row = await loadCampaign(campaign);
  if (!row) return jsonError(c, 404, "Unknown campaign");

  const user = await loadUserState(userId, campaign);
  if (!user) return jsonError(c, 404, "User not found");

  const now = Date.now();
  const result = simulateJourney(row.graph, user, now);
  return c.json({
    userId,
    user: {
      email: user.email,
      firstName: user.firstName,
      plan: user.plan,
      subscriptionStatus: user.subscriptionStatus,
      converted: user.converted,
      trialDaysRemaining: user.trialDaysRemaining,
    },
    campaignStatus: row.status,
    nextTick: nextTickIso(now),
    result,
  });
});

// ── Per-step A/B optimizer + conversion self-tuning (US-944) ──

interface SendRow {
  enrollment_id: string;
  step: number;
  variant: string | null;
  sent_at: string | null;
  opened_at: string | null;
  clicked_at: string | null;
  unsubscribed: boolean;
}

/**
 * Aggregate the send/attribution ledger into per-(ordinal,variant) stats the
 * optimizer consumes. Conversion is attributed by joining each send to its
 * enrollment's attribution (one per converted enrollment) — so every variant a
 * converter was exposed to at each step gets credit. Windowed by sent_at.
 */
async function loadVariantStats(
  campaign: string,
  startIso: string,
  endIso: string,
): Promise<Record<number, Record<string, VariantStats>>> {
  const { data: sendsData } = await supabaseAdmin
    .from("drip_sends")
    .select("enrollment_id, step, variant, sent_at, opened_at, clicked_at, unsubscribed")
    .eq("campaign", campaign)
    .not("sent_at", "is", null)
    .gte("sent_at", startIso)
    .lt("sent_at", endIso)
    .limit(100000);
  const sends = (sendsData ?? []) as SendRow[];

  // Enrollments that converted (any time) — used to attribute conversions.
  const { data: attrData } = await supabaseAdmin
    .from("drip_attributions")
    .select("enrollment_id")
    .eq("campaign", campaign)
    .limit(100000);
  const converted = new Set(
    (attrData ?? []).map((r) => (r as { enrollment_id: string }).enrollment_id),
  );

  const byOrdinal: Record<number, Record<string, VariantStats>> = {};
  for (const s of sends) {
    if (!s.variant) continue; // can't attribute a null variant to a graph arm
    const ord = byOrdinal[s.step] ?? (byOrdinal[s.step] = {});
    const acc = ord[s.variant] ?? (ord[s.variant] = {
      variantId: s.variant,
      sent: 0,
      opened: 0,
      clicked: 0,
      converted: 0,
      unsubscribed: 0,
    });
    acc.sent += 1;
    if (s.opened_at) acc.opened += 1;
    if (s.clicked_at) acc.clicked += 1;
    if (s.unsubscribed) acc.unsubscribed += 1;
    if (converted.has(s.enrollment_id)) acc.converted += 1;
  }
  return byOrdinal;
}

function optimizerWindow(period: string, startQ?: string, endQ?: string):
  | { start: string; end: string }
  | { error: string } {
  if (period === "custom") {
    const startMs = startQ ? Date.parse(startQ) : NaN;
    const endMs = endQ ? Date.parse(endQ) : NaN;
    if (Number.isNaN(startMs) || Number.isNaN(endMs) || startMs >= endMs) {
      return { error: "Invalid custom start/end range" };
    }
    return { start: new Date(startMs).toISOString(), end: new Date(endMs).toISOString() };
  }
  const days = PERIOD_DAYS[period];
  if (!days) return { error: `Unknown period '${period}' (expected 30d|90d|180d|365d|custom)` };
  const now = Date.now();
  return { start: new Date(now - days * DAY_MS).toISOString(), end: new Date(now).toISOString() };
}

// GET /campaigns/:campaign/optimizer?period=90d — per-step A/B performance +
// recommended self-tuned weights (read-only; nothing is applied).
adminDripRoutes.get("/campaigns/:campaign/optimizer", async (c) => {
  const campaign = c.req.param("campaign");
  const row = await loadCampaign(campaign);
  if (!row) return jsonError(c, 404, "Unknown campaign");

  const win = optimizerWindow(
    c.req.query("period") ?? "90d",
    c.req.query("start") ?? undefined,
    c.req.query("end") ?? undefined,
  );
  if ("error" in win) return c.json({ error: win.error }, 400);

  const stats = await loadVariantStats(campaign, win.start, win.end);
  const optimizations = optimizeGraph(row.graph, stats, DEFAULT_OPTIMIZER_CONFIG);

  return c.json({
    campaign,
    window: win,
    autotuneEnabled: row.graph.autotuneEnabled === true,
    config: DEFAULT_OPTIMIZER_CONFIG,
    optimizations,
    // Any multi-variant step whose recommended weights differ from current.
    changedSteps: optimizations.filter((o) => o.changed).length,
  });
});

// POST /campaigns/:campaign/optimizer/apply — apply the recommended weights to
// the live graph and/or toggle autotune. Body: { autotuneEnabled?: boolean,
// applyWeights?: boolean (default true), period? }. super_admin + step-up +
// audited (it changes live sends, same as a manual graph edit).
adminDripRoutes.post("/campaigns/:campaign/optimizer/apply", async (c) => {
  if (c.get("adminRole") !== "super_admin") {
    return jsonError(c, 403, "Super admin required to apply optimizer changes.");
  }
  const stepUp = requireStepUp(c);
  if (stepUp) return stepUp;

  const campaign = c.req.param("campaign");
  let body: { autotuneEnabled?: boolean; applyWeights?: boolean; period?: string };
  try {
    body = await c.req.json();
  } catch {
    return jsonError(c, 400, "Invalid JSON body");
  }

  const before = await loadCampaign(campaign);
  if (!before) return jsonError(c, 404, "Unknown campaign");

  const applyWeights = body.applyWeights !== false;
  const win = optimizerWindow(body.period ?? "90d");
  if ("error" in win) return c.json({ error: win.error }, 400);

  let nextGraph: DripGraph = before.graph;
  let optimizations: ReturnType<typeof optimizeGraph> = [];
  if (applyWeights) {
    const stats = await loadVariantStats(campaign, win.start, win.end);
    optimizations = optimizeGraph(before.graph, stats, DEFAULT_OPTIMIZER_CONFIG);
    nextGraph = applyOptimizationToGraph(before.graph, optimizations);
  }
  if (typeof body.autotuneEnabled === "boolean") {
    nextGraph = { ...nextGraph, autotuneEnabled: body.autotuneEnabled };
  }

  // Validate the resulting graph before persisting (defense in depth).
  const validation = validateGraph(nextGraph);
  if (!validation.ok) {
    return c.json({ error: "Optimized graph is invalid", code: "GRAPH_INVALID", errors: validation.errors }, 400);
  }

  const { data: after, error } = await supabaseAdmin
    .from("drip_campaigns")
    .update({ graph: nextGraph, updated_by: c.get("userId") })
    .eq("campaign", campaign)
    .select("campaign, name, status, feature_flag_key, graph, updated_at")
    .maybeSingle();
  if (error) return jsonError(c, 500, "Failed to apply optimizer changes");

  await writeAuditLog(c, {
    action: "drip.optimizer_apply",
    targetType: "drip_campaign",
    targetId: campaign,
    details: {
      applyWeights,
      autotuneEnabled: body.autotuneEnabled,
      changedSteps: optimizations.filter((o) => o.changed).map((o) => ({
        stepId: o.stepId,
        winnerId: o.winnerId,
        recommendedWeights: o.recommendedWeights,
      })),
    },
  });

  return c.json({
    ok: true,
    campaign: after,
    appliedWeights: applyWeights,
    autotuneEnabled: nextGraph.autotuneEnabled === true,
    optimizations,
  });
});
