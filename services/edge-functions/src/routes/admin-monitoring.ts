import { Hono } from "hono";
import { supabaseAdmin } from "../lib/supabase.ts";
import { writeAuditLog } from "../lib/audit-log.ts";
import {
  type CheckedUpdateClient,
  updateByIdChecked,
  ZeroRowsAffectedError,
} from "../lib/db-write.ts";
import {
  perDayMessageCap,
  perDayTokenCap,
  perMinuteMessageCap,
  SUPPORT_ABUSE_THRESHOLDS,
} from "../lib/support-abuse.ts";
import type { FlipdeskPlan } from "../lib/pricing-config.ts";
import { effectivePlanFor } from "../lib/grade-pricing.ts";

// US-841: admin abuse & usage monitoring for the AI Support Assistant.
//
// Mounted at /api/admin/support-monitoring — inherits authMiddleware +
// adminAuthMiddleware (admin/super_admin + AAL2 MFA) from the /api/admin/*
// group in main.ts. Everything here is service-role: support_assistant_usage,
// support_abuse_events and support_messages all have RLS on with NO policies
// (00181/00185), so they're never client-readable and the SPA can't write the
// unlock either.
//
// These are admin-gated, intentionally CROSS-TENANT reads/writes (the monitor
// spans every user's usage + abuse signals) — the mandatory per-tenant scoping
// rule for user-initiated endpoints does not apply here; the admin+MFA gate is
// the authorization boundary, mirroring admin-support.ts / admin-disputes.ts.
//
// Surfaces: recent abuse events (filterable), per-user usage rollups with the
// per-tier caps from US-836 so the team can see how close users are to limits,
// current lockouts with a manual-unlock action (clears
// users.support_assistant_locked_until), and flagged messages (US-829).

type AdminEnv = {
  Variables: {
    userId: string;
    adminRole: "admin" | "super_admin";
  };
};

export const adminMonitoringRoutes = new Hono<AdminEnv>();

const db = supabaseAdmin as unknown as CheckedUpdateClient;

const ABUSE_TYPES = new Set([
  "jailbreak_attempt",
  "prompt_injection",
  "flood",
  "policy_violation",
  "repeated_failure",
  "scope_probe",
]);
const ABUSE_SEVERITIES = new Set(["low", "medium", "high"]);

interface UserMeta {
  email: string | null;
  full_name: string | null;
  plan: FlipdeskPlan;
  locked_until: string | null;
  lockout_count: number;
}

// Resolve { id → { email, full_name, effective plan, lockout state } } for a set
// of user ids in one read, so the monitor can show who each row belongs to and
// each user's effective tier (the caps key off it) without N+1 queries.
async function loadUserMeta(
  userIds: string[],
): Promise<Map<string, UserMeta>> {
  const unique = [...new Set(userIds.filter(Boolean))];
  const out = new Map<string, UserMeta>();
  if (unique.length === 0) return out;
  const { data } = await supabaseAdmin
    .from("users")
    .select(
      "id, email, full_name, flipdesk_plan, subscription_status, " +
        "trial_ends_at, past_due_since, support_assistant_locked_until, " +
        "support_assistant_lockout_count",
    )
    .in("id", unique);
  const now = new Date();
  for (
    const u of (data ?? []) as unknown as Array<{
      id: string;
      email: string | null;
      full_name: string | null;
      flipdesk_plan: string | null;
      subscription_status: string | null;
      trial_ends_at: string | null;
      past_due_since: string | null;
      support_assistant_locked_until: string | null;
      support_assistant_lockout_count: number | null;
    }>
  ) {
    out.set(u.id, {
      email: u.email,
      full_name: u.full_name,
      plan: effectivePlanFor(
        u.flipdesk_plan ?? "free",
        u.subscription_status,
        u.trial_ends_at,
        now,
        u.past_due_since,
      ) as FlipdeskPlan,
      locked_until: u.support_assistant_locked_until,
      lockout_count: u.support_assistant_lockout_count ?? 0,
    });
  }
  return out;
}

// ── GET /thresholds — the per-tier caps in effect (US-836) ───────────────────
adminMonitoringRoutes.get("/thresholds", (c) => {
  return c.json({ thresholds: SUPPORT_ABUSE_THRESHOLDS });
});

// ── GET /usage — today's per-user usage rollups + current lockouts ───────────
// Returns each user's UTC-day message/token/escalation counts joined with their
// effective plan + that tier's caps, plus the list of users currently locked
// out (which may include users with no usage row today). The thresholds block
// is echoed so the panel can render limits without a second call.
adminMonitoringRoutes.get("/usage", async (c) => {
  const today = new Date().toISOString().slice(0, 10);

  const { data: usageData, error: usageErr } = await supabaseAdmin
    .from("support_assistant_usage")
    .select(
      "user_id, message_count, input_tokens, output_tokens, escalation_count",
    )
    .eq("usage_date", today)
    .order("message_count", { ascending: false })
    .limit(200);
  if (usageErr) {
    console.error("[admin-monitoring] usage read failed:", usageErr.message);
    return c.json({ error: "Could not load usage" }, 500);
  }

  // Users currently locked out (timestamp in the future). These may not have a
  // usage row today, so they're fetched independently and merged.
  const nowIso = new Date().toISOString();
  const { data: lockedData } = await supabaseAdmin
    .from("users")
    .select("id")
    .gt("support_assistant_locked_until", nowIso)
    .limit(200);

  const usageRows = (usageData ?? []) as Array<{
    user_id: string;
    message_count: number | null;
    input_tokens: number | null;
    output_tokens: number | null;
    escalation_count: number | null;
  }>;
  const lockedIds = ((lockedData ?? []) as Array<{ id: string }>).map((r) =>
    r.id
  );

  const meta = await loadUserMeta([
    ...usageRows.map((r) => r.user_id),
    ...lockedIds,
  ]);

  const usage = usageRows.map((r) => {
    const m = meta.get(r.user_id);
    const plan = m?.plan ?? "free";
    const messages = r.message_count ?? 0;
    const tokens = (r.input_tokens ?? 0) + (r.output_tokens ?? 0);
    return {
      user_id: r.user_id,
      email: m?.email ?? null,
      name: m?.full_name ?? null,
      plan,
      messages,
      input_tokens: r.input_tokens ?? 0,
      output_tokens: r.output_tokens ?? 0,
      total_tokens: tokens,
      escalations: r.escalation_count ?? 0,
      per_minute_cap: perMinuteMessageCap(plan),
      message_cap: perDayMessageCap(plan),
      token_cap: perDayTokenCap(plan),
      locked_until: m?.locked_until ?? null,
    };
  });

  const lockouts = lockedIds.map((id) => {
    const m = meta.get(id);
    return {
      user_id: id,
      email: m?.email ?? null,
      name: m?.full_name ?? null,
      plan: m?.plan ?? "free",
      locked_until: m?.locked_until ?? null,
      lockout_count: m?.lockout_count ?? 0,
    };
  });

  return c.json({ thresholds: SUPPORT_ABUSE_THRESHOLDS, usage, lockouts });
});

