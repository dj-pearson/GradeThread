// US-2559: tab identity + `?view=` resolution for the four consolidated admin
// hosts (Rewards, Newsletter, AI, Trust & Safety).
//
// Kept in its own module — the same reason flipdesk/nav-tabs.ts exists — so a
// unit test can import the mapping without dragging sixteen lazily-loaded page
// modules into the graph.
//
// `?view=`, not `?tab=`: several of the hosted pages own `?tab=` for their own
// inner tabs (moderation.tsx has four), and two levels fighting over one key is
// how a deep link silently lands on the wrong thing. The FlipDesk Money host
// hit exactly this and resolved it the same way.
//
// Every resolver is TOTAL: an unknown, absent or hostile value lands on the
// first tab rather than an empty shell. A bad query string from an old
// bookmark, a truncated share link or a typo should look like the page, not
// like a bug.

function resolver<T extends readonly string[]>(tabs: T, fallback: T[number]) {
  return (raw: string | null | undefined): T[number] =>
    (tabs as readonly string[]).includes(raw ?? "")
      ? (raw as T[number])
      : fallback;
}

// ── Rewards ────────────────────────────────────────────────────────────────
// "economics" is FIRST and is the default, deliberately (US-2559 AC4).
// reward-economics opens with the payout kill switch and today's spend because
// an operator arriving in an incident wants "is money still leaving?" answered
// before anything else. Making it the landing tab is what keeps that immediate
// after the merge — any other default would bury it one click deep, which the
// story explicitly calls a regression.
export const REWARD_VIEWS = [
  "economics",
  "milestones",
  "quests",
  "north-star",
  "incentives",
] as const;
export type RewardView = (typeof REWARD_VIEWS)[number];
export const resolveRewardView = resolver(REWARD_VIEWS, "economics");

// ── Newsletter ─────────────────────────────────────────────────────────────
// "health" is FIRST and is the default because /admin/growth/newsletter is not
// a new URL - it is the existing Newsletter Health page, promoted to host its
// three siblings. Defaulting to anything else would silently change what an
// existing bookmark shows, which is the same class of bug the redirects below
// exist to prevent.
export const NEWSLETTER_VIEWS = [
  "health",
  "console",
  "subscribers",
  "suppressions",
] as const;
export type NewsletterView = (typeof NEWSLETTER_VIEWS)[number];
export const resolveNewsletterView = resolver(NEWSLETTER_VIEWS, "health");

// ── AI ─────────────────────────────────────────────────────────────────────
// Models is the configuration surface everything else measures.
export const AI_VIEWS = [
  "models",
  "spend",
  "profitability",
  "assistant",
] as const;
export type AiView = (typeof AI_VIEWS)[number];
export const resolveAiView = resolver(AI_VIEWS, "models");

// ── Trust & Safety ─────────────────────────────────────────────────────────
// Moderation is the queue an operator drains; fraud and signals are what they
// consult while draining it.
export const SAFETY_VIEWS = ["moderation", "fraud", "signals"] as const;
export type SafetyView = (typeof SAFETY_VIEWS)[number];
export const resolveSafetyView = resolver(SAFETY_VIEWS, "moderation");

/**
 * Every path this consolidation retired, mapped to its host + view.
 *
 * US-2559 AC5: runbooks, bookmarks, the command palette and in-app links all
 * carry these URLs, so each one redirects into the host with the matching tab
 * selected rather than 404ing or dumping the operator on a default tab.
 * Exported so a test can walk it against the router.
 */
export const RETIRED_ADMIN_PATHS: Record<string, string> = {
  "/admin/growth/quests": "/admin/growth/rewards?view=quests",
  "/admin/growth/reward-milestones": "/admin/growth/rewards?view=milestones",
  "/admin/growth/reward-economics": "/admin/growth/rewards?view=economics",
  "/admin/growth/reward-north-star": "/admin/growth/rewards?view=north-star",
  "/admin/incentives": "/admin/growth/rewards?view=incentives",

  "/admin/growth/newsletter-console": "/admin/growth/newsletter?view=console",
  "/admin/growth/subscribers": "/admin/growth/newsletter?view=subscribers",
  "/admin/growth/suppressions": "/admin/growth/newsletter?view=suppressions",

  "/admin/ai-models": "/admin/ai?view=models",
  "/admin/ai-spend": "/admin/ai?view=spend",
  "/admin/ai-profitability": "/admin/ai?view=profitability",
  "/admin/support/monitoring": "/admin/ai?view=assistant",

  "/admin/moderation": "/admin/safety?view=moderation",
  "/admin/fraud": "/admin/safety?view=fraud",
  "/admin/safety/signals": "/admin/safety?view=signals",
};
