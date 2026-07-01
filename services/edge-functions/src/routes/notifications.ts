import { Hono } from "hono";
import { supabaseAdmin } from "../lib/supabase.ts";
import { requireJobSecret } from "../lib/job-auth.ts";
import { adminAuthMiddleware } from "../middleware/admin-auth.ts";
import {
  sendDisputeFiledAdminEmail,
  sendDisputeResolvedEmail,
  sendFeedbackEmail,
  sendWelcomeEmail,
} from "../lib/email.ts";
import { captureServer } from "../lib/posthog.ts";
import { emitEvent } from "../lib/user-events.ts";
import { verifyUnsubscribeToken } from "../lib/unsubscribe.ts";
import {
  applyCategoryConsent,
  applyUnsubscribeAll,
  isMarketingCategoryEnabled,
  isMarketingOptedOut,
  PREFERENCE_CENTER_CATEGORIES,
  TRANSACTIONAL_CATEGORY_LABELS,
} from "../lib/email-consent.ts";

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

// ─── No-login marketing consent (US-516 / US-911 / CAN-SPAM) ──────────
//
// These endpoints are intentionally NOT under authMiddleware: commercial email
// must offer an unsubscribe / preference center that works WITHOUT a login. Both
// are HMAC-token gated (lib/unsubscribe.ts) over the user id, so a link can't be
// forged for another recipient.

// Recipient's client IP for the consent audit trail (CF first, then XFF).
function consentClientIp(c: { req: { header: (k: string) => string | undefined } }): string | null {
  const cf = c.req.header("cf-connecting-ip")?.trim();
  if (cf) return cf;
  const first = c.req.header("x-forwarded-for")?.split(",")[0]?.trim();
  return first || null;
}

// US-911 AC6: write an attributable consent-change row so opt-out history is
// traceable. Best-effort — a logging failure never blocks the consent update.
async function recordConsentAudit(input: {
  userId: string;
  email: string | null;
  action: "unsubscribe_all" | "category_update";
  category: string | null;
  enabled: boolean | null;
  source: "unsubscribe_link" | "preference_center";
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  ip: string | null;
  userAgent: string | null;
}): Promise<void> {
  const { error } = await supabaseAdmin.from("email_consent_audit").insert({
    subscriber_user_id: input.userId,
    email: input.email,
    action: input.action,
    category: input.category,
    channel: "email",
    enabled: input.enabled,
    source: input.source,
    before: input.before,
    after: input.after,
    ip: input.ip,
    user_agent: input.userAgent,
  });
  if (error) console.error("[consent-audit] insert failed:", error.message);
}

// Minimal branded HTML shell for the no-login pages.
function consentPage(bodyHtml: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Email preferences · GradeThread</title></head><body style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;max-width:520px;margin:48px auto;padding:0 24px;color:#1A1A2E"><h1 style="font-size:22px;color:#0F3460;text-align:center;margin:0 0 8px">GradeThread</h1>${bodyHtml}</body></html>`;
}

// Load a user's email + notification_preferences (service role).
async function loadConsentUser(
  userId: string,
): Promise<{ email: string | null; prefs: Record<string, unknown> } | null> {
  const { data } = await supabaseAdmin
    .from("users")
    .select("email, notification_preferences")
    .eq("id", userId)
    .maybeSingle();
  if (!data) return null;
  const row = data as { email?: string | null; notification_preferences?: Record<string, unknown> | null };
  return { email: row.email ?? null, prefs: row.notification_preferences ?? {} };
}

