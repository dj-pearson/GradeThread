/**
 * Email notification utility using SMTP (e.g. Amazon SES).
 * Sends branded transactional emails for grade completions,
 * dispute resolutions, billing events, and welcome messages.
 *
 * Configured via the same SMTP_* env vars Supabase uses for its own SMTP, so
 * the edge service and Supabase Auth share one mail setup:
 *   SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_ADMIN_EMAIL (from address),
 *   SMTP_SENDER_NAME (from display name).
 */

import { SMTPClient } from "denomailer";
import { supabaseAdmin } from "./supabase.ts";
import { captureException, recordMetric } from "./observability.ts";
import { marketingUnsubscribeUrl } from "./unsubscribe.ts";

const BRAND_NAVY = "#0F3460";
const BRAND_RED = "#E94560";
const BRAND_NIGHT = "#1A1A2E";
const BRAND_GRAY = "#F5F5F5";
// US-801: derive the email base URL from env (same PUBLIC_SITE_URL the rest of
// the edge service uses) so staging/preview sends don't deep-link to production.
const SITE_URL = Deno.env.get("PUBLIC_SITE_URL")?.trim() || "https://gradethread.com";

// ─── Types ──────────────────────────────────────────────────────────

interface EmailOptions {
  to: string;
  subject: string;
  html: string;
  // US-498: when set, a failed send is persisted to the email_deliveries outbox
  // and retried with backoff (use for CRITICAL mail — grade-ready, payment-
  // failed). Omit for nice-to-have mail that doesn't warrant durable retry.
  category?: string;
}

interface GradeCompleteData {
  userName: string;
  submissionTitle: string;
  overallScore: number;
  gradeTier: string;
  submissionId: string;
  certificateId: string | null;
}

interface DisputeResolvedData {
  userName: string;
  submissionTitle: string;
  outcome: "resolved" | "rejected";
  resolutionNotes: string | null;
  originalScore: number;
  newScore: number | null;
  submissionId: string;
}

interface WelcomeData {
  userName: string;
}

// ─── Core Send Function ─────────────────────────────────────────────

// Public send: attempts delivery once, and on failure of a CRITICAL email
// (options.category set) persists it to the outbox for backoff retry (US-498).
// Every failure is reported to the error tracker. Returns true iff the message
// was accepted by SMTP on this attempt.
async function sendEmail(options: EmailOptions): Promise<boolean> {
  const ok = await deliverEmail(options);
  if (!ok && options.category) {
    await enqueueFailedEmail(options, options.category);
  }
  return ok;
}

// Raw SMTP send. Returns true on accept, false on any failure (and reports the
// failure to the error tracker). Exported so the retry cron can re-attempt a
// persisted message WITHOUT re-enqueuing it (the cron owns the outbox row).
export async function deliverEmail(options: EmailOptions): Promise<boolean> {
  const host = Deno.env.get("SMTP_HOST");
  const port = Number(Deno.env.get("SMTP_PORT") ?? "587") || 587;
  const user = Deno.env.get("SMTP_USER");
  const pass = Deno.env.get("SMTP_PASS");
  const fromEmail = Deno.env.get("SMTP_ADMIN_EMAIL");
  const fromName = Deno.env.get("SMTP_SENDER_NAME") || "GradeThread";

  if (!host || !user || !pass || !fromEmail) {
    console.warn(
      "[Email] SMTP not fully configured (need SMTP_HOST, SMTP_USER, SMTP_PASS, SMTP_ADMIN_EMAIL), skipping email send",
    );
    return false;
  }

  const client = new SMTPClient({
    connection: {
      hostname: host,
      port,
      // Port 465 uses implicit TLS; 587 (and 2587) connect plain then upgrade
      // via STARTTLS, which denomailer negotiates automatically. SES requires
      // TLS either way.
      tls: port === 465,
      auth: { username: user, password: pass },
    },
  });

  try {
    await client.send({
      from: `${fromName} <${fromEmail}>`,
      to: options.to,
      subject: options.subject,
      // "auto" generates a plaintext part from the HTML so we send multipart.
      content: "auto",
      html: options.html,
    });
    console.log(`[Email] Sent successfully to ${options.to}`);
    return true;
  } catch (error) {
    // US-498: report every send failure (the boolean was historically ignored
    // by callers). The caller / retry cron decides whether to persist + retry.
    captureException(error, {
      route: "email.send",
      tags: { category: options.category ?? "uncategorized" },
    });
    console.error(
      "[Email] Failed to send:",
      error instanceof Error ? error.message : String(error),
    );
    return false;
  } finally {
    try {
      await client.close();
    } catch {
      // Ignore close errors — the message was already accepted (or failed) above.
    }
  }
}

// US-498: persist a failed critical email so the retry cron can re-attempt it
// with backoff. Best-effort — if even the outbox write fails, we've already
// reported the original send failure.
async function enqueueFailedEmail(options: EmailOptions, category: string): Promise<void> {
  try {
    const { error } = await supabaseAdmin.from("email_deliveries").insert({
      recipient: options.to,
      subject: options.subject,
      html: options.html,
      category,
      status: "pending",
      attempts: 1, // the just-failed live attempt counts as the first
      // First retry ~1 min out; the cron applies exponential backoff thereafter.
      next_attempt_at: new Date(Date.now() + 60_000).toISOString(),
      last_error: "initial live send failed",
    });
    if (error) {
      captureException(error, { route: "email.enqueue", tags: { category } });
    } else {
      recordMetric("email.enqueued_for_retry", 1, { category });
    }
  } catch (err) {
    captureException(err, { route: "email.enqueue", tags: { category } });
  }
}

