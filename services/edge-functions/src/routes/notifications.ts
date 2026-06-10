import { Hono } from "hono";
import { supabaseAdmin } from "../lib/supabase.ts";
import { requireJobSecret } from "../lib/job-auth.ts";
import { adminAuthMiddleware } from "../middleware/admin-auth.ts";
import {
  sendDisputeFiledAdminEmail,
  sendDisputeResolvedEmail,
  sendFeedbackEmail,
  sendTrialExpiringEmail,
  sendWelcomeEmail,
} from "../lib/email.ts";
import { captureServer } from "../lib/posthog.ts";
import { verifyUnsubscribeToken } from "../lib/unsubscribe.ts";

// Insert an in-app notification (service role bypasses RLS). Best-effort.
async function notifyInApp(
  userId: string,
  type: "grade_complete" | "dispute_update" | "billing" | "system",
  title: string,
  message: string,
  link: string | null,
): Promise<void> {
  const { error } = await supabaseAdmin
    .from("notifications")
    .insert({ user_id: userId, type, title, message, link });
  if (error) console.error("[Notifications] in-app insert failed:", error.message);
}

type NotifEnv = { Variables: { userId?: string } };

export const notificationRoutes = new Hono<NotifEnv>();

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

// ─── No-login marketing unsubscribe (US-516 / CAN-SPAM) ──────────────
//
// GET /unsubscribe?u=<userId>&t=<token>
// Honors a one-click unsubscribe from marketing email WITHOUT a login. The
// token is an HMAC over the user id (lib/unsubscribe.ts) so it can't be forged
// for another user. Flips notification_preferences.product_updates.email to
// false. Returns a tiny HTML confirmation (rendered in the browser). This path
// is intentionally NOT under authMiddleware.
notificationRoutes.get("/unsubscribe", async (c) => {
  const userId = c.req.query("u") ?? "";
  const token = c.req.query("t") ?? "";
  const html = (msg: string, ok: boolean) =>
    c.html(
      `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Email preferences</title></head><body style="font-family:system-ui,sans-serif;max-width:480px;margin:64px auto;padding:0 24px;text-align:center;color:#1A1A2E"><h1 style="font-size:20px;color:#0F3460">GradeThread</h1><p style="font-size:15px;line-height:1.5">${msg}</p></body></html>`,
      ok ? 200 : 400,
    );

  if (!userId || !token || !(await verifyUnsubscribeToken(userId, token))) {
    return html("This unsubscribe link is invalid or has expired.", false);
  }

  // Merge product_updates.email = false into the JSONB preferences.
  const { data: row } = await supabaseAdmin
    .from("users")
    .select("notification_preferences")
    .eq("id", userId)
    .maybeSingle();
  const prefs =
    (row as { notification_preferences?: Record<string, unknown> } | null)
      ?.notification_preferences ?? {};
  const product = (prefs.product_updates as Record<string, unknown>) ?? {};
  const next = { ...prefs, product_updates: { ...product, email: false } };

  const { error } = await supabaseAdmin
    .from("users")
    .update({ notification_preferences: next })
    .eq("id", userId);
  if (error) {
    return html("Sorry — we couldn't update your preferences. Please try again.", false);
  }
  return html(
    "You've been unsubscribed from GradeThread marketing emails. You'll still receive essential account and transaction messages.",
    true,
  );
});

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

  // US-801: route to support via the email infra (categorized → durable retry
  // from the outbox). Don't block or fail the request on it — the row is the
  // system-of-record copy.
  const supportEmail =
    Deno.env.get("FEEDBACK_ALERT_EMAIL") ||
    Deno.env.get("SUPPORT_EMAIL") ||
    Deno.env.get("SMTP_ADMIN_EMAIL") ||
    "";
  const userRow = user as { email?: string; full_name?: string | null } | null;
  if (supportEmail) {
    void sendFeedbackEmail(supportEmail, {
      userEmail: userRow?.email ?? "unknown",
      userName: userRow?.full_name ?? null,
      message: cappedMessage,
      source: insertPayload.source,
      appVersion: insertPayload.app_version,
      osVersion: insertPayload.os_version,
      deviceModel: insertPayload.device_model,
    }).catch((err) => console.error("[feedback] support email failed:", err));
  } else {
    console.info("[feedback] new message (no support email configured)", {
      id: (inserted as { id: string } | null)?.id ?? null,
      user_email: userRow?.email ?? "unknown",
      source: insertPayload.source,
      length: insertPayload.message.length,
    });
  }

  return c.json({
    ok: true,
    id: (inserted as { id: string } | null)?.id ?? null,
  });
});

