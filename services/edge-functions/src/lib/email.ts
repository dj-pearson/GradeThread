/**
 * Email notification utility using Resend API.
 * Sends branded transactional emails for grade completions,
 * dispute resolutions, and welcome messages.
 */

const RESEND_API_URL = "https://api.resend.com/emails";
const FROM_EMAIL = "GradeThread <notifications@gradethread.com>";
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
  const apiKey = Deno.env.get("RESEND_API_KEY");
  if (!apiKey) {
    console.warn("[Email] RESEND_API_KEY not configured, skipping email send");
    return false;
  }

  try {
    const response = await fetch(RESEND_API_URL, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: FROM_EMAIL,
        to: [options.to],
        subject: options.subject,
        html: options.html,
      }),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      console.error(`[Email] Resend API error (${response.status}): ${errorBody}`);
      return false;
    }

    const result = await response.json();
    console.log(`[Email] Sent successfully to ${options.to} | id=${result.id}`);
    return true;
  } catch (error) {
    console.error(
      "[Email] Failed to send:",
      error instanceof Error ? error.message : String(error)
    );
    return false;
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

  return sendEmail({
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

  return sendEmail({
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
      Your free plan includes 5 grades per month. Upgrade anytime for more.
    </p>

    ${ctaButton("Go to Dashboard", `${SITE_URL}/dashboard`)}
  `;

  return sendEmail({
    to,
    subject: "Welcome to GradeThread — Start Grading with AI",
    html: emailLayout(content, true),
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