// ─── HTML Layout ────────────────────────────────────────────────────

// US-516 (CAN-SPAM): a valid physical postal address in every commercial email
// footer. Set COMPANY_POSTAL_ADDRESS to the real registered address.
// US-801: never render the bracketed "[SET …]" dev placeholder to a real
// recipient. When the env var is unset we warn (once) and fall back to the
// registered company + state — not a valid full street address, but compliant-
// looking and not obviously broken. Boot-time env validation (US-777) should
// also flag the missing var so it's caught before mail goes out.
let warnedMissingPostal = false;
function postalAddress(): string {
  const configured = Deno.env.get("COMPANY_POSTAL_ADDRESS")?.trim();
  if (configured) return configured;
  if (!warnedMissingPostal) {
    warnedMissingPostal = true;
    console.warn(
      "[email] COMPANY_POSTAL_ADDRESS is unset — CAN-SPAM footer is using a " +
        "fallback registered-entity line. Set it to the real postal address.",
    );
  }
  return "Pearson Media LLC, Iowa, USA";
}

// `unsubscribeUrl` (US-516): when provided (MARKETING email), render a no-login
// unsubscribe link. Transactional email omits it (and must not be globally
// suppressed) but still carries the postal address.
function emailLayout(
  content: string,
  opts: { unsubscribeUrl?: string } = {},
): string {
  const unsubscribeSection = opts.unsubscribeUrl
    ? `<tr>
        <td style="padding: 16px 32px; text-align: center;">
          <a href="${opts.unsubscribeUrl}" style="color: #999; font-size: 12px; text-decoration: underline;">
            Unsubscribe from marketing emails
          </a>
        </td>
      </tr>`
    : "";

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="margin: 0; padding: 0; background-color: ${BRAND_GRAY}; font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;">
  <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="background-color: ${BRAND_GRAY};">
    <tr>
      <td style="padding: 32px 16px;">
        <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="600" style="margin: 0 auto; max-width: 600px;">
          <!-- Header -->
          <tr>
            <td style="background-color: ${BRAND_NAVY}; padding: 24px 32px; border-radius: 12px 12px 0 0; text-align: center;">
              <h1 style="margin: 0; color: #ffffff; font-size: 24px; font-weight: 700; letter-spacing: -0.5px;">
                GradeThread
              </h1>
              <p style="margin: 4px 0 0; color: rgba(255,255,255,0.7); font-size: 13px;">
                AI-Powered Clothing Condition Grading
              </p>
            </td>
          </tr>
          <!-- Content -->
          <tr>
            <td style="background-color: #ffffff; padding: 32px;">
              ${content}
            </td>
          </tr>
          <!-- Footer -->
          <tr>
            <td style="background-color: ${BRAND_NIGHT}; padding: 20px 32px; border-radius: 0 0 12px 12px; text-align: center;">
              <p style="margin: 0; color: rgba(255,255,255,0.6); font-size: 12px;">
                &copy; ${new Date().getFullYear()} Pearson Media LLC. All rights reserved.
              </p>
              <p style="margin: 8px 0 0; color: rgba(255,255,255,0.4); font-size: 11px;">
                <a href="${SITE_URL}" style="color: rgba(255,255,255,0.6); text-decoration: none;">gradethread.com</a>
              </p>
              <!-- US-516 CAN-SPAM: physical postal address on every email. -->
              <p style="margin: 8px 0 0; color: rgba(255,255,255,0.4); font-size: 11px;">
                ${postalAddress()}
              </p>
            </td>
          </tr>
          ${unsubscribeSection}
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

function ctaButton(text: string, url: string): string {
  return `<table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin: 24px auto;">
    <tr>
      <td style="background-color: ${BRAND_RED}; border-radius: 8px;">
        <a href="${url}" style="display: inline-block; padding: 14px 32px; color: #ffffff; text-decoration: none; font-size: 15px; font-weight: 600;">
          ${text}
        </a>
      </td>
    </tr>
  </table>`;
}

// ─── Score Color Helper ─────────────────────────────────────────────

function scoreColor(score: number): string {
  if (score >= 7) return "#22c55e";
  if (score >= 5) return "#eab308";
  return "#ef4444";
}

// ─── Email Templates ────────────────────────────────────────────────

/**
 * Grade complete email: sent after grading pipeline finishes.
 */
export async function sendGradeCompleteEmail(
  to: string,
  data: GradeCompleteData
): Promise<boolean> {
  const reportUrl = `${SITE_URL}/dashboard/submissions/${data.submissionId}`;
  const certUrl = data.certificateId
    ? `${SITE_URL}/cert/${data.certificateId}`
    : null;

  const content = `
    <h2 style="margin: 0 0 8px; color: ${BRAND_NIGHT}; font-size: 20px;">
      Your Grade Is Ready!
    </h2>
    <p style="margin: 0 0 24px; color: #666; font-size: 15px; line-height: 1.5;">
      Hi ${escapeHtml(data.userName)}, your submission <strong>"${escapeHtml(data.submissionTitle)}"</strong> has been graded.
    </p>

    <!-- Score Card -->
    <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="margin-bottom: 24px;">
      <tr>
        <td style="background-color: ${BRAND_GRAY}; border-radius: 12px; padding: 24px; text-align: center;">
          <div style="font-size: 48px; font-weight: 700; color: ${scoreColor(data.overallScore)}; line-height: 1;">
            ${data.overallScore.toFixed(1)}
          </div>
          <div style="margin-top: 8px; font-size: 14px; font-weight: 600; color: ${BRAND_NAVY}; text-transform: uppercase; letter-spacing: 1px;">
            ${escapeHtml(data.gradeTier)}
          </div>
        </td>
      </tr>
    </table>

    <p style="margin: 0 0 8px; color: #666; font-size: 14px; line-height: 1.5; text-align: center;">
      View your full grade report with detailed factor scores and AI analysis.
    </p>

    ${ctaButton("View Grade Report", reportUrl)}

    ${certUrl ? `<p style="margin: 0; color: #999; font-size: 13px; text-align: center;">
      Share your <a href="${certUrl}" style="color: ${BRAND_RED}; text-decoration: underline;">grade certificate</a> with buyers.
    </p>` : ""}
  `;

  return await sendEmail({
    to,
    subject: `Grade Ready: ${data.submissionTitle} — ${data.overallScore.toFixed(1)} (${data.gradeTier})`,
    html: emailLayout(content),
    category: "grade_ready", // US-498: critical → durable retry on failure
  });
}

/**
 * Dispute resolved email: sent after admin resolves or rejects a dispute.
 */
export async function sendDisputeResolvedEmail(
  to: string,
  data: DisputeResolvedData
): Promise<boolean> {
  const reportUrl = `${SITE_URL}/dashboard/submissions/${data.submissionId}`;
  const isResolved = data.outcome === "resolved";
  const outcomeLabel = isResolved ? "Resolved" : "Rejected";
  const outcomeColor = isResolved ? "#22c55e" : "#ef4444";

  const gradeChange =
    isResolved && data.newScore !== null && data.newScore !== data.originalScore
      ? `<tr>
          <td style="padding: 12px; border-bottom: 1px solid #eee;">
            <span style="color: #666; font-size: 13px;">Grade Adjustment</span><br>
            <span style="font-size: 15px; font-weight: 600;">
              ${data.originalScore.toFixed(1)} &rarr; ${data.newScore.toFixed(1)}
            </span>
          </td>
        </tr>`
      : "";

  const content = `
    <h2 style="margin: 0 0 8px; color: ${BRAND_NIGHT}; font-size: 20px;">
      Dispute Update
    </h2>
    <p style="margin: 0 0 24px; color: #666; font-size: 15px; line-height: 1.5;">
      Hi ${escapeHtml(data.userName)}, your dispute for <strong>"${escapeHtml(data.submissionTitle)}"</strong> has been reviewed.
    </p>

    <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="margin-bottom: 24px; border: 1px solid #eee; border-radius: 8px;">
      <tr>
        <td style="padding: 12px; border-bottom: 1px solid #eee;">
          <span style="color: #666; font-size: 13px;">Outcome</span><br>
          <span style="font-size: 15px; font-weight: 600; color: ${outcomeColor};">
            ${outcomeLabel}
          </span>
        </td>
      </tr>
      ${gradeChange}
      ${data.resolutionNotes ? `<tr>
        <td style="padding: 12px;">
          <span style="color: #666; font-size: 13px;">Notes from reviewer</span><br>
          <span style="font-size: 14px; color: #333; line-height: 1.5;">
            ${escapeHtml(data.resolutionNotes)}
          </span>
        </td>
      </tr>` : ""}
    </table>

    ${ctaButton("View Submission", reportUrl)}
  `;

  return await sendEmail({
    to,
    subject: `Dispute ${outcomeLabel}: ${data.submissionTitle}`,
    html: emailLayout(content),
    category: "dispute_status", // US-801: durable retry on transient failure
  });
}

/**
 * Welcome email: sent after user completes signup.
 */
export async function sendWelcomeEmail(
  to: string,
  data: WelcomeData
): Promise<boolean> {
  const content = `
    <h2 style="margin: 0 0 8px; color: ${BRAND_NIGHT}; font-size: 20px;">
      Welcome to GradeThread!
    </h2>
    <p style="margin: 0 0 24px; color: #666; font-size: 15px; line-height: 1.5;">
      Hi ${escapeHtml(data.userName)}, thanks for joining. You're ready to start grading clothing with AI precision.
    </p>

    <h3 style="margin: 0 0 16px; color: ${BRAND_NIGHT}; font-size: 16px;">
      Getting Started
    </h3>

    <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="margin-bottom: 24px;">
      <tr>
        <td style="padding: 12px 16px; background-color: ${BRAND_GRAY}; border-radius: 8px; margin-bottom: 8px;">
          <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%">
            <tr>
              <td width="32" style="color: ${BRAND_RED}; font-size: 18px; font-weight: 700; vertical-align: top;">1.</td>
              <td style="color: #333; font-size: 14px; line-height: 1.5;">
                <strong>Submit your first item</strong> — Upload photos (front, back, label, detail) and we'll grade it instantly.
              </td>
            </tr>
          </table>
        </td>
      </tr>
      <tr><td style="height: 8px;"></td></tr>
      <tr>
        <td style="padding: 12px 16px; background-color: ${BRAND_GRAY}; border-radius: 8px;">
          <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%">
            <tr>
              <td width="32" style="color: ${BRAND_RED}; font-size: 18px; font-weight: 700; vertical-align: top;">2.</td>
              <td style="color: #333; font-size: 14px; line-height: 1.5;">
                <strong>Get your grade report</strong> — AI analyzes fabric, structure, cosmetics, function, and cleanliness.
              </td>
            </tr>
          </table>
        </td>
      </tr>
      <tr><td style="height: 8px;"></td></tr>
      <tr>
        <td style="padding: 12px 16px; background-color: ${BRAND_GRAY}; border-radius: 8px;">
          <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%">
            <tr>
              <td width="32" style="color: ${BRAND_RED}; font-size: 18px; font-weight: 700; vertical-align: top;">3.</td>
              <td style="color: #333; font-size: 14px; line-height: 1.5;">
                <strong>Share your certificate</strong> — Give buyers confidence with a verified condition grade.
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>

    <p style="margin: 0 0 8px; color: #666; font-size: 14px; line-height: 1.5; text-align: center;">
      You're on a 14-day Pro trial — no card required. Stay on Free or upgrade any time.
    </p>

    ${ctaButton("Go to Dashboard", `${SITE_URL}/dashboard`)}
  `;

  return await sendEmail({
    to,
    subject: "Welcome to GradeThread — Start Grading with AI",
    html: emailLayout(content),
    category: "welcome", // US-801: durable retry on transient failure
  });
}

// ─── Billing emails (US-222) ────────────────────────────────────────

interface SubscriptionStartedData {
  userName: string;
  plan: string;
  interval: "monthly" | "yearly";
  priceCents: number;
  periodEnd: string;
}

interface SubscriptionCanceledData {
  userName: string;
  plan: string;
  endsAt: string;
}

interface CreditPackPurchasedData {
  userName: string;
  credits: number;
  amountCents: number;
  newBalance: number;
}

interface PaymentFailedData {
  userName: string;
  plan: string;
  amountCents: number;
  attemptCount: number;
  retryAt: string | null;
}

interface TrialExpiringData {
  userName: string;
  daysLeft: number;
  trialEndsAt: string;
  // US-516: this is a promotional ("add a card / keep Pro") message, so it
  // carries a no-login unsubscribe link keyed to the recipient's user id.
  userId?: string;
}

function dollars(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
  });
}

