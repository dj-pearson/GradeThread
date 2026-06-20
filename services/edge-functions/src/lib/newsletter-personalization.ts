// US-921: Per-recipient newsletter personalization — PURE logic (no supabase /
// env / network imports) so the "your week on GradeThread" recap, the tailored
// next-best-action CTA, the safe-fallback merge fields, and the token
// substitution are all unit-testable without a DB and reusable from every send
// path (the autonomous dispatch cron, the A/B start/finalize, the console send).
//
// The dynamic blocks are TOKEN-SUBSTITUTED into the pre-rendered issue template;
// no AI is re-run per recipient, so the personalization cost stays O(1) per
// issue. A recipient's activity is resolved from their OWN data only (the batched
// resolver in newsletter-personalization-job.ts keys strictly by user id), and a
// zero-activity recipient falls back to an evergreen variant — never another
// user's numbers, never a literal "undefined".

import { escapeHtml, type NewsletterSection } from "./newsletter-issue.ts";

// ── Activity snapshot ─────────────────────────────────────────────────────────

/**
 * One recipient's recent activity, resolved at send time. Counts are this-week
 * unless noted; `trialDaysLeft` / `creditsBalance` are null when unknown / N/A so
 * the renderer can choose a safe fallback rather than print a bogus value.
 */
export interface RecipientActivity {
  /** Items graded this week. */
  gradesThisWeek: number;
  /** Listings created this week. */
  itemsListedThisWeek: number;
  /** Sales recorded this week. */
  salesThisWeek: number;
  /** Active listings older than the slow-mover window (haven't sold). */
  slowMovers: number;
  /** Inventory items still in a pre-grade status (waiting to be graded). */
  ungradedItems: number;
  /** Days left on the trial clock, or null when the recipient is not on a trial. */
  trialDaysLeft: number | null;
  /** Grade-credit balance, or null when unknown. */
  creditsBalance: number | null;
}

export function emptyActivity(): RecipientActivity {
  return {
    gradesThisWeek: 0,
    itemsListedThisWeek: 0,
    salesThisWeek: 0,
    slowMovers: 0,
    ungradedItems: 0,
    trialDaysLeft: null,
    creditsBalance: null,
  };
}

/** True when the recipient did anything worth recapping (drives the recap block). */
export function hasActivity(a: RecipientActivity): boolean {
  return (
    a.gradesThisWeek > 0 ||
    a.itemsListedThisWeek > 0 ||
    a.salesThisWeek > 0 ||
    a.slowMovers > 0 ||
    a.ungradedItems > 0
  );
}

// ── Options ───────────────────────────────────────────────────────────────────

export interface PersonalizationOptions {
  /** Absolute site origin for CTA links (defaults to the production domain). */
  siteUrl?: string;
  /** A trialist with this many days (or fewer) left gets the trial-ending CTA. */
  trialSoonDays?: number;
}

const DEFAULT_SITE = "https://gradethread.com";
const DEFAULT_TRIAL_SOON_DAYS = 3;

// ── Merge-field tokens (safe fallbacks) ───────────────────────────────────────

/**
 * The merge fields available to the issue copy as `{{token}}`. Every value is a
 * concrete string with a safe fallback so a missing value can never render the
 * literal "undefined".
 */
export function activityTokens(a: RecipientActivity): Record<string, string> {
  return {
    grades_this_week: String(a.gradesThisWeek),
    items_listed: String(a.itemsListedThisWeek),
    sales_count: String(a.salesThisWeek),
    slow_movers: String(a.slowMovers),
    ungraded_items: String(a.ungradedItems),
    // null credits → "0" (a safe, honest fallback rather than blank/undefined).
    credits_balance: a.creditsBalance == null ? "0" : String(a.creditsBalance),
    // no trial → empty string; copy that references it simply collapses.
    trial_days_left: a.trialDaysLeft == null ? "" : String(a.trialDaysLeft),
  };
}

const TOKEN_RE = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g;

/**
 * Replace every `{{token}}` in `text` with its resolved value. An UNKNOWN token
 * (or one whose value is missing) collapses to an empty string — so a stray merge
 * field can never leak the literal "undefined" into a recipient's email.
 */
export function substituteTokens(text: string, tokens: Record<string, string>): string {
  return text.replace(TOKEN_RE, (_m, key: string) => {
    const v = tokens[key];
    return v == null ? "" : v;
  });
}

function substituteSection(s: NewsletterSection, tokens: Record<string, string>): NewsletterSection {
  return {
    ...s,
    heading: s.heading != null ? substituteTokens(s.heading, tokens) : s.heading,
    body: substituteTokens(s.body ?? "", tokens),
    ctaLabel: s.ctaLabel != null ? substituteTokens(s.ctaLabel, tokens) : s.ctaLabel,
    ctaUrl: s.ctaUrl != null ? substituteTokens(s.ctaUrl, tokens) : s.ctaUrl,
  };
}

// ── Recap block ("your week on GradeThread") ──────────────────────────────────

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * The "Your week on GradeThread" recap — a short list of what the recipient did
 * this week. Returns null when there is nothing to recap (the evergreen path then
 * carries the email instead). Pure: builds escaped HTML from the activity only.
 */
