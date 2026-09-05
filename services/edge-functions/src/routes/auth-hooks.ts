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
import { captureException, logEvent, recordMetric } from "../lib/observability.ts";
import { supabaseAdmin } from "../lib/supabase.ts";
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

  // US-2351 AC7. GoTrue hands us its OTP expiry on every auth email and we used
  // it only to write "expires in N minutes" into the copy. That number is the
  // one the story asks an operator to go and look up, because it is the REAL
  // ceiling on an impersonation token: adminGenerateLink mints a magiclink, and
  // supabase/auth applies config.Mailer.OtpExp to every token type through one
  // isOtpExpired() call, so the 30-minute cap we enforce in code is only the
  // shorter of the two. Recording it here makes /health/ready answer it.
  //
  // Best-effort, always. The comment below is right that returning an error
  // fails the user's signup or login outright, and no diagnostic is worth that.
  await recordOtpExpiry(emailData.otp_expiry);

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

/** system_settings key holding GoTrue's observed OTP expiry, in seconds. */
export const OTP_EXPIRY_KEY = "ops.gotrue_otp_expiry_seconds";

/**
 * Last value written by this process, so a busy hour is not an upsert per email.
 * Cleared on restart, which costs one redundant write and keeps the process
 * stateless in every way that matters.
 */
let lastWrittenOtpExpiry: number | null = null;

/** Exported for the test, which must be able to drive a fresh process. */
export function resetOtpExpiryCache(): void {
  lastWrittenOtpExpiry = null;
}

/**
 * Record GoTrue's OTP expiry, best-effort.
 *
 * NEVER THROWS. It sits in the middle of the send-email hook, and a hook that
 * answers non-200 fails the user's signup or login. A diagnostic that can break
 * authentication is not a diagnostic, it is an outage with a nice comment.
 */
export async function recordOtpExpiry(
  seconds: unknown,
  deps: { write?: (v: number) => Promise<{ error: { message: string } | null }> } = {},
): Promise<void> {
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds <= 0) return;
  if (seconds === lastWrittenOtpExpiry) return;
  try {
    const write = deps.write ?? writeOtpExpiry;
    const { error } = await write(seconds);
    if (error) {
      logEvent("warn", "auth_hook.otp_expiry_write_failed", { message: error.message });
      return;
    }
    lastWrittenOtpExpiry = seconds;
  } catch (err) {
    logEvent("warn", "auth_hook.otp_expiry_write_failed", {
      message: err instanceof Error ? err.message : String(err),
    });
  }
}

async function writeOtpExpiry(
  seconds: number,
): Promise<{ error: { message: string } | null }> {
  const { error } = await supabaseAdmin.from("system_settings").upsert(
    {
      key: OTP_EXPIRY_KEY,
      value: seconds,
      value_type: "number",
      default_value: 0,
      description:
        "US-2351 GoTrue's OTP expiry in seconds, as OBSERVED on the send-email " +
        "hook payload. Not a tunable: editing it here changes nothing in " +
        "GoTrue and makes /health/ready lie. Written only by " +
        "POST /api/auth/hooks/send-email.",
      category: "ops",
    },
    { onConflict: "key" },
  );
  return { error: error ? { message: error.message } : null };
}