export async function sendSubscriptionStartedEmail(
  to: string,
  data: SubscriptionStartedData,
): Promise<boolean> {
  const content = `
    <h2 style="margin: 0 0 8px; color: ${BRAND_NIGHT}; font-size: 20px;">
      Welcome to FlipDesk ${escapeHtml(data.plan)}!
    </h2>
    <p style="margin: 0 0 24px; color: #666; font-size: 15px; line-height: 1.5;">
      Hi ${escapeHtml(data.userName)}, your subscription is active. Thanks for going pro.
    </p>

    <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="margin-bottom: 24px; border: 1px solid #eee; border-radius: 8px;">
      <tr>
        <td style="padding: 12px;"><span style="color: #666; font-size: 13px;">Plan</span><br><strong>FlipDesk ${escapeHtml(data.plan)}</strong></td>
        <td style="padding: 12px; border-left: 1px solid #eee;"><span style="color: #666; font-size: 13px;">Billed</span><br><strong>${dollars(data.priceCents)} / ${data.interval === "yearly" ? "year" : "month"}</strong></td>
      </tr>
      <tr><td colspan="2" style="padding: 12px; border-top: 1px solid #eee;"><span style="color: #666; font-size: 13px;">Next charge</span><br><strong>${formatDate(data.periodEnd)}</strong></td></tr>
    </table>

    ${ctaButton("Go to Billing", `${SITE_URL}/dashboard/billing`)}
  `;
  return await sendEmail({
    to,
    subject: `FlipDesk ${data.plan} active — welcome aboard`,
    html: emailLayout(content),
    category: "subscription_started", // US-801: durable retry on transient failure
  });
}