export function buildWeekRecapSection(a: RecipientActivity): NewsletterSection | null {
  const items: string[] = [];
  if (a.gradesThisWeek > 0) items.push(`<li>You graded ${plural(a.gradesThisWeek, "item", "items")}</li>`);
  if (a.itemsListedThisWeek > 0) items.push(`<li>You listed ${plural(a.itemsListedThisWeek, "item", "items")}</li>`);
  if (a.salesThisWeek > 0) items.push(`<li>You made ${plural(a.salesThisWeek, "sale", "sales")}</li>`);
  if (items.length === 0) return null;
  return {
    heading: "Your week on GradeThread",
    body: `<ul style="margin:0;padding-left:20px;">${items.join("")}</ul>`,
  };
}

// ── Tailored next-best-action CTA ─────────────────────────────────────────────

export interface TailoredCta {
  /** One-line lead-in shown above the button (already plain text, not HTML). */
  intro: string;
  label: string;
  url: string;
  /** Which rule fired — useful for tests / analytics; not rendered. */
  reason:
    | "trial_ending"
    | "ungraded_items"
    | "slow_movers"
    | "keep_selling"
    | "evergreen";
}

/**
 * Pick the single most relevant next action for this recipient. Priority order:
 *   1. trial ending soon       → upgrade
 *   2. items waiting to grade   → grade them
 *   3. listings not selling     → review/reprice
 *   4. made a sale this week     → source the next find
 *   5. nothing                  → evergreen (grade your first item)
 * A zero-activity recipient always lands on the evergreen variant (AC2).
 */
export function tailoredCta(a: RecipientActivity, opts: PersonalizationOptions = {}): TailoredCta {
  const site = (opts.siteUrl ?? DEFAULT_SITE).replace(/\/+$/, "");
  const trialSoon = opts.trialSoonDays ?? DEFAULT_TRIAL_SOON_DAYS;

  if (a.trialDaysLeft != null && a.trialDaysLeft >= 0 && a.trialDaysLeft <= trialSoon) {
    const when = a.trialDaysLeft === 0 ? "today" : `in ${plural(a.trialDaysLeft, "day", "days")}`;
    return {
      intro: `Your trial ends ${when} — keep your grading and listing tools.`,
      label: "Upgrade your plan",
      url: `${site}/dashboard/billing`,
      reason: "trial_ending",
    };
  }
  if (a.ungradedItems > 0) {
    return {
      intro: `You have ${plural(a.ungradedItems, "item", "items")} waiting to be graded.`,
      label: "Grade them now",
      url: `${site}/dashboard/flipdesk/inventory`,
      reason: "ungraded_items",
    };
  }
  if (a.slowMovers > 0) {
    return {
      intro: `${plural(a.slowMovers, "listing", "listings")} haven't sold in a while — a fresh price or photos can help.`,
      label: "Review your listings",
      url: `${site}/dashboard/flipdesk/inventory?mode=listings`,
      reason: "slow_movers",
    };
  }
  if (a.salesThisWeek > 0) {
    return {
      intro: `Nice work on ${plural(a.salesThisWeek, "sale", "sales")} this week — keep the momentum going.`,
      label: "Source your next find",
      url: `${site}/dashboard/flipdesk/sources`,
      reason: "keep_selling",
    };
  }
  return {
    intro: "Turn your closet into cash — grade your first item in minutes.",
    label: "Grade an item",
    url: `${site}/dashboard/flipdesk`,
    reason: "evergreen",
  };
}

function ctaToSection(cta: TailoredCta): NewsletterSection {
  return {
    body: `<p style="margin:0;">${escapeHtml(cta.intro)}</p>`,
    ctaLabel: cta.label,
    ctaUrl: cta.url,
  };
}

// ── Composed personalization ──────────────────────────────────────────────────

export interface PersonalizationResult {
  /** Personal blocks (recap + CTA) prepended to the token-substituted base copy. */
  sections: NewsletterSection[];
  /** Resolved merge-field tokens (so a caller can also substitute the subject). */
  tokens: Record<string, string>;
  recap: NewsletterSection | null;
  cta: TailoredCta;
}

/**
 * Produce the per-recipient sections for an issue: the optional "your week" recap
 * + the tailored CTA, followed by the issue's own copy with every `{{token}}`
 * safely substituted. `activity` of null (or an all-zero snapshot) yields the
 * evergreen CTA and no recap. PURE — token substitution only, no AI.
 */
export function personalizeIssueSections(
  baseSections: NewsletterSection[],
  activity: RecipientActivity | null,
  opts: PersonalizationOptions = {},
): PersonalizationResult {
  const a = activity ?? emptyActivity();
  const tokens = activityTokens(a);
  const recap = buildWeekRecapSection(a);
  const cta = tailoredCta(a, opts);
  const personalBlocks: NewsletterSection[] = recap
    ? [recap, ctaToSection(cta)]
    : [ctaToSection(cta)];
  const substitutedBase = (Array.isArray(baseSections) ? baseSections : []).map((s) =>
    substituteSection(s, tokens),
  );
  return {
    sections: [...personalBlocks, ...substitutedBase],
    tokens,
    recap,
    cta,
  };
}
