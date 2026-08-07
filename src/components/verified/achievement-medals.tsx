// US-1850 AC3: a verified seller's EARNED achievement medals, on their public
// profile. The edge projects them (publicAchievements in rewards-badges.ts), so
// only catalog metadata + earned_at ever arrive here — never the private stat
// snapshot that unlocked the medal.
//
// Each medal shares as its own card image (/badge/achievement/:key), which is
// the same satori→PNG render the cert and seller badges use.

import {
  Award,
  ChevronsUp,
  Flame,
  Medal,
  Plug,
  Share2,
  Sparkles,
  Star,
  Tag,
  TrendingUp,
  Trophy,
  type LucideIcon,
} from "lucide-react";
import { achievementBadgeUrl } from "@/lib/verified";
import { shareOrCopy } from "@/lib/share";
import { track } from "@/lib/analytics";
import { cn } from "@/lib/utils";

export type AchievementTier = "bronze" | "silver" | "gold";

export interface PublicAchievement {
  key: string;
  name: string;
  description: string;
  tier: AchievementTier;
  /** lucide icon name, from the edge BADGE_CATALOG. */
  icon: string;
  earned_at: string;
}

// The catalog's `icon` values are lucide component names. Resolved through an
// explicit map rather than a dynamic lookup so the bundle only carries the
// icons we actually ship, and an unknown name degrades to a generic medal
// instead of crashing the profile.
const ICONS: Record<string, LucideIcon> = {
  Award,
  ChevronsUp,
  Flame,
  Medal,
  Plug,
  Sparkles,
  Star,
  Tag,
  TrendingUp,
  Trophy,
};

// Medal fills. Text on them is white, never gray — a muted foreground over a
// colored surface is the tell we refuse.
const TIER_FILL: Record<AchievementTier, string> = {
  bronze: "bg-[#a97142] text-white",
  silver: "bg-[#8d939c] text-white",
  gold: "bg-[#b08d1f] text-white",
};

const TIER_LABEL: Record<AchievementTier, string> = {
  bronze: "Bronze",
  silver: "Silver",
  gold: "Gold",
};

function earnedLabel(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString("en-US", { year: "numeric", month: "short" });
}

/** Share one medal's card image. Falls back to copying the link. */
async function shareMedal(a: PublicAchievement, handle: string) {
  const result = await shareOrCopy({
    title: `${a.name} — GradeThread Achievement`,
    text: `${a.description} Earned on GradeThread.`,
    url: achievementBadgeUrl(a.key),
    copiedMessage: "Badge card link copied",
  });
  if (result === "shared" || result === "copied") {
    track("achievement_badge_share", {
      handle,
      badge_key: a.key,
      method: result === "shared" ? "web_share" : "copy",
    });
  }
}

export function AchievementMedals({
  achievements,
  handle,
}: {
  achievements: PublicAchievement[];
  handle: string;
}) {
  if (achievements.length === 0) return null;

  return (
    <ul className="flex flex-wrap gap-3">
      {achievements.map((a) => {
        const Icon = ICONS[a.icon] ?? Medal;
        const when = earnedLabel(a.earned_at);
        return (
          <li key={a.key}>
            <button
              type="button"
              onClick={() => void shareMedal(a, handle)}
              title={`${a.description} Share this badge card.`}
              className="group flex items-center gap-3 rounded-2xl bg-muted/60 py-2 pl-2 pr-4 text-left transition-colors hover:bg-muted"
            >
              <span
                className={cn(
                  "flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-full",
                  TIER_FILL[a.tier],
                )}
              >
                <Icon className="h-5 w-5" aria-hidden="true" />
              </span>
              <span className="min-w-0">
                <span className="flex items-center gap-1.5 text-sm font-semibold">
                  {a.name}
                  <Share2 className="h-3.5 w-3.5 opacity-0 transition-opacity group-hover:opacity-70 group-focus-visible:opacity-70" />
                </span>
                <span className="block text-xs text-muted-foreground">
                  {TIER_LABEL[a.tier]}
                  {when ? ` · ${when}` : ""}
                </span>
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
