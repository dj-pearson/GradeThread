// US-930: newsletter issue lifecycle + rendering — PURE helpers (no supabase /
// env / network imports) so the admin console's status machine, HTML render, and
// next-scheduled-run computation are unit-testable without a DB and reusable from
// both the route handlers and the (future) autonomous engine.
//
// US-919: the HTML/plaintext rendering now delegates to the bulletproof,
// email-client-safe modular engine in `email-render.ts` (table layout, inline
// CSS, MSO/Outlook buttons, dark-mode + responsive, absolute links). This file
// keeps the issue lifecycle / QA / scheduling helpers + the legacy render API.

import { renderNewsletterEmail, renderNewsletterEmailText } from "./email-render.ts";

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
  /** Email-preference-center link (manage cadence/topics) — US-924 compliance. */
  preferenceCenterUrl?: string;
  /** CAN-SPAM physical postal address. */
  postalAddress?: string;
  siteUrl?: string;
  year?: number;
}

// escapeHtml now lives in the render engine; re-exported here so the modules that
// already import it from this file keep their single import surface.
export { escapeHtml } from "./email-render.ts";

/**
 * Render a newsletter issue to a complete, send-ready HTML document using the
 * bulletproof, email-client-safe modular components in `email-render.ts`
 * (US-919) — branded table layout, all base CSS inline, MSO/Outlook buttons,
 * dark-mode + responsive, absolute links, plus a CAN-SPAM footer + unsubscribe +
 * preference-center when supplied. The marketing coordinator expects
 * fully-rendered HTML, so everything is baked in.
 */
export function renderNewsletterHtml(issue: RenderableIssue, opts: RenderOptions = {}): string {
  return renderNewsletterEmail(issue, opts);
}

/**
 * Render a plaintext alternative of the issue (pure). The pre-send gate (US-924)
 * needs to confirm a meaningful plaintext body can be produced; the engine
 * auto-generates it from the issue's sections.
 */
export function renderNewsletterText(issue: RenderableIssue): string {
  return renderNewsletterEmailText(issue);
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