// GET /unsubscribe?u=<userId>&t=<token>
// One-click unsubscribe from ALL marketing email. Flips the canonical
// notification_preferences.marketing.email umbrella to false (US-911 AC1) — the
// SAME key every marketing send gate reads — so the opt-out actually suppresses
// broadcasts/drip/newsletter, then writes a consent-audit row.
notificationRoutes.get("/unsubscribe", async (c) => {
  const userId = c.req.query("u") ?? "";
  const token = c.req.query("t") ?? "";
  const html = (msg: string, ok: boolean) =>
    c.html(consentPage(`<p style="font-size:15px;line-height:1.5;text-align:center">${msg}</p>`), ok ? 200 : 400);

  if (!userId || !token || !(await verifyUnsubscribeToken(userId, token))) {
    return html("This unsubscribe link is invalid or has expired.", false);
  }

  const loaded = await loadConsentUser(userId);
  const before = loaded?.prefs ?? {};
  const next = applyUnsubscribeAll(before);

  const { error } = await supabaseAdmin
    .from("users")
    .update({ notification_preferences: next })
    .eq("id", userId);
  if (error) {
    return html("Sorry — we couldn't update your preferences. Please try again.", false);
  }
  await recordConsentAudit({
    userId,
    email: loaded?.email ?? null,
    action: "unsubscribe_all",
    category: null,
    enabled: false,
    source: "unsubscribe_link",
    before,
    after: next,
    ip: consentClientIp(c),
    userAgent: c.req.header("user-agent") ?? null,
  });
  const prefUrl =
    `/api/notifications/preferences?u=${encodeURIComponent(userId)}&t=${encodeURIComponent(token)}`;
  return html(
    `You've been unsubscribed from GradeThread marketing emails. You'll still receive essential account and transaction messages.<br><br><a href="${prefUrl}" style="color:#0F3460">Manage individual email preferences instead →</a>`,
    true,
  );
});

// ─── No-login self-serve preference center (US-911 AC3) ───────────────
//
// GET  /preferences?u=<userId>&t=<token> → renders per-category toggles.
// POST /preferences (form-encoded: u, t, action, plus a checkbox per category)
//      → applies the changes + writes a consent-audit row.
// Transactional categories are shown but NOT suppressible (clearly labeled).

function renderPreferenceForm(
  userId: string,
  token: string,
  prefs: Record<string, unknown>,
  notice: string | null,
): string {
  const noticeHtml = notice
    ? `<p style="background:#E8F5E9;color:#1B5E20;padding:12px 16px;border-radius:8px;font-size:14px;margin:0 0 20px;text-align:center">${notice}</p>`
    : "";
  const masterOff = isMarketingOptedOut(prefs);
  const masterNote = masterOff
    ? `<p style="font-size:13px;color:#E94560;margin:0 0 16px">You're currently unsubscribed from all marketing email. Re-enable a category below to start receiving it again.</p>`
    : "";
  const categoryRows = PREFERENCE_CENTER_CATEGORIES.map((cat) => {
    const enabled = !masterOff && isMarketingCategoryEnabled(prefs, cat.key);
    const checked = enabled ? "checked" : "";
    return `<label style="display:flex;align-items:flex-start;gap:12px;padding:14px 0;border-bottom:1px solid #eee">
        <input type="checkbox" name="cat_${cat.key}" value="1" ${checked} style="margin-top:3px;width:18px;height:18px">
        <span><strong style="font-size:15px">${cat.label}</strong><br><span style="font-size:13px;color:#666">${cat.description}</span></span>
      </label>`;
  }).join("");
  const transactionalRows = TRANSACTIONAL_CATEGORY_LABELS.map(
    (label) =>
      `<li style="font-size:13px;color:#666;margin:0 0 6px;list-style:none">🔒 ${label} <span style="color:#999">— always sent</span></li>`,
  ).join("");
  const u = encodeURIComponent(userId);
  const t = encodeURIComponent(token);
  return consentPage(`
    <p style="font-size:14px;color:#666;text-align:center;margin:0 0 24px">Choose which emails you'd like to receive.</p>
    ${noticeHtml}
    ${masterNote}
    <form method="POST" action="/api/notifications/preferences">
      <input type="hidden" name="u" value="${u}">
      <input type="hidden" name="t" value="${t}">
      <input type="hidden" name="action" value="save">
      <h2 style="font-size:14px;text-transform:uppercase;letter-spacing:.5px;color:#0F3460;margin:0 0 4px">Marketing</h2>
      ${categoryRows}
      <button type="submit" style="margin-top:20px;width:100%;background:#0F3460;color:#fff;border:0;border-radius:8px;padding:14px;font-size:15px;font-weight:600;cursor:pointer">Save preferences</button>
    </form>
    <form method="POST" action="/api/notifications/preferences" style="margin-top:12px">
      <input type="hidden" name="u" value="${u}">
      <input type="hidden" name="t" value="${t}">
      <input type="hidden" name="action" value="unsubscribe_all">
      <button type="submit" style="width:100%;background:transparent;color:#E94560;border:1px solid #E94560;border-radius:8px;padding:12px;font-size:14px;cursor:pointer">Unsubscribe from all marketing email</button>
    </form>
    <h2 style="font-size:14px;text-transform:uppercase;letter-spacing:.5px;color:#0F3460;margin:28px 0 8px">Account &amp; transactional</h2>
    <ul style="margin:0;padding:0">${transactionalRows}</ul>
  `);
}

