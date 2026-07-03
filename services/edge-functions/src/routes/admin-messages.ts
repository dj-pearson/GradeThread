import { Hono } from "hono";
import type { Context } from "hono";
import { supabaseAdmin } from "../lib/supabase.ts";
import { failSafe } from "../lib/http-errors.ts";
import { writeAuditLog } from "../lib/audit-log.ts";
import { sendAdminMessageEmail } from "../lib/email.ts";
import { requireScope } from "../lib/scope-guard.ts";

// Ad-hoc admin → customer messaging (US-582). Lets an operator send a
// transactional support / account email to a specific user from the admin app,
// without an external tool. Mounted at /api/admin/messages — inherits
// authMiddleware + adminAuthMiddleware (admin/super_admin + AAL2) from main.ts,
// and a per-admin rate limit (also in main.ts).
//
// CAN-SPAM: this path is for TRANSACTIONAL support/account comms ONLY. The
// rendered email therefore omits a marketing unsubscribe link (you can't opt
// out of service mail about your own account) but always carries the postal
// address. Do NOT wire marketing/campaign sends through here — those go through
// the broadcast engine (US-627), which respects opt-out + unsubscribe.

type AdminEnv = {
  Variables: {
    userId: string;
    adminRole: "admin" | "super_admin";
  };
};

export const adminMessagesRoutes = new Hono<AdminEnv>();

// US-1560: whole-router scope guard (see lib/admin-scope-map.ts).
adminMessagesRoutes.use("*", requireScope("support:write"));

const SUBJECT_MAX = 200;
const BODY_MAX = 5000;
const CTA_LABEL_MAX = 60;

// Canned transactional templates an operator can start from (then edit before
// sending). Kept server-side so the audit log can record which template seeded a
// send. The client mirrors these for the picker; an unknown/blank id is fine —
// the route only ever sends the subject/body it receives.
interface MessageTemplate {
  id: string;
  label: string;
  subject: string;
  body: string;
}

const TEMPLATES: MessageTemplate[] = [
  {
    id: "support_followup",
    label: "Support follow-up",
    subject: "Following up on your GradeThread support request",
    body:
      "Thanks for reaching out to GradeThread support.\n\n" +
      "[Write your response here.]\n\n" +
      "If there's anything else we can help with, just reply to this email.",
  },
  {
    id: "payment_reminder",
    label: "Payment / billing notice",
    subject: "Action needed on your GradeThread account",
    body:
      "We noticed an issue with the most recent payment on your account.\n\n" +
      "[Describe the billing issue and the action needed.]\n\n" +
      "You can update your billing details from the Billing page in your dashboard.",
  },
  {
    id: "account_notice",
    label: "Account notice",
    subject: "An update about your GradeThread account",
    body:
      "We're reaching out with an important update about your account.\n\n" +
      "[Write the account notice here.]",
  },
];

// GET /templates — canned starting points for the compose UI.
// US-1564 wire decision: WIRED — user-detail compose loads these (replaced its
// hand-mirrored copy; the server list is now the single source of truth).
adminMessagesRoutes.get("/templates", (c: Context<AdminEnv>) => {
  return c.json({ templates: TEMPLATES });
});

// POST /:userId — send a transactional message to a specific user.
adminMessagesRoutes.post("/:userId", async (c: Context<AdminEnv>) => {
  const targetId = c.req.param("userId");

  const body = await c.req.json().catch(() => ({}));
  const subject = typeof body.subject === "string" ? body.subject.trim() : "";
  const messageBody = typeof body.body === "string" ? body.body.trim() : "";
  const templateId = typeof body.templateId === "string" ? body.templateId : null;
  const ctaLabel =
    typeof body.ctaLabel === "string" && body.ctaLabel.trim()
      ? body.ctaLabel.trim().slice(0, CTA_LABEL_MAX)
      : null;
  const ctaUrlRaw = typeof body.ctaUrl === "string" ? body.ctaUrl.trim() : "";

  if (!subject || subject.length > SUBJECT_MAX) {
    return c.json({ error: `Subject is required (max ${SUBJECT_MAX} chars).` }, 400);
  }
  if (!messageBody || messageBody.length > BODY_MAX) {
    return c.json({ error: `Message body is required (max ${BODY_MAX} chars).` }, 400);
  }

  // CTA is optional, but if a URL is supplied it must be a safe absolute http(s)
  // link and paired with a label.
  let ctaUrl: string | null = null;
  if (ctaUrlRaw) {
    try {
      const u = new URL(ctaUrlRaw);
      if (u.protocol !== "http:" && u.protocol !== "https:") {
        return c.json({ error: "Call-to-action URL must be http(s)." }, 400);
      }
      ctaUrl = u.toString();
    } catch {
      return c.json({ error: "Call-to-action URL is invalid." }, 400);
    }
  }
  if (ctaUrl && !ctaLabel) {
    return c.json({ error: "A call-to-action link needs a button label." }, 400);
  }

  // Resolve the recipient. Service-role read scoped to this id only.
  const { data: target, error: lookupErr } = await supabaseAdmin
    .from("users")
    .select("id, email, full_name")
    .eq("id", targetId)
    .maybeSingle();
  if (lookupErr) return failSafe(c, 500, "Couldn't look up the user.", lookupErr, "admin.messages.lookup");
  const recipient = target as { id: string; email: string; full_name: string | null } | null;
  if (!recipient) return c.json({ error: "User not found" }, 404);

  const sent = await sendAdminMessageEmail(recipient.email, {
    userName: recipient.full_name || recipient.email,
    subject,
    body: messageBody,
    ctaLabel,
    ctaUrl,
  });

  // Record the send against the user even if SMTP failed (sendAdminMessageEmail
  // enqueues a failed critical email for durable retry via the "admin_message"
  // category) so the operator has a trail and the user has an in-app copy.
  const { error: notifErr } = await supabaseAdmin.from("notifications").insert({
    user_id: recipient.id,
    type: "system",
    title: subject,
    message: messageBody.length > 500 ? `${messageBody.slice(0, 497)}…` : messageBody,
    link: ctaUrl,
  });
  if (notifErr) {
    console.error("[admin-messages] in-app notification insert failed:", notifErr.message);
  }

  await writeAuditLog(c, {
    action: "admin.send_message",
    targetType: "user",
    targetId: recipient.id,
    details: {
      recipient_email: recipient.email,
      subject,
      body_length: messageBody.length,
      template_id: templateId,
      had_cta: ctaUrl !== null,
      email_accepted: sent,
    },
  });

  if (!sent) {
    // SMTP rejected the live attempt; it's queued for retry. Tell the operator so
    // they don't assume instant delivery, but the message is recorded + will retry.
    return c.json(
      {
        ok: true,
        delivered: false,
        message: "Message recorded and queued for retry (mail server did not accept it immediately).",
      },
      202,
    );
  }

  return c.json({ ok: true, delivered: true });
});
