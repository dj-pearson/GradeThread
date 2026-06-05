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

const BRAND_NAVY = "#0F3460";
const BRAND_RED = "#E94560";
const BRAND_NIGHT = "#1A1A2E";
const BRAND_GRAY = "#F5F5F5";
const SITE_URL = "https://gradethread.com";

// ─── Types ──────────────────────────────────────────────────────────

interface EmailOptions {
  to: string;
  subject: string;
  html: string;
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

async function sendEmail(options: EmailOptions): Promise<boolean> {
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

// ─── HTML Layout ────────────────────────────────────────────────────

function emailLayout(content: string, unsubscribe: boolean = false): string {
  const unsubscribeSection = unsubscribe
    ? `<tr>
        <td style="padding: 16px 32px; text-align: center;">
          <a href="${SITE_URL}/dashboard/settings" style="color: #999; font-size: 12px; text-decoration: underline;">
            Manage email preferences
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
    html: emailLayout(content, true),
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
  return await sendEmail({
    to,
    subject: `${data.daysLeft} day${data.daysLeft === 1 ? "" : "s"} left on your FlipDesk Pro trial`,
    html: emailLayout(content),
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

// ─── Broadcast / marketing email (US-572) ───────────────────────────

interface BroadcastEmailData {
  subject: string;
  /** Plain-text body; blank lines split paragraphs, single newlines → <br>. */
  body: string;
  ctaLabel?: string | null;
  ctaUrl?: string | null;
}

/**
 * Campaign broadcast email. Unlike the transactional senders this always
 * carries the manage-preferences footer (US-572) so a recipient can opt out of
 * marketing. The send engine only calls this for users who have NOT opted out.
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

  return await sendEmail({
    to,
    subject: data.subject,
    html: emailLayout(content, true),
  });
}