notificationRoutes.get("/preferences", async (c) => {
  const userId = c.req.query("u") ?? "";
  const token = c.req.query("t") ?? "";
  if (!userId || !token || !(await verifyUnsubscribeToken(userId, token))) {
    return c.html(
      consentPage(`<p style="font-size:15px;text-align:center">This preferences link is invalid or has expired.</p>`),
      400,
    );
  }
  const loaded = await loadConsentUser(userId);
  return c.html(renderPreferenceForm(userId, token, loaded?.prefs ?? {}, null));
});

notificationRoutes.post("/preferences", async (c) => {
  const form = await c.req.parseBody();
  const userId = typeof form.u === "string" ? form.u : "";
  const token = typeof form.t === "string" ? form.t : "";
  const action = typeof form.action === "string" ? form.action : "save";
  if (!userId || !token || !(await verifyUnsubscribeToken(userId, token))) {
    return c.html(
      consentPage(`<p style="font-size:15px;text-align:center">This preferences link is invalid or has expired.</p>`),
      400,
    );
  }

  const loaded = await loadConsentUser(userId);
  const before = loaded?.prefs ?? {};
  const ip = consentClientIp(c);
  const userAgent = c.req.header("user-agent") ?? null;

  if (action === "unsubscribe_all") {
    const next = applyUnsubscribeAll(before);
    const { error } = await supabaseAdmin
      .from("users")
      .update({ notification_preferences: next })
      .eq("id", userId);
    if (error) {
      return c.html(renderPreferenceForm(userId, token, before, "Sorry — couldn't save. Please try again."), 500);
    }
    await recordConsentAudit({
      userId,
      email: loaded?.email ?? null,
      action: "unsubscribe_all",
      category: null,
      enabled: false,
      source: "preference_center",
      before,
      after: next,
      ip,
      userAgent,
    });
    return c.html(renderPreferenceForm(userId, token, next, "You've been unsubscribed from all marketing email."));
  }

  // Save: a checked box (cat_<key>=1) ⇒ enabled. An unchecked box is absent from
  // the POST body ⇒ disabled. Saving re-enables the master umbrella so a
  // previously-unsubscribed recipient who opts a category back on is honored.
  let next: Record<string, unknown> = applyCategoryConsent(before, "marketing", true);
  for (const cat of PREFERENCE_CENTER_CATEGORIES) {
    const enabled = form[`cat_${cat.key}`] === "1";
    next = applyCategoryConsent(next, cat.key, enabled);
  }
  // If the recipient turned EVERY marketing category off, treat it as a full
  // unsubscribe so the umbrella gate suppresses all marketing too.
  const allOff = PREFERENCE_CENTER_CATEGORIES.every((cat) => form[`cat_${cat.key}`] !== "1");
  if (allOff) next = applyUnsubscribeAll(next);

  const { error } = await supabaseAdmin
    .from("users")
    .update({ notification_preferences: next })
    .eq("id", userId);
  if (error) {
    return c.html(renderPreferenceForm(userId, token, before, "Sorry — couldn't save. Please try again."), 500);
  }
  await recordConsentAudit({
    userId,
    email: loaded?.email ?? null,
    action: "category_update",
    category: PREFERENCE_CENTER_CATEGORIES.map((cat) => cat.key).join(","),
    enabled: !allOff,
    source: "preference_center",
    before,
    after: next,
    ip,
    userAgent,
  });
  return c.html(renderPreferenceForm(userId, token, next, "Your email preferences have been saved."));
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
    platform?: unknown;
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
  // Push transport: 'apns' (iOS, default) or 'fcm' (Android). Migration 00320.
  const platform = body.platform === "fcm" ? "fcm" : "apns";

  // US-795: reject an explicit, unrecognized environment instead of silently
  // mis-registering the token under the wrong APNs environment. FCM has no
  // dev/prod gateway split, so an Android token just carries 'production'.
  let environment: "development" | "production";
  if (platform === "fcm") {
    environment = "production";
  } else {
    const parsed = parsePushEnvironment(body.environment);
    if (parsed === "invalid") {
      return c.json({ error: "environment must be 'development' or 'production'" }, 400);
    }
    environment = parsed;
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
    platform,
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

    // US-1433: idempotency guard. The welcome email is now triggered on the
    // first authenticated session for ANY signup method (email OR OAuth), so
    // this endpoint can be called on every sign-in — a user_metadata flag
    // ensures it sends exactly once per account.
    const meta = (authUser.user.user_metadata ?? {}) as Record<string, unknown>;
    if (meta.welcome_email_sent) {
      return c.json({ sent: false, alreadySent: true });
    }

    const fullName = (meta.full_name as string | undefined) || "there";

    const sent = await sendWelcomeEmail(email, {
      userName: fullName,
    });

    // Only set the flag once the send actually succeeded, so a transient email
    // failure retries on the next session rather than silently swallowing the
    // welcome. Preserve existing metadata (e.g. full_name).
    if (sent) {
      const { error: metaError } = await supabaseAdmin.auth.admin.updateUserById(
        userId,
        {
          user_metadata: {
            ...meta,
            welcome_email_sent: true,
            welcome_email_sent_at: new Date().toISOString(),
          },
        },
      );
      if (metaError) {
        // Non-fatal: the email went out. Log so a persistent failure (which
        // could cause a re-send next session) is visible.
        console.error(
          "[Notifications] welcome flag update failed:",
          metaError.message,
        );
      }
    }

    return c.json({ sent });
  } catch (error) {
    console.error("[Notifications] welcome error:", error);
    return c.json({ error: "Failed to send welcome email" }, 500);
  }
});

// ── POST /trial-check (US-219 + US-222) ──────────────────────────
//
// Daily cron. Expires trials whose end date has passed:
//   Find users with trial_ends_at <= now, no Stripe customer, status=trialing
//   → drop to free + clear status.
//
// NOTE: the legacy 3-day-out "trial_expiring" warning pass was removed — the
// autonomous trial-conversion drip engine (US-943, /api/drip/tick) now owns all
// pre-expiry conversion messaging. Keeping the warning here double-mailed every
// trialist, so this job is now downgrade-only.
//
// Gated by FLIPDESK_INTERNAL_JOB_SECRET header (same pattern as other crons).
notificationRoutes.post("/trial-check", async (c) => {
  if (!(await requireJobSecret(c, { bearer: true }))) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const now = new Date();

  // ─ Expire trials whose end date has passed ─
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
    // US-932: internal event stream (drip substrate) — drives the post-trial
    // win-back trigger. Not an activity event, so it does not touch last_active_at.
    void emitEvent(u.id, "trial_expired", {});
  }

  const expiredCount = expired?.length ?? 0;
  console.log(`[trial-check] expired=${expiredCount}`);

  return c.json({
    expired: expiredCount,
  });
});