// ── GET /abuse-events — recent abuse log, optional ?type / ?severity filters ─
adminMonitoringRoutes.get("/abuse-events", async (c) => {
  const typeParam = c.req.query("type");
  const sevParam = c.req.query("severity");
  const type = typeParam && ABUSE_TYPES.has(typeParam) ? typeParam : null;
  const severity = sevParam && ABUSE_SEVERITIES.has(sevParam) ? sevParam : null;

  let query = supabaseAdmin
    .from("support_abuse_events")
    .select("id, user_id, conversation_id, type, severity, detail, created_at")
    .order("created_at", { ascending: false })
    .limit(200);
  if (type) query = query.eq("type", type);
  if (severity) query = query.eq("severity", severity);

  const { data, error } = await query;
  if (error) {
    console.error("[admin-monitoring] abuse read failed:", error.message);
    return c.json({ error: "Could not load abuse events" }, 500);
  }

  const rows = (data ?? []) as Array<
    { user_id: string } & Record<string, unknown>
  >;
  const meta = await loadUserMeta(rows.map((r) => r.user_id));
  const events = rows.map((r) => ({
    ...r,
    user_email: meta.get(r.user_id)?.email ?? null,
  }));

  return c.json({ events });
});

// ── GET /flagged-messages — messages flagged by the abuse pipeline (US-829) ──
adminMonitoringRoutes.get("/flagged-messages", async (c) => {
  const { data, error } = await supabaseAdmin
    .from("support_messages")
    .select("id, conversation_id, role, content, flag_reason, created_at")
    .eq("flagged", true)
    .order("created_at", { ascending: false })
    .limit(200);
  if (error) {
    console.error("[admin-monitoring] flagged read failed:", error.message);
    return c.json({ error: "Could not load flagged messages" }, 500);
  }

  const rows = (data ?? []) as Array<{
    id: string;
    conversation_id: string;
    role: string;
    content: string;
    flag_reason: string | null;
    created_at: string;
  }>;

  // Resolve each message's owning user via its conversation (two hops).
  const convIds = [...new Set(rows.map((r) => r.conversation_id))];
  const convOwner = new Map<string, { user_id: string; subject: string | null }>();
  if (convIds.length > 0) {
    const { data: convs } = await supabaseAdmin
      .from("support_conversations")
      .select("id, user_id, subject")
      .in("id", convIds);
    for (
      const v of (convs ?? []) as Array<
        { id: string; user_id: string; subject: string | null }
      >
    ) {
      convOwner.set(v.id, { user_id: v.user_id, subject: v.subject });
    }
  }
  const meta = await loadUserMeta(
    [...convOwner.values()].map((v) => v.user_id),
  );

  const messages = rows.map((r) => {
    const owner = convOwner.get(r.conversation_id);
    return {
      id: r.id,
      conversation_id: r.conversation_id,
      role: r.role,
      // Trim so the table stays readable; full transcript lives in the inbox.
      content: r.content.length > 400 ? r.content.slice(0, 400) + "…" : r.content,
      flag_reason: r.flag_reason,
      created_at: r.created_at,
      user_id: owner?.user_id ?? null,
      user_email: owner ? meta.get(owner.user_id)?.email ?? null : null,
      subject: owner?.subject ?? null,
    };
  });

  return c.json({ messages });
});

// ── POST /unlock — manual unlock (clears users.support_assistant_locked_until)
// The durable users.support_assistant_lockout_count is intentionally NOT reset
// (it drives the graduated cooldown ladder and is meant to survive expiry).
adminMonitoringRoutes.post("/unlock", async (c) => {
  let body: { userId?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  const userId = typeof body.userId === "string" ? body.userId.trim() : "";
  if (!userId) return c.json({ error: "A userId is required" }, 400);

  try {
    await updateByIdChecked(db, "users", userId, {
      support_assistant_locked_until: null,
    });
  } catch (err) {
    if (err instanceof ZeroRowsAffectedError) {
      return c.json({ error: "User not found" }, 404);
    }
    console.error("[admin-monitoring] unlock failed:", err);
    return c.json({ error: "Failed to unlock user" }, 500);
  }

  await writeAuditLog(c, {
    action: "support_assistant_unlock",
    targetType: "user",
    targetId: userId,
    details: { cleared: "support_assistant_locked_until" },
  });

  return c.json({ ok: true });
});
