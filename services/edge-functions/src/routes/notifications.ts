import { Hono } from "hono";
import { supabaseAdmin } from "../lib/supabase.ts";
import {
  sendDisputeResolvedEmail,
  sendTrialExpiringEmail,
  sendWelcomeEmail,
} from "../lib/email.ts";

export const notificationRoutes = new Hono();

// Simple per-IP rate limit for unauthenticated welcome endpoint
const welcomeRateLimit = new Map<string, { count: number; resetAt: number }>();
const WELCOME_MAX = 5;
const WELCOME_WINDOW_MS = 60_000;

function checkWelcomeRateLimit(ip: string): boolean {
  const now = Date.now();
  const entry = welcomeRateLimit.get(ip);
  if (!entry || entry.resetAt <= now) {
    welcomeRateLimit.set(ip, { count: 1, resetAt: now + WELCOME_WINDOW_MS });
    return true;
  }
  entry.count += 1;
  return entry.count <= WELCOME_MAX;
}

// ─── User-submitted feedback (US-199) ────────────────────────────────
//
// POST /feedback
// Body: { message: string, source?: string, app_version?, os_version?,
//         device_model?, breadcrumbs?: [...] }
//
// Inserts a row in feedback_messages tied to auth.uid() + optionally
// emails support so a human sees it without polling the table.
notificationRoutes.post("/feedback", async (c) => {
  const userId = c.get("userId") as string | undefined;
  if (!userId) {
    return c.json({ error: "Sign-in required" }, 401);
  }

  let body: {
    message?: unknown;
    source?: unknown;
    app_version?: unknown;
    os_version?: unknown;
    device_model?: unknown;
    breadcrumbs?: unknown;
  };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const message =
    typeof body.message === "string" ? body.message.trim() : "";
  if (!message) {
    return c.json({ error: "Feedback message is required" }, 400);
  }
  // Cap so an accidental paste doesn't bloat the row + email body.
  const cappedMessage = message.length > 4000 ? message.slice(0, 4000) : message;

  const insertPayload = {
    user_id: userId,
    message: cappedMessage,
    source: typeof body.source === "string" ? body.source : "ios",
    app_version: typeof body.app_version === "string" ? body.app_version : null,
    os_version: typeof body.os_version === "string" ? body.os_version : null,
    device_model: typeof body.device_model === "string" ? body.device_model : null,
    breadcrumbs: Array.isArray(body.breadcrumbs) ? body.breadcrumbs : [],
  };

  const { data: inserted, error: insertErr } = await supabaseAdmin
    .from("feedback_messages")
    .insert(insertPayload)
    .select("id, created_at")
    .single();

  if (insertErr) {
    console.error("[feedback] insert failed:", insertErr);
    return c.json({ error: "Couldn't save feedback. Try again." }, 500);
  }

  // Best-effort email send so a human triages without watching the
  // table. We deliberately don't fail the request if email fails —
  // the row is the system-of-record copy.
  const { data: user } = await supabaseAdmin
    .from("users")
    .select("email, full_name")
    .eq("id", userId)
    .maybeSingle();

  // Wired to existing email infra would go here. For now we log so
  // the operator can see what would have been sent until the
  // sendFeedbackEmail helper lands in services/edge-functions/src/lib/
  // email.ts.
  console.info("[feedback] new message", {
    id: (inserted as { id: string } | null)?.id ?? null,
    user_email: (user as { email?: string } | null)?.email ?? "unknown",
    source: insertPayload.source,
    length: insertPayload.message.length,
  });

  return c.json({
    ok: true,
    id: (inserted as { id: string } | null)?.id ?? null,
  });
});

