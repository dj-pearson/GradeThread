import { shareOrCopy } from "@/lib/share";
import { SITE_URL } from "@/lib/seo/site";
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

/** Open the share sheet (or copy the link) for a badge / level card. */
export function shareRewardCard(share: CelebrationShare): Promise<unknown> {
  return shareOrCopy({
    title: share.title,
    text: share.text,
    url: rewardCardUrl(share, currentOrigin()),
    copiedMessage: "Card link copied — paste it anywhere.",
  });
}
