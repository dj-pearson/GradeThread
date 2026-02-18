import { Hono } from "hono";
import { supabaseAdmin } from "../lib/supabase.ts";
import {
  sendDisputeResolvedEmail,
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

    // Fetch user email and name
    const { data: user } = await supabaseAdmin
      .from("users")
      .select("email, full_name")
      .eq("id", dispute.user_id)
      .single();

    if (!user?.email) {
      console.warn(`[Notifications] No email found for user ${dispute.user_id}`);
      return c.json({ error: "User email not found" }, 404);
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
