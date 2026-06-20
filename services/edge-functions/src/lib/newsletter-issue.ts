// US-930: newsletter issue lifecycle + rendering — PURE helpers (no supabase /
// env / network imports) so the admin console's status machine, HTML render, and
// next-scheduled-run computation are unit-testable without a DB and reusable from
// both the route handlers and the (future) autonomous engine.

export const NEWSLETTER_STATUSES = [
  "draft",
  "ready_for_qa",
  "approved",
  "awaiting_review",
  "sending",
  "sent",
  "blocked",
] as const;

export type NewsletterStatus = (typeof NEWSLETTER_STATUSES)[number];

export function isNewsletterStatus(v: unknown): v is NewsletterStatus {
  return typeof v === "string" && (NEWSLETTER_STATUSES as readonly string[]).includes(v);
}

// Allowed status transitions the console drives. `blocked` is reachable from any
// non-terminal state (the kill-switch / operator reject) and reopens to `draft`.
const TRANSITIONS: Record<NewsletterStatus, NewsletterStatus[]> = {
  draft: ["ready_for_qa", "blocked"],
  ready_for_qa: ["awaiting_review", "approved", "draft", "blocked"],
  awaiting_review: ["approved", "draft", "blocked"],
  approved: ["sending", "draft", "blocked"],
  sending: ["sent", "blocked"],
  sent: [], // terminal
  blocked: ["draft"],
};

export function canTransition(from: NewsletterStatus, to: NewsletterStatus): boolean {
  return TRANSITIONS[from]?.includes(to) ?? false;
}

// Subject/sections may be edited only before the issue is locked for sending.
export function isEditable(status: NewsletterStatus): boolean {
  return (
    status === "draft" ||
    status === "ready_for_qa" ||
    status === "awaiting_review" ||
    status === "approved"
  );
}

// ── Rendering ────────────────────────────────────────────────────────────────

export interface NewsletterSection {
  heading?: string;
  /** Pre-sanitized operator/AI-authored HTML for the block body. */
  body: string;
  ctaLabel?: string;
  ctaUrl?: string;
}

export interface RenderableIssue {
  subject: string;
  preheader?: string | null;
  sections: NewsletterSection[];
}

export interface RenderOptions {
  /** Footer unsubscribe link (one-click, no-login). Omitted for raw previews. */
  unsubscribeUrl?: string;
  /** CAN-SPAM physical postal address. */
  postalAddress?: string;
  siteUrl?: string;
  year?: number;
}

const BRAND_NAVY = "#0F3460";
const BRAND_RED = "#E94560";
const BRAND_NIGHT = "#1A1A2E";
const BRAND_GRAY = "#F5F5F5";

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function ctaButton(label: string, url: string): string {
  return `<table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin: 20px auto;">
    <tr>
      <td style="background-color: ${BRAND_RED}; border-radius: 8px;">
        <a href="${escapeHtml(url)}" style="display: inline-block; padding: 12px 28px; color: #ffffff; text-decoration: none; font-size: 15px; font-weight: 600;">
          ${escapeHtml(label)}
        </a>
      </td>
    </tr>
  </table>`;
}

function renderSection(s: NewsletterSection): string {
  const heading = s.heading
    ? `<h2 style="margin: 0 0 8px; color: ${BRAND_NIGHT}; font-size: 18px; font-weight: 700;">${escapeHtml(s.heading)}</h2>`
    : "";
  const body = `<div style="margin: 0 0 8px; color: #333333; font-size: 15px; line-height: 1.6;">${s.body ?? ""}</div>`;
  const cta = s.ctaLabel && s.ctaUrl ? ctaButton(s.ctaLabel, s.ctaUrl) : "";
  return `<div style="margin-bottom: 24px;">${heading}${body}${cta}</div>`;
}

/**
 * Render a newsletter issue to a complete, send-ready HTML document — brand
 * layout + every section + a CAN-SPAM footer (postal address) + the unsubscribe
 * link when supplied. The marketing coordinator expects fully-rendered HTML, so
 * everything is baked in here.
 */
