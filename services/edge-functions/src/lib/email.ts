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
import { isEmailSuppressed } from "./email-suppression.ts";
import { applyEmailTracking } from "./email-tracking.ts";

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

interface AdminMessageData {
  userName: string;
  /** Subject line — also rendered as the email heading. */
  subject: string;
  /** Plain-text body; blank lines split paragraphs, single newlines → <br>. */
  body: string;
  ctaLabel?: string | null;
  ctaUrl?: string | null;
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
  // US-1057: never send to a hard-bounced or complained address — sending to
  // known-bad recipients is the fastest way to wreck SES sender reputation. A
  // suppressed recipient is a TERMINAL no-op, not a transient failure: return
  // `true` so neither the live enqueue (sendEmail) nor the retry cron treats it
  // as a failure worth retrying. (isEmailSuppressed fails OPEN on a DB error.)
  if (await isEmailSuppressed(options.to)) {
    console.warn(
      `[Email] Recipient is suppressed (bounce/complaint) — skipping send (category=${options.category ?? "uncategorized"})`,
    );
    recordMetric("email.suppressed_skip", 1, { category: options.category ?? "uncategorized" });
    return true;
  }

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

// ─── Waitlist invite (US-585) ───────────────────────────────────────

/**
 * Early-access invite: sent when an admin invites an approved waitlist entry to
 * sign up. Best-effort (no durable retry) — re-invite is one click in the admin
 * surface if it bounces.
 */
export async function sendWaitlistInviteEmail(
  to: string,
  data: { fullName?: string | null; cohort?: string | null },
): Promise<boolean> {
  const greeting = data.fullName ? `Hi ${escapeHtml(data.fullName)},` : "Hi there,";
  const cohortLine = data.cohort
    ? `<p style="margin: 0 0 24px; color: #666; font-size: 14px; line-height: 1.5;">You're part of our <strong>${escapeHtml(
        data.cohort,
      )}</strong> group.</p>`
    : "";
  const content = `
    <h2 style="margin: 0 0 8px; color: ${BRAND_NIGHT}; font-size: 20px;">
      You're in — welcome to GradeThread early access
    </h2>
    <p style="margin: 0 0 16px; color: #666; font-size: 15px; line-height: 1.5;">
      ${greeting} your spot on the GradeThread waitlist has been approved. You can
      create your account and start grading clothing with AI precision right now.
    </p>
    ${cohortLine}
    ${ctaButton("Create your account", `${SITE_URL}/signup`)}
    <p style="margin: 16px 0 0; color: #999; font-size: 13px; line-height: 1.5; text-align: center;">
      Use this email address (${escapeHtml(to)}) when you sign up so we can match
      your invite.
    </p>
  `;

  return await sendEmail({
    to,
    subject: "Your GradeThread early-access invite is ready",
    html: emailLayout(content),
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

// US-222: per-renewal subscription receipt (recurring charge).
interface SubscriptionRenewalReceiptData {
  userName: string;
  plan: string;
  interval: "monthly" | "yearly";
  amountCents: number;
  periodEnd: string;
  invoiceNumber: string | null;
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

// US-222: receipt for a recurring subscription renewal (billing_reason
// "subscription_cycle"). The first charge is covered by
// sendSubscriptionStartedEmail; this closes the gap so every recurring charge
// produces a receipt, mirroring the credit-pack receipt.
export async function sendSubscriptionRenewalReceiptEmail(
  to: string,
  data: SubscriptionRenewalReceiptData,
): Promise<boolean> {
  const content = `
    <h2 style="margin: 0 0 8px; color: ${BRAND_NIGHT}; font-size: 20px;">
      Payment received — FlipDesk ${escapeHtml(data.plan)}
    </h2>
    <p style="margin: 0 0 24px; color: #666; font-size: 15px; line-height: 1.5;">
      Hi ${escapeHtml(data.userName)}, thanks — your FlipDesk ${escapeHtml(data.plan)} subscription renewed.
    </p>

    <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="margin-bottom: 24px; border: 1px solid #eee; border-radius: 8px;">
      <tr>
        <td style="padding: 12px;"><span style="color: #666; font-size: 13px;">Plan</span><br><strong>FlipDesk ${escapeHtml(data.plan)}</strong></td>
        <td style="padding: 12px; border-left: 1px solid #eee;"><span style="color: #666; font-size: 13px;">Charged</span><br><strong>${dollars(data.amountCents)} / ${data.interval === "yearly" ? "year" : "month"}</strong></td>
      </tr>
      <tr><td colspan="2" style="padding: 12px; border-top: 1px solid #eee;"><span style="color: #666; font-size: 13px;">Renews</span><br><strong>${formatDate(data.periodEnd)}</strong></td></tr>
      ${
    data.invoiceNumber
      ? `<tr><td colspan="2" style="padding: 12px; border-top: 1px solid #eee;"><span style="color: #666; font-size: 13px;">Invoice</span><br><strong>${escapeHtml(data.invoiceNumber)}</strong></td></tr>`
      : ""
  }
    </table>

    ${ctaButton("View Billing", `${SITE_URL}/dashboard/billing`)}
  `;
  return await sendEmail({
    to,
    subject: `Receipt: FlipDesk ${data.plan} — ${dollars(data.amountCents)}`,
    html: emailLayout(content),
    category: "subscription_renewal_receipt", // US-801: durable retry on transient failure
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

interface PlanDowngradedData {
  userName: string;
  // The paid plan the user was demoted FROM (e.g. "Pro").
  fromPlan: string;
}

// US-776: a subscription change couldn't be mapped to a paid tier (missing
// metadata/lookup_key), so the webhook fails closed to Free. The customer was
// silently demoted — tell them, with a link to fix their billing. Durable
// (category) so a transient SMTP failure is retried, not lost.
export async function sendPlanDowngradedEmail(
  to: string,
  data: PlanDowngradedData,
): Promise<boolean> {
  const content = `
    <h2 style="margin: 0 0 8px; color: ${BRAND_NIGHT}; font-size: 20px;">
      Your plan was changed to Free
    </h2>
    <p style="margin: 0 0 16px; color: #666; font-size: 15px; line-height: 1.5;">
      Hi ${escapeHtml(data.userName)}, we hit a problem applying your <strong>FlipDesk ${escapeHtml(data.fromPlan)}</strong> subscription, so your account is on <strong>Free</strong> for now and your paid plan benefits are paused.
    </p>
    <p style="margin: 0 0 16px; color: #666; font-size: 14px; line-height: 1.5;">
      Your inventory, listings, past grade reports, and grade credits are all safe. Reviewing your billing details — re-subscribing or updating your card — restores your plan right away. If this looks wrong, just reply and we'll sort it out.
    </p>
    ${ctaButton("Review billing", `${SITE_URL}/dashboard/billing`)}
  `;
  return await sendEmail({
    to,
    subject: "Your FlipDesk plan was changed to Free",
    html: emailLayout(content),
    category: "plan_downgraded", // durable retry on transient failure
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

// ─── North Star: Items Listed Per Week (US-597) ──────────────────────

interface NorthStarWeeklyData {
  userId: string;
  userName: string;
  /** Items listed during the week being celebrated. */
  itemsListed: number;
  /** The weekly goal. */
  goal: number;
  /** Consecutive-week listing streak as of this week. */
  streakWeeks: number;
  /** All-time items listed. */
  lifetimeListed: number;
}

// US-934: build the weekly digest's {subject, html} WITHOUT sending, so the
// marketing coordinator (the single cross-program chokepoint) can gate/defer it.
// The returned html already carries the branded layout + CAN-SPAM footer +
// one-click unsubscribe, so the coordinator only delivers/defers it.
export async function buildNorthStarWeeklyEmail(
  data: NorthStarWeeklyData,
): Promise<{ subject: string; html: string }> {
  const goalMet = data.itemsListed >= data.goal;
  const headline = goalMet
    ? `🎉 You hit your weekly goal — ${data.itemsListed} listed!`
    : data.itemsListed > 0
      ? `You listed ${data.itemsListed} item${data.itemsListed === 1 ? "" : "s"} this week`
      : "Your listing week is open — let's get the first one up";
  const streakLine =
    data.streakWeeks > 1
      ? `<p style="margin: 0 0 16px; color: ${BRAND_RED}; font-size: 15px; font-weight: 600;">🔥 You're on a ${data.streakWeeks}-week listing streak — don't break the chain!</p>`
      : data.streakWeeks === 1
        ? `<p style="margin: 0 0 16px; color: #666; font-size: 14px;">List an item next week to start a streak. 🔥</p>`
        : "";
  const body = goalMet
    ? `Listing throughput is the number that moves inventory and revenue — and you're crushing it. Keep the momentum going.`
    : data.itemsListed > 0
      ? `You're ${Math.max(0, data.goal - data.itemsListed)} away from your weekly goal of ${data.goal}. A few more listings keeps your pipeline — and your sales — flowing.`
      : `Items listed per week is the single biggest driver of your sales. Get one item up to keep your streak alive.`;

  const content = `
    <h2 style="margin: 0 0 8px; color: ${BRAND_NIGHT}; font-size: 20px;">
      ${headline}
    </h2>
    <p style="margin: 0 0 16px; color: #666; font-size: 15px; line-height: 1.5;">
      Hi ${escapeHtml(data.userName)}, ${body}
    </p>
    ${streakLine}
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin: 0 0 8px;">
      <tr>
        <td style="padding: 12px; background: ${BRAND_GRAY}; border-radius: 8px; text-align: center;">
          <div style="font-size: 24px; font-weight: 700; color: ${BRAND_NAVY};">${data.itemsListed} / ${data.goal}</div>
          <div style="font-size: 12px; color: #666;">this week</div>
        </td>
        <td style="width: 12px;"></td>
        <td style="padding: 12px; background: ${BRAND_GRAY}; border-radius: 8px; text-align: center;">
          <div style="font-size: 24px; font-weight: 700; color: ${BRAND_NAVY};">${data.lifetimeListed}</div>
          <div style="font-size: 12px; color: #666;">all-time listed</div>
        </td>
      </tr>
    </table>
    ${ctaButton("List an item", `${SITE_URL}/dashboard/flipdesk/intake`)}
  `;
  const unsubscribeUrl = await marketingUnsubscribeUrl(data.userId);
  return {
    subject: goalMet
      ? `🎉 Weekly goal hit — ${data.itemsListed} items listed`
      : `Your week in listings: ${data.itemsListed} item${data.itemsListed === 1 ? "" : "s"}`,
    html: emailLayout(content, { unsubscribeUrl }),
  };
}

// Weekly encouragement digest tied to listing activity. Marketing-class
// (carries an unsubscribe link). Sent by the north-star digest cron.
export async function sendNorthStarWeeklyEmail(
  to: string,
  data: NorthStarWeeklyData,
): Promise<boolean> {
  const { subject, html } = await buildNorthStarWeeklyEmail(data);
  return await sendEmail({
    to,
    subject,
    html,
    category: "north_star_weekly",
  });
}

interface NorthStarMilestoneData {
  userId: string;
  userName: string;
  /** The lifetime milestone just reached (e.g. 50). */
  milestone: number;
  /** All-time items listed. */
  lifetimeListed: number;
}

// US-934: build the milestone email's {subject, html} WITHOUT sending, so the
// marketing coordinator can gate/defer it (the html already carries the layout +
// CAN-SPAM footer + one-click unsubscribe).
export async function buildNorthStarMilestoneEmail(
  data: NorthStarMilestoneData,
): Promise<{ subject: string; html: string }> {
  const content = `
    <h2 style="margin: 0 0 8px; color: ${BRAND_NIGHT}; font-size: 22px;">
      🏆 ${data.milestone} items listed — what a milestone!
    </h2>
    <p style="margin: 0 0 16px; color: #666; font-size: 15px; line-height: 1.5;">
      Hi ${escapeHtml(data.userName)}, you've now listed <strong>${data.lifetimeListed}</strong> items on FlipDesk. Every listing is a shot at a sale — this is real throughput, and it compounds.
    </p>
    <p style="margin: 0 0 16px; color: #666; font-size: 14px; line-height: 1.5;">
      Keep stacking weeks and watch the sales follow. On to the next milestone.
    </p>
    ${ctaButton("Keep listing", `${SITE_URL}/dashboard/flipdesk/intake`)}
  `;
  const unsubscribeUrl = await marketingUnsubscribeUrl(data.userId);
  return {
    subject: `🏆 You've listed ${data.milestone} items on FlipDesk`,
    html: emailLayout(content, { unsubscribeUrl }),
  };
}

// Celebrates crossing a lifetime items-listed milestone. Marketing-class.
export async function sendNorthStarMilestoneEmail(
  to: string,
  data: NorthStarMilestoneData,
): Promise<boolean> {
  const { subject, html } = await buildNorthStarMilestoneEmail(data);
  return await sendEmail({
    to,
    subject,
    html,
    category: "north_star_milestone",
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

// ─── Content scheduler/webhook watchdog (internal/owner alert) ──────

interface ContentWatchdogAlertData {
  /** Human-readable flag lines, e.g. "Scheduler stalled: no healthy tick…". */
  flags: string[];
  /** Hours since the last healthy (non-error) tick, or null if none ever. */
  hoursSinceHealthyTick: number | null;
  /** Trailing-24h webhook delivery stats. */
  webhookAttempts: number;
  webhookFailures: number;
}

/**
 * US-869: alert the owner the moment the auto-publishing content engine
 * silently stalls or its publish webhooks start failing — a hands-off engine
 * is dangerous without a heartbeat. Categorized so a transient SMTP failure is
 * retried from the outbox (US-801).
 */
export async function sendContentWatchdogAlertEmail(
  to: string,
  data: ContentWatchdogAlertData,
): Promise<boolean> {
  const rows = data.flags
    .map(
      (f) => `
      <tr>
        <td style="padding: 8px 12px; border-bottom: 1px solid #eee; font-size: 13px; color:${BRAND_RED};">
          ${escapeHtml(f)}
        </td>
      </tr>`,
    )
    .join("");

  const failureRate = data.webhookAttempts > 0
    ? `${((data.webhookFailures / data.webhookAttempts) * 100).toFixed(1)}%`
    : "n/a";
  const tickAge = data.hoursSinceHealthyTick == null
    ? "never (no healthy tick on record)"
    : `${data.hoursSinceHealthyTick.toFixed(1)}h ago`;

  const content = `
    <div style="background:${BRAND_RED};color:#fff;padding:10px 16px;border-radius:8px;font-weight:700;font-size:14px;text-align:center;margin-bottom:20px;">
      Content engine watchdog — action needed
    </div>
    <h2 style="margin: 0 0 8px; color: ${BRAND_NIGHT}; font-size: 20px;">
      The auto-publishing engine needs a look
    </h2>
    <p style="margin: 0 0 16px; color: #666; font-size: 14px; line-height: 1.5;">
      The watchdog detected the content scheduler stalled and/or its publish
      webhooks are failing at an elevated rate. While this is unresolved, new
      posts may not be publishing or syndicating.
    </p>
    <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="margin: 0 0 20px;">
      ${rows}
    </table>
    <h3 style="margin: 0 0 8px; color: ${BRAND_NIGHT}; font-size: 15px;">Current state</h3>
    <ul style="margin: 0 0 16px; padding-left: 18px; color:#444; font-size: 13px; line-height: 1.7;">
      <li>Last healthy scheduler tick: <strong>${escapeHtml(tickAge)}</strong></li>
      <li>Webhook delivery (trailing 24h): <strong>${data.webhookFailures}/${data.webhookAttempts} failed (${failureRate})</strong></li>
    </ul>
    ${ctaButton("Open Content settings", `${SITE_URL}/admin/content`)}
  `;
  return await sendEmail({
    to,
    subject: "🔴 GradeThread content engine watchdog alert",
    html: emailLayout(content),
    category: "content_watchdog_alert", // US-801: durable retry on transient failure
  });
}

// ─── Ops activity-feed critical event (internal/ops alert, US-906) ──

interface OpsAlertData {
  type: string;
  severity: "info" | "warning" | "critical";
  title: string;
  data: Record<string, unknown>;
}

/**
 * US-906: alert ops when a significant platform event (job failure, AI budget
 * kill, fraud signal, billing divergence, maintenance toggle) fans out of the
 * activity feed. Goes through the same emailLayout/SMTP/outbox path as every
 * other admin alert; categorized 'ops_alert' so a transient SMTP failure is
 * retried/dead-lettered from the outbox (US-498).
 */
export async function sendOpsAlertEmail(
  to: string,
  data: OpsAlertData,
): Promise<boolean> {
  const isCritical = data.severity === "critical";
  const banner = isCritical ? BRAND_RED : "#eab308";
  // Render the structured payload as a compact key/value table.
  const rows = Object.entries(data.data)
    .map(([k, v]) => {
      const val = typeof v === "object" && v !== null ? JSON.stringify(v) : String(v);
      return `
      <tr>
        <td style="padding:6px 12px;border-bottom:1px solid #eee;font-size:12px;color:#888;width:38%;vertical-align:top;">${escapeHtml(k)}</td>
        <td style="padding:6px 12px;border-bottom:1px solid #eee;font-size:13px;color:#333;">${escapeHtml(val)}</td>
      </tr>`;
    })
    .join("");

  const content = `
    <div style="background:${banner};color:#fff;padding:10px 16px;border-radius:8px;font-weight:700;font-size:14px;text-align:center;margin-bottom:20px;">
      Ops event — ${escapeHtml(data.severity.toUpperCase())}
    </div>
    <h2 style="margin: 0 0 8px; color: ${BRAND_NIGHT}; font-size: 20px;">
      ${escapeHtml(data.title)}
    </h2>
    <p style="margin: 0 0 16px; color: #666; font-size: 13px; line-height: 1.5;">
      A <strong>${escapeHtml(data.type)}</strong> event was recorded on the platform
      activity feed and routed to this channel because it met the alert threshold.
    </p>
    ${rows ? `<table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="margin: 0 0 20px;">${rows}</table>` : ""}
    ${ctaButton("Open the activity feed", `${SITE_URL}/admin/ops/activity`)}
  `;
  return await sendEmail({
    to,
    subject: `${isCritical ? "🔴" : "🟡"} GradeThread ops alert: ${data.title}`,
    html: emailLayout(content),
    category: "ops_alert", // US-498: durable retry on transient SMTP failure
  });
}

// ─── Marketplace offer / return / dispute emails (US-1055) ──────────
//
// Time-sensitive seller events that were previously silent. Each is durable
// (category) so a transient SMTP failure is retried from the outbox (US-498),
// and surfaces the eBay-provided deadline where one exists (dispute respond-by).

interface OfferReceivedData {
  userName: string;
  itemTitle: string;
  amountLabel: string | null; // e.g. "$42.00", null when eBay omits a price
  buyerLabel: string | null; // buyer username, when present
  expiresAt: string | null; // offer expiry, when eBay provides it
}

export async function sendOfferReceivedEmail(
  to: string,
  data: OfferReceivedData,
): Promise<boolean> {
  const who = data.buyerLabel ? escapeHtml(data.buyerLabel) : "A buyer";
  const amount = data.amountLabel ? ` of <strong>${escapeHtml(data.amountLabel)}</strong>` : "";
  const expiry = data.expiresAt
    ? `<p style="margin: 0 0 16px; color: ${BRAND_RED}; font-size: 14px;">Respond before <strong>${formatDate(data.expiresAt)}</strong> — offers expire.</p>`
    : "";
  const content = `
    <h2 style="margin: 0 0 8px; color: ${BRAND_NIGHT}; font-size: 20px;">
      You have a new offer
    </h2>
    <p style="margin: 0 0 16px; color: #666; font-size: 15px; line-height: 1.5;">
      Hi ${escapeHtml(data.userName)}, ${who} sent an offer${amount} on
      <strong>"${escapeHtml(data.itemTitle)}"</strong>.
    </p>
    ${expiry}
    ${ctaButton("Review the offer", `${SITE_URL}/dashboard/flipdesk/offers`)}
  `;
  return await sendEmail({
    to,
    subject: `New offer on "${data.itemTitle}"`,
    html: emailLayout(content),
    category: "offer_received",
  });
}

interface OfferRespondedData {
  userName: string;
  itemTitle: string;
  action: "accepted" | "declined" | "countered";
}

export async function sendOfferRespondedEmail(
  to: string,
  data: OfferRespondedData,
): Promise<boolean> {
  const verb = data.action;
  const content = `
    <h2 style="margin: 0 0 8px; color: ${BRAND_NIGHT}; font-size: 20px;">
      Offer ${verb}
    </h2>
    <p style="margin: 0 0 16px; color: #666; font-size: 15px; line-height: 1.5;">
      Hi ${escapeHtml(data.userName)}, the offer on
      <strong>"${escapeHtml(data.itemTitle)}"</strong> was <strong>${verb}</strong>.
    </p>
    ${ctaButton("View offers", `${SITE_URL}/dashboard/flipdesk/offers`)}
  `;
  return await sendEmail({
    to,
    subject: `Offer ${verb}: "${data.itemTitle}"`,
    html: emailLayout(content),
    category: "offer_responded",
  });
}

interface ReturnOpenedData {
  userName: string;
  itemLabel: string; // item title or order id
  reason: string | null;
}

export async function sendReturnOpenedEmail(
  to: string,
  data: ReturnOpenedData,
): Promise<boolean> {
  const reason = data.reason
    ? `<p style="margin: 0 0 16px; color: #666; font-size: 14px;">Reason: <strong>${escapeHtml(data.reason)}</strong></p>`
    : "";
  const content = `
    <h2 style="margin: 0 0 8px; color: ${BRAND_NIGHT}; font-size: 20px;">
      A buyer opened a return
    </h2>
    <p style="margin: 0 0 16px; color: #666; font-size: 15px; line-height: 1.5;">
      Hi ${escapeHtml(data.userName)}, a return was opened on
      <strong>${escapeHtml(data.itemLabel)}</strong>. Review and respond promptly —
      eBay holds you to a response window.
    </p>
    ${reason}
    ${ctaButton("Manage the return", `${SITE_URL}/dashboard/flipdesk/post-sale`)}
  `;
  return await sendEmail({
    to,
    subject: `Return opened: ${data.itemLabel}`,
    html: emailLayout(content),
    category: "return_opened",
  });
}

interface DisputeOpenedData {
  userName: string;
  orderLabel: string; // order id or item
  reason: string | null;
  amountLabel: string | null; // e.g. "$80.00"
  respondByDate: string | null; // the deadline that matters
}

export async function sendDisputeOpenedEmail(
  to: string,
  data: DisputeOpenedData,
): Promise<boolean> {
  const amount = data.amountLabel ? ` for <strong>${escapeHtml(data.amountLabel)}</strong>` : "";
  const reason = data.reason
    ? `<p style="margin: 0 0 8px; color: #666; font-size: 14px;">Reason: <strong>${escapeHtml(data.reason)}</strong></p>`
    : "";
  const deadline = data.respondByDate
    ? `<div style="background:${BRAND_RED};color:#fff;padding:10px 16px;border-radius:8px;font-weight:700;font-size:14px;text-align:center;margin:0 0 16px;">
        Respond by ${formatDate(data.respondByDate)} or eBay decides against you
      </div>`
    : "";
  const content = `
    <h2 style="margin: 0 0 8px; color: ${BRAND_NIGHT}; font-size: 20px;">
      A payment dispute was opened
    </h2>
    <p style="margin: 0 0 16px; color: #666; font-size: 15px; line-height: 1.5;">
      Hi ${escapeHtml(data.userName)}, a buyer opened a payment dispute${amount} on
      order <strong>${escapeHtml(data.orderLabel)}</strong>.
    </p>
    ${reason}
    ${deadline}
    ${ctaButton("Respond to the dispute", `${SITE_URL}/dashboard/flipdesk/post-sale`)}
  `;
  return await sendEmail({
    to,
    subject: `Action needed — payment dispute on ${data.orderLabel}`,
    html: emailLayout(content),
    category: "dispute_opened",
  });
}

// ─── AI cost budget guardrail breach (internal/owner alert) ─────────

interface AiBudgetAlertData {
  feature: string;
  period: "day" | "month";
  action: "alert" | "throttle" | "kill";
  limitUsd: number;
  spendUsd: number;
  /** Whether the matching feature kill-switch was auto-flipped off. */
  killed: boolean;
  flagKey: string | null;
}

/**
 * US-895: alert ops the moment a per-feature AI spend budget is breached — and,
 * for action=kill, that the feature was auto-disabled to stop the bleed. Goes
 * through the same emailLayout/SMTP/outbox path as every other admin alert;
 * categorized so a transient SMTP failure retries (US-801).
 */
export async function sendAiBudgetAlertEmail(
  to: string,
  data: AiBudgetAlertData,
): Promise<boolean> {
  const usd = (n: number) =>
    n.toLocaleString(undefined, { style: "currency", currency: "USD" });
  const banner = data.killed ? BRAND_RED : "#eab308";
  const headline = data.killed
    ? `AI feature "${data.feature}" auto-disabled — budget exceeded`
    : `AI spend budget exceeded — ${data.feature}`;

  const content = `
    <div style="background:${banner};color:#fff;padding:10px 16px;border-radius:8px;font-weight:700;font-size:14px;text-align:center;margin-bottom:20px;">
      AI cost guardrail — ${data.killed ? "FEATURE KILLED" : "BUDGET BREACH"}
    </div>
    <h2 style="margin: 0 0 8px; color: ${BRAND_NIGHT}; font-size: 20px;">
      ${escapeHtml(headline)}
    </h2>
    <p style="margin: 0 0 16px; color: #666; font-size: 14px; line-height: 1.5;">
      ${
    data.killed
      ? `The <strong>${escapeHtml(data.period)}</strong> AI spend budget for <strong>${escapeHtml(data.feature)}</strong> was exceeded, so the guardrail flipped the <code>${escapeHtml(data.flagKey ?? data.feature)}</code> feature kill-switch <strong>off</strong> to stop further Claude spend. Investigate, then re-enable it from the AI Spend page.`
      : `The <strong>${escapeHtml(data.period)}</strong> AI spend budget for <strong>${escapeHtml(data.feature)}</strong> was exceeded. No feature was auto-disabled (action: ${escapeHtml(data.action)}) — review usage on the AI Spend page.`
  }
    </p>
    <ul style="margin: 0 0 16px; padding-left: 18px; color:#444; font-size: 13px; line-height: 1.7;">
      <li>Feature: <strong>${escapeHtml(data.feature)}</strong></li>
      <li>Period: <strong>${escapeHtml(data.period)}</strong></li>
      <li>Budget: <strong>${usd(data.limitUsd)}</strong></li>
      <li>Spend: <strong>${usd(data.spendUsd)}</strong></li>
      <li>Action: <strong>${escapeHtml(data.action)}</strong>${data.killed ? " (kill-switch flipped off)" : ""}</li>
    </ul>
    ${ctaButton("Open AI Spend dashboard", `${SITE_URL}/admin/ai-spend`)}
  `;
  return await sendEmail({
    to,
    subject: `${data.killed ? "🔴" : "🟡"} GradeThread AI budget breach — ${data.feature} (${data.period})`,
    html: emailLayout(content),
    category: "ai_budget_alert", // US-801: durable retry on transient failure
  });
}

// ─── Weekly content digest (US-880) ─────────────────────────────────

interface ContentDigestRecommendation {
  title: string;
  detail: string;
  action_label: string;
  // Relative admin path (e.g. "/admin/content/settings"); prefixed with SITE_URL.
  action_path: string;
}

interface ContentDigestData {
  windowDays: number;
  generatedAt: string;
  published: { blog: number; social: number; total: number };
  topics: { added: number; used: number };
  webhooks: { total: number; succeeded: number; failed: number; successRate: number };
  refreshedPosts: number;
  bankLow: Array<{ surface: string; product_focus: string; queued: number; min: number }>;
  contentGaps: Array<{ query: string; impressions: number }>;
  recommendations: ContentDigestRecommendation[];
}

/**
 * US-880: deliver the weekly content-engine readout the /scheduler/summary
 * endpoint already computes, plus the structured tuning recommendations, each
 * linking back into the admin content UI so the owner can act in one click.
 * Goes through the same emailLayout/SMTP/outbox path as every other admin
 * notification; categorized so a transient SMTP failure retries (US-801).
 */
export async function sendContentDigestEmail(
  to: string,
  data: ContentDigestData,
): Promise<boolean> {
  const pct = (n: number) => `${Math.round(n * 100)}%`;

  const statRow = (label: string, value: string) => `
    <tr>
      <td style="padding: 8px 12px; border-bottom: 1px solid #eee; font-size: 14px; color:#666;">${escapeHtml(label)}</td>
      <td style="padding: 8px 12px; border-bottom: 1px solid #eee; font-size: 14px; font-weight:600; color:${BRAND_NAVY}; text-align:right;">${escapeHtml(value)}</td>
    </tr>`;

  const stats = `
    <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="margin: 0 0 20px;">
      ${statRow("Published (blog / social)", `${data.published.blog} / ${data.published.social}`)}
      ${statRow("Topics added / used", `${data.topics.added} / ${data.topics.used}`)}
      ${statRow("Webhook success rate", data.webhooks.total > 0 ? `${pct(data.webhooks.successRate)} (${data.webhooks.failed} failed)` : "no deliveries")}
      ${statRow("Posts refreshed", `${data.refreshedPosts}`)}
    </table>`;

  const bankBlock = data.bankLow.length === 0 ? "" : `
    <h3 style="margin: 0 0 8px; color: ${BRAND_NIGHT}; font-size: 15px;">Topic banks below minimum</h3>
    <ul style="margin: 0 0 16px; padding-left: 18px; color:#444; font-size: 13px; line-height: 1.7;">
      ${data.bankLow.map((b) => `<li>${escapeHtml(`${b.surface} / ${b.product_focus}`)}: <strong>${b.queued}/${b.min}</strong></li>`).join("")}
    </ul>`;

  const gapsBlock = data.contentGaps.length === 0 ? "" : `
    <h3 style="margin: 0 0 8px; color: ${BRAND_NIGHT}; font-size: 15px;">Top search opportunities</h3>
    <ul style="margin: 0 0 16px; padding-left: 18px; color:#444; font-size: 13px; line-height: 1.7;">
      ${data.contentGaps.slice(0, 5).map((g) => `<li>${escapeHtml(g.query)} — <strong>${g.impressions}</strong> impressions, no dedicated post</li>`).join("")}
    </ul>`;

  const recsBlock = data.recommendations.length === 0
    ? `<p style="margin: 0 0 16px; color:#2e7d32; font-size: 14px;">No tuning needed this week — the engine is healthy. ✅</p>`
    : data.recommendations.map((r) => `
      <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="margin: 0 0 12px; background:${BRAND_GRAY}; border-radius: 8px;">
        <tr><td style="padding: 12px 14px;">
          <p style="margin: 0 0 4px; font-size: 14px; font-weight: 700; color:${BRAND_NIGHT};">${escapeHtml(r.title)}</p>
          <p style="margin: 0 0 8px; font-size: 13px; color:#555; line-height: 1.5;">${escapeHtml(r.detail)}</p>
          <a href="${SITE_URL}${escapeHtml(r.action_path)}" style="font-size: 13px; font-weight: 600; color:${BRAND_RED}; text-decoration: underline;">${escapeHtml(r.action_label)} →</a>
        </td></tr>
      </table>`).join("");

  const content = `
    <div style="background:${BRAND_NAVY};color:#fff;padding:10px 16px;border-radius:8px;font-weight:700;font-size:14px;text-align:center;margin-bottom:20px;">
      Weekly content digest
    </div>
    <h2 style="margin: 0 0 8px; color: ${BRAND_NIGHT}; font-size: 20px;">
      Your content engine over the last ${data.windowDays} days
    </h2>
    <p style="margin: 0 0 16px; color: #666; font-size: 14px; line-height: 1.5;">
      A readout of what the autonomous engine published, the state of its topic
      banks and webhooks, and the specific tuning actions worth taking — each
      linking straight into the admin content tools.
    </p>
    ${stats}
    ${bankBlock}
    ${gapsBlock}
    <h3 style="margin: 0 0 12px; color: ${BRAND_NIGHT}; font-size: 16px;">Recommendations</h3>
    ${recsBlock}
    ${ctaButton("Open content analytics", `${SITE_URL}/admin/content/analytics`)}
  `;
  return await sendEmail({
    to,
    subject: `📊 GradeThread weekly content digest (${data.published.total} published)`,
    html: emailLayout(content),
    category: "content_digest", // US-880: durable retry on transient SMTP failure
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

// ─── Support-assistant abuse lockout (internal/admin alert) ─────────

interface SupportAbuseAlertData {
  userEmail: string;
  userId: string;
  reason: string;
  cooldownMinutes: number;
  lockoutCount: number;
}

/**
 * US-836: alert the platform admin that the abuse pipeline locked a user out of
 * the support assistant (graduated cooldown). Categorized so a transient SMTP
 * failure is retried from the outbox (US-801).
 */
export async function sendSupportAbuseAlertEmail(
  to: string,
  data: SupportAbuseAlertData,
): Promise<boolean> {
  const content = `
    <div style="background:${BRAND_RED};color:#fff;padding:10px 16px;border-radius:8px;font-weight:700;font-size:14px;text-align:center;margin-bottom:20px;">
      Support assistant abuse lockout
    </div>
    <h2 style="margin: 0 0 8px; color: ${BRAND_NIGHT}; font-size: 20px;">
      A user was locked out of the support assistant
    </h2>
    <p style="margin: 0 0 16px; color: #666; font-size: 15px; line-height: 1.5;">
      The abuse pipeline automatically paused this user's access for
      <strong>${data.cooldownMinutes} minute${data.cooldownMinutes === 1 ? "" : "s"}</strong>
      (lockout #${data.lockoutCount}).
    </p>
    <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="margin: 0 0 8px;">
      <tr>
        <td style="padding: 12px; background:${BRAND_GRAY}; border-radius: 8px; font-size: 14px; color:#333;">
          <span style="color:#666;font-size:12px;">User</span><br>
          ${escapeHtml(data.userEmail)} <span style="color:#999;">(${escapeHtml(data.userId)})</span>
          <br><br>
          <span style="color:#666;font-size:12px;">Trigger</span><br>
          ${escapeHtml(data.reason)}
        </td>
      </tr>
    </table>
    ${ctaButton("Open admin dashboard", `${SITE_URL}/admin`)}
  `;
  return await sendEmail({
    to,
    subject: `🔒 Support assistant lockout: ${data.userEmail}`,
    html: emailLayout(content),
    category: "support_abuse_alert", // US-801: durable retry on transient failure
  });
}

// ─── Audit-log anomaly alert (internal/admin alert) ────────────────

interface AuditAnomalyAlertData {
  detector: string;
  severity: string;
  eventCount: number;
  window: string;
  actorLabel: string | null;
  summary: string;
}

/**
 * US-905: alert the platform admin that the scheduled audit-log scan flagged a
 * suspicious pattern (role-change burst, mass refunds, off-hours destructive
 * actions). Categorized so a transient SMTP failure is retried from the outbox
 * (US-801).
 */
export async function sendAuditAnomalyAlertEmail(
  to: string,
  data: AuditAnomalyAlertData,
): Promise<boolean> {
  const banner = data.severity === "critical" ? BRAND_RED : "#eab308";
  const content = `
    <div style="background:${banner};color:#fff;padding:10px 16px;border-radius:8px;font-weight:700;font-size:14px;text-align:center;margin-bottom:20px;">
      Audit anomaly — ${escapeHtml(data.severity.toUpperCase())}
    </div>
    <h2 style="margin: 0 0 8px; color: ${BRAND_NIGHT}; font-size: 20px;">
      ${escapeHtml(data.summary)}
    </h2>
    <p style="margin: 0 0 16px; color: #666; font-size: 15px; line-height: 1.5;">
      The scheduled audit-log scan flagged
      <strong>${data.eventCount}</strong> qualifying action${data.eventCount === 1 ? "" : "s"}
      in the <strong>${escapeHtml(data.window)}</strong> window. Review the audit
      log and confirm the activity is expected.
    </p>
    <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="margin: 0 0 8px;">
      <tr>
        <td style="padding: 12px; background:${BRAND_GRAY}; border-radius: 8px; font-size: 14px; color:#333;">
          <span style="color:#666;font-size:12px;">Detector</span><br>
          ${escapeHtml(data.detector)}
          <br><br>
          <span style="color:#666;font-size:12px;">Acting admin</span><br>
          ${data.actorLabel ? escapeHtml(data.actorLabel) : "Multiple / platform-wide"}
        </td>
      </tr>
    </table>
    ${ctaButton("Open audit log", `${SITE_URL}/admin/audit-log`)}
  `;
  return await sendEmail({
    to,
    subject: `${data.severity === "critical" ? "🔴" : "🟡"} GradeThread audit anomaly — ${data.detector}`,
    html: emailLayout(content),
    category: "audit_anomaly_alert", // US-801: durable retry on transient failure
  });
}

// ─── Support-assistant human escalation (internal/admin alert) ──────

interface SupportEscalationData {
  userEmail: string;
  userId: string;
  conversationId: string;
  reason: string;
  summary: string;
  /** 'model' (the bot escalated) or 'auto' (a failed-turn threshold tripped). */
  trigger: string;
}

/**
 * US-837: alert the human support team that the assistant handed a conversation
 * off to a person, with a deep link to the escalated thread in the admin inbox
 * (US-839). Categorized so a transient SMTP failure is retried from the outbox
 * (US-801).
 */
export async function sendSupportEscalationEmail(
  to: string,
  data: SupportEscalationData,
): Promise<boolean> {
  const triggerLabel = data.trigger === "auto"
    ? "Auto-escalated (the assistant could not resolve it)"
    : "The assistant escalated this conversation";
  const content = `
    <div style="background:${BRAND_NIGHT};color:#fff;padding:10px 16px;border-radius:8px;font-weight:700;font-size:14px;text-align:center;margin-bottom:20px;">
      Support conversation escalated to a human
    </div>
    <h2 style="margin: 0 0 8px; color: ${BRAND_NIGHT}; font-size: 20px;">
      ${escapeHtml(triggerLabel)}
    </h2>
    <p style="margin: 0 0 16px; color: #666; font-size: 15px; line-height: 1.5;">
      A support conversation needs a human follow-up.
    </p>
    <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="margin: 0 0 8px;">
      <tr>
        <td style="padding: 12px; background:${BRAND_GRAY}; border-radius: 8px; font-size: 14px; color:#333;">
          <span style="color:#666;font-size:12px;">User</span><br>
          ${escapeHtml(data.userEmail)} <span style="color:#999;">(${escapeHtml(data.userId)})</span>
          <br><br>
          <span style="color:#666;font-size:12px;">Reason</span><br>
          ${escapeHtml(data.reason)}
          <br><br>
          <span style="color:#666;font-size:12px;">Summary</span><br>
          ${escapeHtml(data.summary)}
        </td>
      </tr>
    </table>
    ${ctaButton("Open the conversation", `${SITE_URL}/admin/support/${data.conversationId}`)}
  `;
  return await sendEmail({
    to,
    subject: `🙋 Support escalation: ${data.userEmail}`,
    html: emailLayout(content),
    category: "support_escalation", // US-801: durable retry on transient failure
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

// ─── Durable, tracked drip-step send (US-938) ───────────────────────

export interface TrackedDripEmailOptions {
  to: string;
  subject: string;
  /** Inner content fragment (a rendered drip step) — wrapped in the branded
   * marketing layout, which carries the CAN-SPAM postal address + unsubscribe. */
  contentHtml: string;
  /** `drip:<campaign>:<step>` — drives outbox categorization + dead-lettering. */
  category: string;
  /** No-login CAN-SPAM unsubscribe link (US-516) rendered in the footer. */
  unsubscribeUrl?: string;
  /** Open/click tracking (US-913): rewrites links + injects a pixel keyed to the
   * drip_sends row id (`token`) so opens/clicks land back on that send. */
  tracking?: { baseUrl: string; token: string };
}

export interface TrackedDripEmailResult {
  /** SMTP accepted the live attempt. */
  delivered: boolean;
  /** Live attempt failed → persisted to the email_deliveries outbox for the
   * backoff retry cron to re-attempt (and dead-letter after max attempts). */
  enqueued: boolean;
}

/**
 * Marketing-class send for ONE drip step that goes through the SAME durable
 * outbox + suppression path as the rest of the engine, but adds the open/click
 * tracking rewriter (US-913) and is categorized per (campaign, step) so a
 * transient SMTP failure is retried/dead-lettered from email_deliveries
 * (US-498/US-925). The plaintext alternative is generated by the SMTP "auto"
 * multipart in deliverEmail; the CAN-SPAM footer + one-click unsubscribe come
 * from emailLayout's marketing footer. Suppression (US-914) is enforced inside
 * deliverEmail, and again (recorded) by the engine before this is ever called.
 *
 * Intentionally NOT a transactional `send*Email` — like sendBroadcastEmail it is
 * marketing/bulk, so it carries its own per-send tracking instead of riding the
 * transactional categorization convention.
 */
export async function sendDripStepEmail(
  opts: TrackedDripEmailOptions,
): Promise<TrackedDripEmailResult> {
  let html = emailLayout(opts.contentHtml, { unsubscribeUrl: opts.unsubscribeUrl });
  if (opts.tracking) {
    html = applyEmailTracking(html, opts.tracking.baseUrl, opts.tracking.token);
  }
  const message: EmailOptions = {
    to: opts.to,
    subject: opts.subject,
    html,
    category: opts.category,
  };

  const delivered = await deliverEmail(message);
  if (delivered) return { delivered: true, enqueued: false };

  // Durable retry: persist to the outbox so the retry cron re-attempts with
  // backoff and dead-letters after max attempts (US-498/US-925).
  await enqueueFailedEmail(message, opts.category);
  return { delivered: false, enqueued: true };
}

// ─── Lifecycle email journeys (US-929) ──────────────────────────────────────

/**
 * US-929: wrap a journey step's content fragment in the shared branded layout
 * (header/footer + CAN-SPAM postal address). Pass `unsubscribeUrl` for a
 * MARKETING journey (nurture / win-back) so the one-click unsubscribe footer
 * renders; omit it for a lifecycle-TRANSACTIONAL journey (welcome). The fully
 * rendered HTML is then handed to coordinateMarketingSend (marketing) or sent
 * durably via sendJourneyTransactionalEmail (transactional).
 */
export function buildJourneyEmailHtml(
  contentHtml: string,
  opts: { unsubscribeUrl?: string } = {},
): string {
  return emailLayout(contentHtml, opts);
}

/**
 * US-929: durable send for a lifecycle-TRANSACTIONAL journey step (e.g. the
 * welcome series). Like every transactional email it is never frequency-capped
 * and carries no marketing unsubscribe link, but it goes through the same
 * suppression check + email_deliveries outbox retry as the rest of the
 * transactional mail. `contentHtml` is the inner fragment (rendered by
 * renderJourneyStep); this wraps it in the branded layout. Returns whether SMTP
 * accepted the live attempt (a failure is enqueued for backoff retry).
 */
export async function sendJourneyTransactionalEmail(opts: {
  to: string;
  subject: string;
  contentHtml: string;
  category: string;
}): Promise<boolean> {
  return await sendEmail({
    to: opts.to,
    subject: opts.subject,
    html: emailLayout(opts.contentHtml),
    category: opts.category,
  });
}

/**
 * Ad-hoc operator → customer message (US-582). This is TRANSACTIONAL support /
 * account mail: it omits the marketing unsubscribe link (you cannot opt out of
 * service comms about your own account) but still carries the CAN-SPAM postal
 * address via the standard transactional footer. The admin route gates this so
 * it is ONLY ever used for transactional support/account communication, never
 * marketing — that distinction is what keeps the no-unsubscribe footer compliant.
 */
export async function sendAdminMessageEmail(
  to: string,
  data: AdminMessageData,
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
    <p style="margin: 0 0 16px; color: #666; font-size: 15px; line-height: 1.5;">
      Hi ${escapeHtml(data.userName)},
    </p>
    <h2 style="margin: 0 0 16px; color: ${BRAND_NIGHT}; font-size: 20px;">
      ${escapeHtml(data.subject)}
    </h2>
    ${paragraphs}
    ${data.ctaLabel && data.ctaUrl ? ctaButton(data.ctaLabel, data.ctaUrl) : ""}
    <p style="margin: 24px 0 0; color: #999; font-size: 13px; line-height: 1.5;">
      This is a service message from the GradeThread support team regarding your
      account. If you have questions, just reply to this email.
    </p>
  `;

  return await sendEmail({
    to,
    subject: data.subject,
    html: emailLayout(content),
    category: "admin_message", // US-582: durable retry on transient SMTP failure
  });
}

/**
 * Cross-source sync conflicts crossed the user's threshold (US-148): FlipDesk,
 * eBay, and the Google Sheet disagree on enough listings to warrant a review.
 */
export async function sendSyncConflictsEmail(
  to: string,
  data: { userName: string; openCount: number; threshold: number },
): Promise<boolean> {
  const reviewUrl = `${SITE_URL}/dashboard/flipdesk/reconciliation`;

  const content = `
    <h2 style="margin: 0 0 8px; color: ${BRAND_NIGHT}; font-size: 20px;">
      Sync Conflicts Need Your Review
    </h2>
    <p style="margin: 0 0 24px; color: #666; font-size: 15px; line-height: 1.5;">
      Hi ${escapeHtml(data.userName)}, your listings now have
      <strong>${data.openCount} open cross-source conflict${data.openCount === 1 ? "" : "s"}</strong>
      — places where FlipDesk, eBay, and your Google Sheet disagree on price,
      quantity, status, or title. That's at or above your alert threshold of
      ${data.threshold}.
    </p>
    <p style="margin: 0 0 8px; color: #666; font-size: 14px; line-height: 1.5; text-align: center;">
      Review each conflict and pick which source wins — per field or in bulk.
    </p>
    ${ctaButton("Review Conflicts", reviewUrl)}
    <p style="margin: 0; color: #999; font-size: 13px; text-align: center;">
      Adjust or disable this alert on the Cross-source tab of the Reconciliation page.
    </p>
  `;

  return await sendEmail({
    to,
    subject: `${data.openCount} sync conflict${data.openCount === 1 ? "" : "s"} need review — FlipDesk, eBay & Sheets disagree`,
    html: emailLayout(content),
  });
}