export async function sendSubscriptionCanceledEmail(
  to: string,
  data: SubscriptionCanceledData,
): Promise<boolean> {
  const content = `
    <h2 style="margin: 0 0 8px; color: ${BRAND_NIGHT}; font-size: 20px;">
      Cancellation scheduled
    </h2>
    <p style="margin: 0 0 16px; color: #666; font-size: 15px; line-height: 1.5;">
      Hi ${escapeHtml(data.userName)}, your <strong>FlipDesk ${escapeHtml(data.plan)}</strong> subscription will end on <strong>${formatDate(data.endsAt)}</strong>. Until then you keep full access.
    </p>
    <p style="margin: 0 0 16px; color: #666; font-size: 14px; line-height: 1.5;">
      Your inventory, listings, past grade reports, and grade credits all stay safe. Changed your mind? You can undo the cancellation any time before ${formatDate(data.endsAt)}.
    </p>
    ${ctaButton("Manage subscription", `${SITE_URL}/dashboard/billing`)}
  `;
  return await sendEmail({
    to,
    subject: `Your FlipDesk ${data.plan} plan ends ${formatDate(data.endsAt)}`,
    html: emailLayout(content),
    category: "subscription_canceled", // US-801: durable retry on transient failure
  });
}

interface SubscriptionPausedData {
  userName: string;
  plan: string;
  resumesAt: string;
}