export function renderNewsletterHtml(issue: RenderableIssue, opts: RenderOptions = {}): string {
  const site = opts.siteUrl ?? "https://gradethread.com";
  const year = opts.year ?? 2026;
  const preheader = issue.preheader
    ? `<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${escapeHtml(issue.preheader)}</div>`
    : "";
  const content = (issue.sections ?? []).map(renderSection).join("");
  const postal = opts.postalAddress
    ? `<p style="margin: 8px 0 0; color: rgba(255,255,255,0.4); font-size: 11px;">${escapeHtml(opts.postalAddress)}</p>`
    : "";
  const unsubscribe = opts.unsubscribeUrl
    ? `<tr>
        <td style="padding: 16px 32px; text-align: center;">
          <a href="${escapeHtml(opts.unsubscribeUrl)}" style="color: #999; font-size: 12px; text-decoration: underline;">
            Unsubscribe from this newsletter
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
  ${preheader}
  <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="background-color: ${BRAND_GRAY};">
    <tr>
      <td style="padding: 32px 16px;">
        <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="600" style="margin: 0 auto; max-width: 600px;">
          <tr>
            <td style="background-color: ${BRAND_NAVY}; padding: 24px 32px; border-radius: 12px 12px 0 0; text-align: center;">
              <h1 style="margin: 0; color: #ffffff; font-size: 24px; font-weight: 700; letter-spacing: -0.5px;">GradeThread</h1>
              <p style="margin: 4px 0 0; color: rgba(255,255,255,0.7); font-size: 13px;">AI-Powered Clothing Condition Grading</p>
            </td>
          </tr>
          <tr>
            <td style="background-color: #ffffff; padding: 32px;">
              ${content}
            </td>
          </tr>
          <tr>
            <td style="background-color: ${BRAND_NIGHT}; padding: 20px 32px; border-radius: 0 0 12px 12px; text-align: center;">
              <p style="margin: 0; color: rgba(255,255,255,0.6); font-size: 12px;">&copy; ${year} Pearson Media LLC. All rights reserved.</p>
              <p style="margin: 8px 0 0; color: rgba(255,255,255,0.4); font-size: 11px;">
                <a href="${escapeHtml(site)}" style="color: rgba(255,255,255,0.6); text-decoration: none;">gradethread.com</a>
              </p>
              ${postal}
            </td>
          </tr>
          ${unsubscribe}
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

// ── QA ───────────────────────────────────────────────────────────────────────

export interface QaCheck {
  id: string;
  label: string;
  passed: boolean;
  detail?: string;
}

export interface QaReport {
  passed: boolean;
  checks: QaCheck[];
  ranAt?: string;
}

/**
 * Lightweight pre-send QA on a draft issue (pure). Catches the obvious blockers
 * before an issue can advance toward sending: a missing subject, no content, a
 * section missing its body, or a CTA missing its URL.
 */
export function runIssueQa(issue: RenderableIssue): QaReport {
  const sections = issue.sections ?? [];
  const checks: QaCheck[] = [
    {
      id: "subject",
      label: "Subject line is present",
      passed: typeof issue.subject === "string" && issue.subject.trim().length > 0,
    },
    {
      id: "subject_length",
      label: "Subject line is a sensible length (≤ 120 chars)",
      passed: (issue.subject ?? "").trim().length <= 120,
    },
    {
      id: "has_content",
      label: "Issue has at least one content section",
      passed: sections.length > 0,
    },
    {
      id: "section_bodies",
      label: "Every section has body content",
      passed: sections.every((s) => typeof s.body === "string" && s.body.trim().length > 0),
    },
    {
      id: "cta_urls",
      label: "Every CTA has both a label and a URL",
      passed: sections.every((s) => (!s.ctaLabel && !s.ctaUrl) || (!!s.ctaLabel && !!s.ctaUrl)),
    },
  ];
  return { passed: checks.every((c) => c.passed), checks };
}

// ── Scheduling ───────────────────────────────────────────────────────────────

export interface ScheduledIssue {
  status: NewsletterStatus;
  scheduledFor: string | null;
}

/**
 * The next scheduled program run = the earliest future `scheduled_for` among
 * issues that are still queued to send (not already sent/blocked/sending).
 * Returns an ISO string or null. Pure (takes `nowMs`).
 */
export function nextScheduledRun(issues: ScheduledIssue[], nowMs: number): string | null {
  const candidates: number[] = [];
  for (const i of issues) {
    if (i.status === "sent" || i.status === "blocked" || i.status === "sending") continue;
    if (!i.scheduledFor) continue;
    const t = Date.parse(i.scheduledFor);
    if (Number.isFinite(t) && t >= nowMs) candidates.push(t);
  }
  if (candidates.length === 0) return null;
  return new Date(Math.min(...candidates)).toISOString();
}