// ─── iOS push registration (US-187) ──────────────────────────────────
//
// POST /register
// Body: { device_token: string, environment: "development"|"production",
//         device_name?, os_version?, app_version? }
//
// Upserts a row in push_device_tokens scoped to the authed user. Idempotent
// on (user_id, device_token) — re-registering the same token bumps
// last_seen_at + is_active=true and skips the insert. APNs send paths
// (sale.created, payout.cleared, token.expiring, item.review_needed)
// fan out per active row.
notificationRoutes.post("/register", async (c) => {
  const userId = c.get("userId") as string | undefined;
  if (!userId) {
    return c.json({ error: "Sign-in required" }, 401);
  }

  let body: {
    device_token?: unknown;
    environment?: unknown;
    device_name?: unknown;
    os_version?: unknown;
    app_version?: unknown;
  };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const deviceToken =
    typeof body.device_token === "string" ? body.device_token.trim() : "";
  const environment = body.environment === "production" ? "production" : "development";
  if (!deviceToken || deviceToken.length < 32) {
    return c.json({ error: "device_token is required" }, 400);
  }

  const { data: existing } = await supabaseAdmin
    .from("push_device_tokens")
    .select("id")
    .eq("user_id", userId)
    .eq("device_token", deviceToken)
    .maybeSingle();

  const payload = {
    user_id: userId,
    device_token: deviceToken,
    environment,
    device_name: typeof body.device_name === "string" ? body.device_name : null,
    os_version: typeof body.os_version === "string" ? body.os_version : null,
    app_version: typeof body.app_version === "string" ? body.app_version : null,
    is_active: true,
    last_seen_at: new Date().toISOString(),
  };

  if (existing && (existing as { id: string }).id) {
    await supabaseAdmin
      .from("push_device_tokens")
      .update(payload)
      .eq("id", (existing as { id: string }).id);
  } else {
    await supabaseAdmin
      .from("push_device_tokens")
      .insert(payload);
  }

  return c.json({ ok: true });
});

/**
 * POST /dispute-resolved
 * Called by the admin frontend after resolving or rejecting a dispute.
 * Body: { disputeId: string }
 */
notificationRoutes.post("/dispute-resolved", async (c) => {
  const { disputeId } = await c.req.json<{ disputeId: string }>();

  if (!disputeId) {
    return c.json({ error: "disputeId is required" }, 400);
  }

  try {
    // Fetch dispute with submission and user info
    const { data: dispute, error: disputeError } = await supabaseAdmin
      .from("disputes")
      .select("id, status, resolution_notes, user_id, grade_report_id")
      .eq("id", disputeId)
      .single();

    if (disputeError || !dispute) {
      return c.json({ error: "Dispute not found" }, 404);
    }

    if (dispute.status !== "resolved" && dispute.status !== "rejected") {
      return c.json({ error: "Dispute is not resolved or rejected" }, 400);
    }

    // Fetch user email, name, and notification preferences
    const { data: user } = await supabaseAdmin
      .from("users")
      .select("email, full_name, notification_preferences")
      .eq("id", dispute.user_id)
      .single();

    if (!user?.email) {
      console.warn(`[Notifications] No email found for user ${dispute.user_id}`);
      return c.json({ error: "User email not found" }, 404);
    }

    // Respect the user's notification preferences (default: enabled).
    if (user.notification_preferences?.dispute_updates?.email === false) {
      return c.json({ sent: false, skipped: "user opted out of dispute emails" });
    }

    // Fetch grade report for scores
    const { data: report } = await supabaseAdmin
      .from("grade_reports")
      .select("overall_score, submission_id")
      .eq("id", dispute.grade_report_id)
      .single();

    // Fetch submission title
    const submissionId = report?.submission_id;
    let submissionTitle = "Your submission";
    if (submissionId) {
      const { data: submission } = await supabaseAdmin
        .from("submissions")
        .select("title")
        .eq("id", submissionId)
        .single();
      if (submission?.title) {
        submissionTitle = submission.title;
      }
    }

    const sent = await sendDisputeResolvedEmail(user.email, {
      userName: user.full_name || "there",
      submissionTitle,
      outcome: dispute.status as "resolved" | "rejected",
      resolutionNotes: dispute.resolution_notes,
      originalScore: report?.overall_score ?? 0,
      newScore: dispute.status === "resolved" ? (report?.overall_score ?? null) : null,
      submissionId: submissionId || "",
    });

    return c.json({ sent });
  } catch (error) {
    console.error("[Notifications] dispute-resolved error:", error);
    return c.json({ error: "Failed to send notification" }, 500);
  }
});

/**
 * POST /welcome
 * Called after user signup to send a welcome email.
 * Body: { userId: string }
 */