interface SubscriptionResumedData {
  userName: string;
  plan: string;
  auto: boolean;
}

export async function sendSubscriptionPausedEmail(
  to: string,
  data: SubscriptionPausedData,
): Promise<boolean> {
  const content = `
    <h2 style="margin: 0 0 8px; color: ${BRAND_NIGHT}; font-size: 20px;">
      Your subscription is paused
    </h2>
    <p style="margin: 0 0 16px; color: #666; font-size: 15px; line-height: 1.5;">
      Hi ${escapeHtml(data.userName)}, your <strong>FlipDesk ${escapeHtml(data.plan)}</strong> subscription is paused. We'll automatically resume it on <strong>${formatDate(data.resumesAt)}</strong>.
    </p>
    <p style="margin: 0 0 16px; color: #666; font-size: 14px; line-height: 1.5;">
      While paused, your caps fall back to Free and we don't charge you. Your data and grade credits stay safe. You can resume early from the billing page any time.
    </p>
    ${ctaButton("Manage subscription", `${SITE_URL}/dashboard/billing`)}
  `;
  return await sendEmail({
    to,
    subject: `FlipDesk ${data.plan} paused — resumes ${formatDate(data.resumesAt)}`,
    html: emailLayout(content),
    category: "subscription_paused", // US-801: durable retry on transient failure
  });
}

export async function sendSubscriptionResumedEmail(
  to: string,
  data: SubscriptionResumedData,
): Promise<boolean> {
  const content = `
    <h2 style="margin: 0 0 8px; color: ${BRAND_NIGHT}; font-size: 20px;">
      Welcome back to FlipDesk ${escapeHtml(data.plan)}
    </h2>
    <p style="margin: 0 0 16px; color: #666; font-size: 15px; line-height: 1.5;">
      Hi ${escapeHtml(data.userName)}, your subscription is active again. ${data.auto ? "Your pause window ended on schedule." : "Glad you're back ahead of schedule."}
    </p>
    ${ctaButton("Go to dashboard", `${SITE_URL}/dashboard`)}
  `;
  return await sendEmail({
    to,
    subject: `FlipDesk ${data.plan} is active again`,
    html: emailLayout(content),
    category: "subscription_resumed", // US-801: durable retry on transient failure
  });
}

export async function sendCreditPackPurchasedEmail(
  to: string,
  data: CreditPackPurchasedData,
): Promise<boolean> {
  const content = `
    <h2 style="margin: 0 0 8px; color: ${BRAND_NIGHT}; font-size: 20px;">
      ${data.credits} credits added
    </h2>
    <p style="margin: 0 0 24px; color: #666; font-size: 15px; line-height: 1.5;">
      Hi ${escapeHtml(data.userName)}, your purchase is complete. ${data.credits} credits just landed in your GradeThread wallet.
    </p>

    <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="margin-bottom: 24px; border: 1px solid #eee; border-radius: 8px;">
      <tr>
        <td style="padding: 12px;"><span style="color: #666; font-size: 13px;">Pack</span><br><strong>${data.credits} credits</strong></td>
        <td style="padding: 12px; border-left: 1px solid #eee;"><span style="color: #666; font-size: 13px;">Total</span><br><strong>${dollars(data.amountCents)}</strong></td>
      </tr>
      <tr><td colspan="2" style="padding: 12px; border-top: 1px solid #eee;"><span style="color: #666; font-size: 13px;">New balance</span><br><strong style="font-size: 18px; color: ${BRAND_NAVY};">${data.newBalance} credits</strong></td></tr>
    </table>

    <p style="margin: 0 0 8px; color: #999; font-size: 13px; text-align: center;">
      1 credit = 1 Standard grade · Premium = 3 · Express = 5 · Never expire
    </p>

    ${ctaButton("Submit a grade", `${SITE_URL}/dashboard/submissions/new`)}
  `;
  return await sendEmail({
    to,
    subject: `Receipt: ${data.credits} GradeThread credits — ${dollars(data.amountCents)}`,
    html: emailLayout(content),
    category: "credit_pack_purchased", // US-801: durable retry on transient failure
  });
}