// ─── iOS push registration (US-187) ──────────────────────────────────
//
// US-795: APNs environment must be exactly one of the two valid values. An
// unknown value used to be silently coerced to "development" (so a prod device
// token registered as dev would never receive pushes). Now: absent → default
// "development" (back-compat); present-but-invalid → "invalid" (the route 400s).
export function parsePushEnvironment(
  raw: unknown,
): "development" | "production" | "invalid" {
  if (raw === undefined || raw === null) return "development";
  if (raw === "development" || raw === "production") return raw;
  return "invalid";
}

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
  if (!deviceToken || deviceToken.length < 32) {
    return c.json({ error: "device_token is required" }, 400);
  }
  // US-795: reject an explicit, unrecognized environment instead of silently
  // mis-registering the token under the wrong APNs environment.
  const environment = parsePushEnvironment(body.environment);
  if (environment === "invalid") {
    return c.json({ error: "environment must be 'development' or 'production'" }, 400);
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

// DELETE /register
// Body: { device_token: string }
//
// US-795: removes the caller's device-token row. iOS calls this on sign-out (so
// a shared device stops receiving the previous user's pushes) and before
// registering a replacement token. Tenant-scoped to the authed user — a caller
// can only ever delete their OWN token. Idempotent: deleting an unknown token is
// a no-op success.
notificationRoutes.delete("/register", async (c) => {
  const userId = c.get("userId") as string | undefined;
  if (!userId) {
    return c.json({ error: "Sign-in required" }, 401);
  }

  let body: { device_token?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  const deviceToken =
    typeof body.device_token === "string" ? body.device_token.trim() : "";
  if (!deviceToken) {
    return c.json({ error: "device_token is required" }, 400);
  }

  await supabaseAdmin
    .from("push_device_tokens")
    .delete()
    .eq("user_id", userId)
    .eq("device_token", deviceToken);

  return c.json({ ok: true });
});

/**
 * POST /dispute-filed
 * Called by the submitter's frontend right after they file a dispute, so the
 * platform admin is alerted (email + in-app) to review it. Authenticated (the
 * route-group authMiddleware sets userId). We only act on a freshly-OPEN
 * dispute, and the response carries no dispute data — so it can't be used to
 * probe other users' disputes.
 */
notificationRoutes.post("/dispute-filed", async (c) => {
  const userId = c.get("userId") as string | undefined;
  if (!userId) return c.json({ error: "Sign-in required" }, 401);

  let body: { disputeId?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  const disputeId = body.disputeId;
  if (!disputeId) return c.json({ error: "disputeId is required" }, 400);

  try {
    const { data: dispute } = await supabaseAdmin
      .from("disputes")
      .select("id, status, reason, user_id, grade_report_id")
      .eq("id", disputeId)
      .single();
    if (!dispute) return c.json({ error: "Dispute not found" }, 404);
    // Only alert on a just-filed dispute (idempotent + not abusable on old ones).
    if (dispute.status !== "open") return c.json({ ok: true, skipped: "not open" });

    // Resolve the submission title + submitter name for the alert.
    const { data: report } = await supabaseAdmin
      .from("grade_reports")
      .select("submission_id")
      .eq("id", dispute.grade_report_id)
      .single();
    let submissionTitle = "a graded submission";
    if (report?.submission_id) {
      const { data: submission } = await supabaseAdmin
        .from("submissions")
        .select("title")
        .eq("id", report.submission_id)
        .single();
      if (submission?.title) submissionTitle = submission.title;
    }
    const { data: submitter } = await supabaseAdmin
      .from("users")
      .select("full_name, email")
      .eq("id", dispute.user_id)
      .single();
    const submitterName = submitter?.full_name || submitter?.email || "A user";

    // Email the platform admin.
    const adminEmail =
      Deno.env.get("DISPUTE_ALERT_EMAIL") || Deno.env.get("SMTP_ADMIN_EMAIL") || "";
    let emailed = false;
    if (adminEmail) {
      emailed = await sendDisputeFiledAdminEmail(adminEmail, {
        submitterName,
        submissionTitle,
        reason: dispute.reason,
        submissionId: report?.submission_id ?? "",
      });
    }

    // In-app notify every admin / super_admin.
    const { data: admins } = await supabaseAdmin
      .from("users")
      .select("id")
      .in("role", ["admin", "super_admin"]);
    for (const a of admins ?? []) {
      await notifyInApp(
        a.id,
        "system",
        "New grade dispute filed",
        `${submitterName} disputed the grade for "${submissionTitle}".`,
        "/admin/disputes",
      );
    }

    return c.json({ ok: true, emailed, admins_notified: (admins ?? []).length });
  } catch (error) {
    console.error("[Notifications] dispute-filed error:", error);
    return c.json({ error: "Failed to send notification" }, 500);
  }
});

/**
 * POST /dispute-status
 * Called by the admin frontend after a dispute transitions to under_review,
 * resolved, or rejected. In-app notifies the submitter on every transition and
 * emails them on resolved/rejected (respecting their preferences).
 *
 * Admin-only: it touches the dispute owner's notifications, so any authenticated
 * user must NOT trigger it. adminAuthMiddleware runs after the route-group
 * authMiddleware (main.ts) so c.var.userId is already set.
 */
notificationRoutes.post("/dispute-status", adminAuthMiddleware, async (c) => {
  const { disputeId } = await c.req.json<{ disputeId: string }>();
  if (!disputeId) {
    return c.json({ error: "disputeId is required" }, 400);
  }

  try {
    const { data: dispute, error: disputeError } = await supabaseAdmin
      .from("disputes")
      .select("id, status, resolution_notes, user_id, grade_report_id")
      .eq("id", disputeId)
      .single();

    if (disputeError || !dispute) {
      return c.json({ error: "Dispute not found" }, 404);
    }

    const status = dispute.status as string;
    if (!["under_review", "resolved", "rejected"].includes(status)) {
      return c.json({ error: "Unsupported dispute status" }, 400);
    }

    const { data: user } = await supabaseAdmin
      .from("users")
      .select("email, full_name, notification_preferences")
      .eq("id", dispute.user_id)
      .single();

    // Resolve submission title + id for the link/message.
    const { data: report } = await supabaseAdmin
      .from("grade_reports")
      .select("overall_score, submission_id")
      .eq("id", dispute.grade_report_id)
      .single();
    const submissionId = report?.submission_id;
    let submissionTitle = "your submission";
    if (submissionId) {
      const { data: submission } = await supabaseAdmin
        .from("submissions")
        .select("title")
        .eq("id", submissionId)
        .single();
      if (submission?.title) submissionTitle = submission.title;
    }
    const link = submissionId ? `/dashboard/submissions/${submissionId}` : "/dashboard/submissions";

    // In-app notification on every transition.
    const title =
      status === "under_review"
        ? "Your dispute is under review"
        : status === "resolved"
          ? "Your dispute was resolved"
          : "Your dispute was reviewed";
    const message =
      status === "under_review"
        ? `We're reviewing your dispute for "${submissionTitle}".`
        : status === "resolved"
          ? `Your dispute for "${submissionTitle}" was resolved. Open it to see the outcome.`
          : `Your dispute for "${submissionTitle}" was reviewed and the original grade stands.`;
    await notifyInApp(dispute.user_id, "dispute_update", title, message, link);

    // Email only on resolved/rejected, respecting the user's preference.
    let emailed = false;
    const emailOptedOut =
      user?.notification_preferences?.dispute_updates?.email === false;
    if ((status === "resolved" || status === "rejected") && user?.email && !emailOptedOut) {
      emailed = await sendDisputeResolvedEmail(user.email, {
        userName: user.full_name || "there",
        submissionTitle,
        outcome: status as "resolved" | "rejected",
        resolutionNotes: dispute.resolution_notes,
        originalScore: report?.overall_score ?? 0,
        newScore: status === "resolved" ? (report?.overall_score ?? null) : null,
        submissionId: submissionId || "",
      });
    }

    return c.json({ ok: true, notified: true, emailed });
  } catch (error) {
    console.error("[Notifications] dispute-status error:", error);
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
  if (!(await requireJobSecret(c, { bearer: true }))) {
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
        userId: u.id, // US-516: enables the no-login marketing unsubscribe link
      }).catch((err) => {
        console.error(`[trial-check] email failed for ${u.id}:`, err);
      });
      void captureServer(u.id, "trial.expiring_3d", { days_left: daysLeft });
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

  for (const u of expired ?? []) {
    void captureServer(u.id, "trial.expired_to_free", {});
  }

  const expiredCount = expired?.length ?? 0;
  console.log(`[trial-check] warned=${warned} expired=${expiredCount}`);

  return c.json({
    warned,
    expired: expiredCount,
  });
});