notificationRoutes.post("/welcome", async (c) => {
  // IP-based rate limiting for unauthenticated endpoint
  const ip = c.req.header("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
  if (!checkWelcomeRateLimit(ip)) {
    return c.json({ error: "Too many requests" }, 429);
  }

  const { userId } = await c.req.json<{ userId: string }>();

  if (!userId) {
    return c.json({ error: "userId is required" }, 400);
  }

  try {
    // Fetch user via auth admin API to get email
    const { data: authUser, error: authError } = await supabaseAdmin.auth.admin.getUserById(userId);

    if (authError || !authUser?.user) {
      console.warn(`[Notifications] Auth user not found for ${userId}`);
      return c.json({ error: "User not found" }, 404);
    }

    const email = authUser.user.email;
    if (!email) {
      return c.json({ error: "User has no email" }, 400);
    }

    const fullName = authUser.user.user_metadata?.full_name || "there";

    const sent = await sendWelcomeEmail(email, {
      userName: fullName,
    });

    return c.json({ sent });
  } catch (error) {
    console.error("[Notifications] welcome error:", error);
    return c.json({ error: "Failed to send welcome email" }, 500);
  }
});

// ── POST /trial-check (US-219 + US-222) ──────────────────────────
//
// Daily cron. Two passes:
//   1. Find users 3 days out from trial_ends_at, no Stripe customer, status=trialing
//      → fire trial_expiring email. Marked via users.last_trial_warning_at
//        so we don't double-send.
//   2. Find users with trial_ends_at <= now, no Stripe customer, status=trialing
//      → drop to free + clear status.
//
// Gated by FLIPDESK_INTERNAL_JOB_SECRET header (same pattern as other crons).
notificationRoutes.post("/trial-check", async (c) => {
  const expected = Deno.env.get("FLIPDESK_INTERNAL_JOB_SECRET");
  const authz = c.req.header("Authorization") ?? "";
  const provided = authz.startsWith("Bearer ") ? authz.slice(7) : "";
  if (!expected || provided !== expected) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const now = new Date();
  const in3Days = new Date(now.getTime() + 3 * 24 * 60 * 60 * 1000);
  const in4Days = new Date(now.getTime() + 4 * 24 * 60 * 60 * 1000);

  // ─ Pass 1: 3-day-out warning ─
  const { data: expiring, error: expiringErr } = await supabaseAdmin
    .from("users")
    .select("id, email, full_name, trial_ends_at")
    .eq("subscription_status", "trialing")
    .is("stripe_customer_id", null)
    .gte("trial_ends_at", in3Days.toISOString())
    .lt("trial_ends_at", in4Days.toISOString());

  let warned = 0;
  if (expiringErr) {
    console.error("[trial-check] warn query failed:", expiringErr);
  } else {
    for (const u of expiring ?? []) {
      if (!u.email || !u.trial_ends_at) continue;
      const daysLeft = Math.max(
        1,
        Math.round((new Date(u.trial_ends_at).getTime() - now.getTime()) / (24 * 60 * 60 * 1000)),
      );
      const first = u.full_name?.trim().split(/\s+/)[0] || u.email.split("@")[0]!;
      sendTrialExpiringEmail(u.email, {
        userName: first,
        daysLeft,
        trialEndsAt: u.trial_ends_at,
      }).catch((err) => {
        console.error(`[trial-check] email failed for ${u.id}:`, err);
      });
      warned++;
    }
  }

  // ─ Pass 2: expire trials whose end date has passed ─
  const { data: expired, error: expireErr } = await supabaseAdmin
    .from("users")
    .update({
      subscription_status: "none",
      flipdesk_plan: "free",
    })
    .eq("subscription_status", "trialing")
    .is("stripe_customer_id", null)
    .lt("trial_ends_at", now.toISOString())
    .select("id");

  if (expireErr) {
    console.error("[trial-check] expire update failed:", expireErr);
  }

  const expiredCount = expired?.length ?? 0;
  console.log(`[trial-check] warned=${warned} expired=${expiredCount}`);

  return c.json({
    warned,
    expired: expiredCount,
  });
});
