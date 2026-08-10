import { shareOrCopy, type ShareResult } from "@/lib/share";
import { SITE_URL } from "@/lib/seo/site";
import { track } from "@/lib/analytics";
import type { AnalyticsEvent } from "@/lib/analytics-events";
import type { CelebrationShare } from "@/lib/reward-celebrations";

// US-1857: one-tap share of a reward card.
//
// Both cards are rendered by the SAME Satori template on the edge
// (cert-og-template.ts buildAchievementBadgeHtml) and proxied by a Pages
// Function, so a badge share and a level share are visually one family and can
// only ever drift together. Neither URL identifies anybody: a badge card
// describes the medal, a level card describes the rung. That is what lets them
// stay public, anonymous and cached for a day.
//
// No utm parameters here, deliberately. These URLs ARE the image; decorating
// them would fragment the CDN cache for a card that is identical for everyone.
//
// ─────────────────────────────────────────────────────────────────────────────
// US-1915 AC4 — the SHARE step of the reward loop is measured HERE, not at the
// call sites, and that placement is the point.
//
// This function had three call sites (the badge shelf, the celebration toast,
// the rewards page) and NONE of them emitted anything, so the share step of the
// loop — the client half of the K-factor — was entirely unmeasured. The intent
// had actually been written down and then dropped: `shareOrCopy` returns a
// ShareResult and its own doc says that is "so callers can fire analytics with
// the right method". All three reward call sites wrote `void shareRewardCard(…)`
// and threw the result away.
//
// It looked covered from a distance because the PUBLIC seller-medals surface
// (components/verified/achievement-medals.tsx) does emit `achievement_badge_share`
// correctly. That is a different surface, for a different audience, with a
// `handle` property — it says nothing about the logged-in rewards loop.
//
// Instrumenting inside this function means a FOURTH call site is born tracked.
// At the call sites it would be born silent, which is exactly how this gap
// opened the first time.
// ─────────────────────────────────────────────────────────────────────────────

/** Where the share was initiated from. Required so a surface cannot be unnamed. */
export type RewardShareSurface = "badge_shelf" | "celebration" | "rewards_page";

/** The public card URL for a celebration's share, on `origin`. */
function rewardCardUrl(share: CelebrationShare, origin: string): string {
  const path = share.kind === "badge"
    ? `/badge/achievement/${encodeURIComponent(share.key)}`
    : `/badge/level/${encodeURIComponent(share.key)}`;
  return `${origin}${path}`;
}

function currentOrigin(): string {
  return typeof window !== "undefined" ? window.location.origin : SITE_URL;
}

/** One PostHog call, decided but not yet made. */
export interface RewardShareAnalyticsEvent {
  event: AnalyticsEvent;
  props: Record<string, unknown>;
}

/**
 * Which analytics events a finished share should emit.
 *
 * Pure and exported so it is testable: the callers are click handlers, and this
 * repo's reward component tests use `renderToStaticMarkup`, which never runs
 * effects or handlers. A decision left inline in a handler is one no test can
 * reach — the same reason `celebrationAnalyticsEvents` was extracted.
 *
 * ⚠ TWO NAMES, NOT ONE EVENT WITH A `result` PROPERTY. A completed share and an
 * abandoned share sheet are different things and are counted differently: the
 * K-factor's numerator is shares, so counting an abandoned sheet as a share
 * would inflate it. Emitting one event with a `result` field would make every
 * correct query depend on remembering to filter — and the first person to forget
 * gets a wrong K-factor that looks right.
 *
 * ⚠ AND THE ABANDONMENT IS EMITTED AT ALL for the reason the suppression event
 * exists in `celebrationAnalyticsEvents`: without it, a share sheet users open
 * and back out of is INDISTINGUISHABLE from one they never opened. Those two
 * call for opposite fixes — a better card versus a better prompt — so collapsing
 * them loses the only signal that tells them apart.
 *
 * A "failed" share emits nothing: it is a browser/clipboard error, not a user
 * decision, and logging it as either a share or an abandonment would be false.
 */
export function rewardShareAnalytics(
  share: CelebrationShare,
  result: ShareResult,
  surface: RewardShareSurface,
): RewardShareAnalyticsEvent[] {
  const base = { kind: share.kind, key: share.key, surface };
  if (result === "shared" || result === "copied") {
    return [{
      event: "reward_card_share",
      // `method` matches the spelling achievement_badge_share already uses, so
      // the two share surfaces can be compared without a translation step.
      props: { ...base, method: result === "shared" ? "web_share" : "copy" },
    }];
  }
  if (result === "dismissed") {
    return [{ event: "reward_card_share_dismissed", props: base }];
  }
  return [];
}

/** Open the share sheet (or copy the link) for a badge / level card. */
export async function shareRewardCard(
  share: CelebrationShare,
  surface: RewardShareSurface,
): Promise<ShareResult> {
  const result = await shareOrCopy({
    title: share.title,
    text: share.text,
    url: rewardCardUrl(share, currentOrigin()),
    copiedMessage: "Card link copied — paste it anywhere.",
  });
  for (const a of rewardShareAnalytics(share, result, surface)) {
    track(a.event, a.props);
  }
  return result;
}