export async function sendPaymentFailedEmail(
  to: string,
  data: PaymentFailedData,
): Promise<boolean> {
  const content = `
    <h2 style="margin: 0 0 8px; color: ${BRAND_NIGHT}; font-size: 20px;">
      Your payment didn't go through
    </h2>
    <p style="margin: 0 0 16px; color: #666; font-size: 15px; line-height: 1.5;">
      Hi ${escapeHtml(data.userName)}, we couldn't charge your card for your <strong>FlipDesk ${escapeHtml(data.plan)}</strong> renewal (${dollars(data.amountCents)}). This was attempt ${data.attemptCount}.
    </p>
    <p style="margin: 0 0 16px; color: #666; font-size: 14px; line-height: 1.5;">
      Update your card now to keep your plan active. ${data.retryAt ? `We'll automatically retry on <strong>${formatDate(data.retryAt)}</strong>.` : ""} After several failed attempts your plan will drop to Free.
    </p>
    ${ctaButton("Update card", `${SITE_URL}/dashboard/billing`)}
  `;
  return await sendEmail({
    to,
    subject: "Action needed: update your card to keep FlipDesk active",
    html: emailLayout(content),
    category: "payment_failed", // US-498: critical → durable retry on failure
  });
}

export async function sendTrialExpiringEmail(
  to: string,
  data: TrialExpiringData,
): Promise<boolean> {
  const content = `
    <h2 style="margin: 0 0 8px; color: ${BRAND_NIGHT}; font-size: 20px;">
      ${data.daysLeft} day${data.daysLeft === 1 ? "" : "s"} left on your Pro trial
    </h2>
    <p style="margin: 0 0 16px; color: #666; font-size: 15px; line-height: 1.5;">
      Hi ${escapeHtml(data.userName)}, your 14-day FlipDesk Pro trial ends on <strong>${formatDate(data.trialEndsAt)}</strong>. Add a card now to keep your Pro features without interruption.
    </p>
    <p style="margin: 0 0 16px; color: #666; font-size: 14px; line-height: 1.5;">
      If you don't subscribe, you'll automatically drop to the Free plan — you'll keep your data, but caps will tighten.
    </p>
    ${ctaButton("Add card", `${SITE_URL}/dashboard/billing`)}
  `;
  const unsubscribeUrl = data.userId
    ? await marketingUnsubscribeUrl(data.userId)
    : undefined;
  return await sendEmail({
    to,
    subject: `${data.daysLeft} day${data.daysLeft === 1 ? "" : "s"} left on your FlipDesk Pro trial`,
    html: emailLayout(content, { unsubscribeUrl }),
    category: "trial_expiring", // US-801: durable retry on transient failure
  });
}

// ─── Workspace invitation (team support) ─────────────────────────────

interface WorkspaceInvitationData {
  inviterName: string;
  inviterEmail: string;
  workspaceName: string;
  role: string;
  acceptUrl: string;
  expiresAt: string;
}

export async function sendWorkspaceInvitationEmail(
  to: string,
  data: WorkspaceInvitationData,
): Promise<boolean> {
  const content = `
    <h2 style="margin: 0 0 8px; color: ${BRAND_NIGHT}; font-size: 20px;">
      You're invited to join ${escapeHtml(data.workspaceName)}
    </h2>
    <p style="margin: 0 0 16px; color: #666; font-size: 15px; line-height: 1.5;">
      ${escapeHtml(data.inviterName)} (${escapeHtml(data.inviterEmail)})
      invited you to collaborate in their GradeThread workspace as a
      <strong>${escapeHtml(data.role)}</strong>.
    </p>
    <p style="margin: 0 0 24px; color: #666; font-size: 14px; line-height: 1.5;">
      Click the button below to accept. If you don't have an account yet,
      you'll be prompted to create one first. This invite expires on
      <strong>${formatDate(data.expiresAt)}</strong>.
    </p>

    ${ctaButton("Accept invitation", data.acceptUrl)}

    <p style="margin: 24px 0 0; color: #999; font-size: 12px; line-height: 1.5; text-align: center;">
      If you weren't expecting this invitation, you can safely ignore this
      email. The workspace owner won't be notified.
    </p>
  `;

  return await sendEmail({
    to,
    subject: `${data.inviterName} invited you to ${data.workspaceName} on GradeThread`,
    html: emailLayout(content),
    category: "workspace_invite", // US-801: durable retry on transient failure
  });
}

// ─── Grading regression alert (US-327, internal/admin) ───────────────

interface GradingRegressionAlertData {
  severity: string; // "warn" | "critical"
  alerts: Array<{ severity: string; message: string }>;
  production: {
    human_reviews: number;
    agreement_rate: number;
    mean_absolute_error: number;
    intentional_misread_rate: number;
    graded_sales: number;
    dispute_rate: number;
  };
  evalSummary: string;
}

/**
 * Internal alert to the grading team when the regression monitor (US-327)
 * detects the live grader drifting. Not a customer email — sent to the admin
 * address so a human can investigate before quality slips further.
 */
export async function sendGradingRegressionAlertEmail(
  to: string,
  data: GradingRegressionAlertData,
): Promise<boolean> {
  const isCritical = data.severity === "critical";
  const banner = isCritical ? BRAND_RED : "#eab308";
  const p = data.production;
  const rows = data.alerts
    .map(
      (a) => `
      <tr>
        <td style="padding: 8px 12px; border-bottom: 1px solid #eee; font-size: 13px;">
          <span style="display:inline-block;min-width:64px;font-weight:700;color:${
            a.severity === "critical" ? BRAND_RED : "#a16207"
          };text-transform:uppercase;">${escapeHtml(a.severity)}</span>
          ${escapeHtml(a.message)}
        </td>
      </tr>`,
    )
    .join("");

  const content = `
    <div style="background:${banner};color:#fff;padding:10px 16px;border-radius:8px;font-weight:700;font-size:14px;text-align:center;margin-bottom:20px;">
      Grading quality alert — ${escapeHtml(data.severity.toUpperCase())}
    </div>
    <h2 style="margin: 0 0 8px; color: ${BRAND_NIGHT}; font-size: 20px;">
      The grading monitor flagged a regression
    </h2>
    <p style="margin: 0 0 16px; color: #666; font-size: 14px; line-height: 1.5;">
      The scheduled self-check detected one or more grading-quality thresholds
      were breached. Review the AI Models dashboard and recent reviews.
    </p>
    <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="margin: 0 0 20px;">
      ${rows}
    </table>
    <h3 style="margin: 0 0 8px; color: ${BRAND_NIGHT}; font-size: 15px;">Current production metrics</h3>
    <ul style="margin: 0 0 16px; padding-left: 18px; color:#444; font-size: 13px; line-height: 1.7;">
      <li>AI-vs-human agreement: <strong>${(p.agreement_rate * 100).toFixed(1)}%</strong> (${p.human_reviews} reviews)</li>
      <li>Mean absolute error: <strong>${p.mean_absolute_error.toFixed(2)}</strong></li>
      <li>Intentional-misread rate: <strong>${(p.intentional_misread_rate * 100).toFixed(1)}%</strong></li>
      <li>Buyer dispute rate: <strong>${(p.dispute_rate * 100).toFixed(1)}%</strong> (${p.graded_sales} sales)</li>
      <li>Live eval: ${escapeHtml(data.evalSummary)}</li>
    </ul>
    ${ctaButton("Open AI Models dashboard", `${SITE_URL}/admin/ai-models`)}
  `;
  return await sendEmail({
    to,
    subject: `${isCritical ? "🔴" : "🟡"} GradeThread grading-quality alert (${data.severity})`,
    html: emailLayout(content),
    category: "grading_regression_alert", // US-801: durable retry on transient failure
  });
}

// ─── Grade dispute filed (internal/admin alert) ─────────────────────

interface DisputeFiledData {
  submitterName: string;
  submissionTitle: string;
  reason: string;
  submissionId: string;
}

/**
 * Alert the platform admin that a submitter filed a grade dispute, so it's
 * reviewed without polling the disputes table.
 */
export async function sendDisputeFiledAdminEmail(
  to: string,
  data: DisputeFiledData,
): Promise<boolean> {
  const content = `
    <h2 style="margin: 0 0 8px; color: ${BRAND_NIGHT}; font-size: 20px;">
      New grade dispute filed
    </h2>
    <p style="margin: 0 0 16px; color: #666; font-size: 15px; line-height: 1.5;">
      <strong>${escapeHtml(data.submitterName)}</strong> disputed the grade for
      <strong>${escapeHtml(data.submissionTitle)}</strong> and is requesting a review.
    </p>
    <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="margin: 0 0 8px;">
      <tr>
        <td style="padding: 12px; background:${BRAND_GRAY}; border-radius: 8px; font-size: 14px; color:#333;">
          <span style="color:#666;font-size:12px;">Reason</span><br>
          ${escapeHtml(data.reason)}
        </td>
      </tr>
    </table>
    ${ctaButton("Review dispute", `${SITE_URL}/admin/disputes`)}
  `;
  return await sendEmail({
    to,
    subject: `New grade dispute: ${data.submissionTitle}`,
    html: emailLayout(content),
    category: "dispute_filed_admin", // US-801: durable retry on transient failure
  });
}

// ─── Referral reward ────────────────────────────────────────────────

interface ReferralRewardData {
  userName: string | null;
  credits: number;
  /** Referrer (their invitee qualified) vs the referred user (they joined). */
  isReferrer: boolean;
}

/**
 * US-802: tell a user their referral reward landed. Sent to both the referrer
 * and the referred user when an admin grants a referral. Categorized so a
 * transient SMTP failure is retried from the outbox (US-801).
 */
export async function sendReferralRewardEmail(
  to: string,
  data: ReferralRewardData,
): Promise<boolean> {
  const greeting = data.userName ? `Hi ${escapeHtml(data.userName)}, ` : "";
  const reason = data.isReferrer
    ? "someone you referred qualified"
    : "you joined through a referral";
  const content = `
    <h2 style="margin: 0 0 8px; color: ${BRAND_NIGHT}; font-size: 20px;">
      You earned ${data.credits} grade credit${data.credits === 1 ? "" : "s"}
    </h2>
    <p style="margin: 0 0 24px; color: #666; font-size: 15px; line-height: 1.5;">
      ${greeting}because ${reason}, we've added
      <strong>${data.credits} grade credit${data.credits === 1 ? "" : "s"}</strong>
      to your account. They're ready to use now.
    </p>
    ${ctaButton("View your balance", `${SITE_URL}/dashboard/billing`)}
  `;
  return await sendEmail({
    to,
    subject: `You earned ${data.credits} GradeThread credit${data.credits === 1 ? "" : "s"}`,
    html: emailLayout(content),
    category: "referral_reward", // US-801/US-802: durable retry on transient failure
  });
}

// ─── User feedback (internal/support alert) ─────────────────────────

interface FeedbackData {
  userEmail: string;
  userName: string | null;
  message: string;
  source: string;
  appVersion: string | null;
  osVersion: string | null;
  deviceModel: string | null;
}

/**
 * US-801: route an in-app feedback submission to support so a human triages it
 * without polling feedback_messages. The DB row remains the system-of-record;
 * this is the best-effort notification (categorized so a transient SMTP failure
 * is retried from the outbox).
 */
export async function sendFeedbackEmail(
  to: string,
  data: FeedbackData,
): Promise<boolean> {
  const meta = [
    ["From", `${data.userName ? `${data.userName} ` : ""}<${data.userEmail}>`],
    ["Source", data.source],
    ["App version", data.appVersion],
    ["OS", data.osVersion],
    ["Device", data.deviceModel],
  ]
    .filter(([, v]) => v)
    .map(
      ([k, v]) =>
        `<tr><td style="padding:4px 12px;color:#666;font-size:12px;">${escapeHtml(
          k as string,
        )}</td><td style="padding:4px 12px;font-size:13px;color:#333;">${escapeHtml(
          String(v),
        )}</td></tr>`,
    )
    .join("");

  const content = `
    <h2 style="margin: 0 0 8px; color: ${BRAND_NIGHT}; font-size: 20px;">
      New in-app feedback
    </h2>
    <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="margin: 0 0 16px;">
      ${meta}
    </table>
    <div style="padding:12px;background:${BRAND_GRAY};border-radius:8px;font-size:14px;color:#333;line-height:1.5;white-space:pre-wrap;">${escapeHtml(
      data.message,
    )}</div>
  `;
  return await sendEmail({
    to,
    subject: `New feedback from ${data.userName ?? data.userEmail}`,
    html: emailLayout(content),
    category: "feedback", // US-801: durable retry on transient failure
  });
}

// US-373: confirmation that an account was permanently deleted. Sent to the
// erased account's email (captured before the cascade). No PII beyond the name
// and no links into the (now gone) account.
export async function sendAccountDeletedEmail(
  to: string,
  userName: string,
): Promise<boolean> {
  const content = `
    <h2 style="margin: 0 0 8px; color: ${BRAND_NIGHT}; font-size: 20px;">
      Your account has been deleted
    </h2>
    <p style="margin: 0 0 16px; color: #666; font-size: 15px; line-height: 1.5;">
      Hi ${escapeHtml(userName)}, this confirms that your GradeThread account and
      its data have been permanently deleted at your request.
    </p>
    <p style="margin: 0 0 16px; color: #666; font-size: 14px; line-height: 1.5;">
      If you did <strong>not</strong> request this, or you deleted your account by
      mistake, contact us at <a href="mailto:support@gradethread.com" style="color: ${BRAND_RED};">support@gradethread.com</a>
      as soon as possible — for a short window after deletion our team may be able
      to help. After that the erasure is irreversible.
    </p>
    <p style="margin: 0; color: #999; font-size: 13px; line-height: 1.5;">
      Thank you for having used GradeThread.
    </p>
  `;
  return await sendEmail({
    to,
    subject: "Your GradeThread account has been deleted",
    html: emailLayout(content),
    category: "account_deleted", // US-801: durable retry on transient failure
  });
}

// ─── Helpers ────────────────────────────────────────────────────────

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// ─── Broadcast / marketing email (US-627) ───────────────────────────

interface BroadcastEmailData {
  /** Recipient user id — used to mint a no-login marketing unsubscribe link. */
  userId: string;
  subject: string;
  /** Plain-text body; blank lines split paragraphs, single newlines → <br>. */
  body: string;
  ctaLabel?: string | null;
  ctaUrl?: string | null;
}

/**
 * Campaign broadcast email (US-627). This is MARKETING mail: it always renders
 * the CAN-SPAM unsubscribe link + postal address (US-516) via the marketing
 * footer. The send engine only calls this for users who have NOT already opted
 * out of marketing in their notification preferences.
 */
export async function sendBroadcastEmail(
  to: string,
  data: BroadcastEmailData,
): Promise<boolean> {
  const paragraphs = data.body
    .split(/\n{2,}/)
    .map(
      (p) =>
        `<p style="margin: 0 0 16px; color: #444; font-size: 15px; line-height: 1.6;">${
          escapeHtml(p).replace(/\n/g, "<br>")
        }</p>`,
    )
    .join("");

  const content = `
    <h2 style="margin: 0 0 16px; color: ${BRAND_NIGHT}; font-size: 20px;">
      ${escapeHtml(data.subject)}
    </h2>
    ${paragraphs}
    ${data.ctaLabel && data.ctaUrl ? ctaButton(data.ctaLabel, data.ctaUrl) : ""}
  `;

  const unsubscribeUrl = await marketingUnsubscribeUrl(data.userId);

  return await sendEmail({
    to,
    subject: data.subject,
    html: emailLayout(content, { unsubscribeUrl }),
  });
}
