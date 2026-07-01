// GoTrue "Send Email" auth hook (GOTRUE_HOOK_SEND_EMAIL_*). When enabled on the
// self-hosted auth container, GoTrue stops sending auth emails over its own SMTP
// and POSTs here instead, letting us render EVERY auth email (signup-confirm,
// password reset, magic-link, email-change) through the branded emailLayout and
// ship it over the same transactional pipeline as the grade emails.
//
// Each email carries BOTH a confirm link that lands on OUR frontend (never
// api.gradethread.com) AND the 6-digit OTP, so a user can finish verification by
// typing the code if the link ever dead-ends.
//
// Authenticated by the Standard Webhooks signature (AUTH_EMAIL_HOOK_SECRET) —
// this route is intentionally NOT behind authMiddleware (GoTrue has no JWT).
import { Hono } from "hono";
import { type AuthEmailActionType, sendAuthActionEmail } from "../lib/email.ts";
import { captureException, recordMetric } from "../lib/observability.ts";
import {
  parseWebhookSecrets,
  readWebhookHeaders,
  verifyStandardWebhook,
} from "../lib/standard-webhook.ts";

export const authHookRoutes = new Hono();

// The frontend origin (PUBLIC_SITE_URL) confirm links must point at. We use our
// own env, NOT the payload's site_url, so a GoTrue config drift can never send
// the link back to the Supabase host.
const FRONTEND_URL = Deno.env.get("PUBLIC_SITE_URL")?.trim() || "https://gradethread.com";

interface GoTrueEmailData {
  token?: string;
  token_hash?: string;
  token_new?: string;
  token_hash_new?: string;
  redirect_to?: string;
  email_action_type?: string;
  site_url?: string;
  otp_expiry?: number;
}

interface GoTrueSendEmailPayload {
  user?: { id?: string; email?: string; new_email?: string };
  email_data?: GoTrueEmailData;
}

// Map GoTrue's email_action_type → our branded template action + the verifyOtp
// `type` the frontend uses. Returns null for action types we don't template.
function mapAction(
  raw: string | undefined,
): { action: AuthEmailActionType; verifyType: string } | null {
  switch (raw) {
    case "signup":
    case "confirmation":
      return { action: "signup", verifyType: "signup" };
    case "magiclink":
      return { action: "magiclink", verifyType: "magiclink" };
    case "recovery":
      return { action: "recovery", verifyType: "recovery" };
    case "invite":
      return { action: "invite", verifyType: "invite" };
    case "email_change":
    case "email_change_current":
    case "email_change_new":
      return { action: "email_change", verifyType: "email_change" };
    case "reauthentication":
      return { action: "reauthentication", verifyType: "reauthentication" };
    default:
      return null;
  }
}

// Where each action's confirm link lands on our frontend. recovery reuses the
// existing reset-password page (it collects the new password); everything else
// goes to the generic /auth/confirm verifier.
function frontendPathFor(action: AuthEmailActionType): string {
  return action === "recovery" ? "/auth/reset-password" : "/auth/confirm";
}

authHookRoutes.post("/send-email", async (c) => {
  const secrets = parseWebhookSecrets(Deno.env.get("AUTH_EMAIL_HOOK_SECRET"));
  if (!secrets.length) {
    // Fail loudly rather than accept unauthenticated mail requests.
    console.error(
      "[auth-hook] AUTH_EMAIL_HOOK_SECRET not set — rejecting send-email hook",
    );
    return c.json({ error: { message: "hook not configured" } }, 500);
  }

  const raw = await c.req.text();
  const verified = await verifyStandardWebhook({
    body: raw,
    headers: readWebhookHeaders(c.req.raw.headers),
    secrets,
  });
  if (!verified) {
    recordMetric("auth_hook.bad_signature", 1);
    return c.json({ error: { message: "invalid signature" } }, 401);
  }

  let payload: GoTrueSendEmailPayload;
  try {
    payload = JSON.parse(raw);
  } catch {
    return c.json({ error: { message: "invalid payload" } }, 400);
  }

  const emailData = payload.email_data ?? {};
  const mapped = mapAction(emailData.email_action_type);
  if (!mapped) {
    // Nothing to template — return 200 so GoTrue doesn't fail the auth flow over
    // an action type we don't handle.
    console.warn(
      `[auth-hook] unsupported email_action_type: ${emailData.email_action_type}`,
    );
    return c.json({});
  }

  // For the confirmation sent to the NEW address of an email change, GoTrue
  // supplies the *_new token pair + user.new_email — use those so the code/link
  // match the address being confirmed.
  const isNewEmail = emailData.email_action_type === "email_change_new";
  const otp = (isNewEmail ? emailData.token_new : emailData.token) || emailData.token || "";
  const tokenHash = (isNewEmail ? emailData.token_hash_new : emailData.token_hash) ||
    emailData.token_hash || "";
  const recipient = (isNewEmail ? payload.user?.new_email : payload.user?.email) ||
    payload.user?.email || "";

  if (!recipient) {
    return c.json({ error: { message: "no recipient" } }, 400);
  }

  // Build the confirm link on OUR frontend carrying token_hash (server-verified
  // client-side via supabase.auth.verifyOtp) — never the Supabase host.
  let confirmUrl: string | null = null;
  if (tokenHash && mapped.action !== "reauthentication") {
    const base = FRONTEND_URL.replace(/\/+$/, "");
    const params = new URLSearchParams({
      token_hash: tokenHash,
      type: mapped.verifyType,
    });
    // Preserve GoTrue's intended post-verify redirect for the confirm screen.
    if (emailData.redirect_to) params.set("redirect_to", emailData.redirect_to);
    confirmUrl = `${base}${frontendPathFor(mapped.action)}?${params.toString()}`;
  }

  const expiresInMinutes = emailData.otp_expiry
    ? Math.round(emailData.otp_expiry / 60)
    : undefined;

  try {
    const sent = await sendAuthActionEmail(recipient, {
      actionType: mapped.action,
      otp,
      confirmUrl,
      expiresInMinutes,
    });
    recordMetric(sent ? "auth_hook.sent" : "auth_hook.enqueued", 1, {
      action: mapped.action,
    });
    // 200 either way: on a transient failure sendAuthActionEmail already
    // enqueued the (still-valid) email for durable retry, and returning an error
    // here would fail the user's signup/login outright.
    return c.json({});
  } catch (err) {
    captureException(err, {
      route: "auth-hook.send-email",
      tags: { action: mapped.action },
    });
    return c.json({ error: { message: "failed to send" } }, 500);
  }
});
