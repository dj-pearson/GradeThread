import {
  Award,
  ChevronsUp,
  Flame,
  Lock,
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
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { RewardBadge, RewardBadgeShelf } from "@/hooks/use-rewards";
import { shareRewardCard } from "@/lib/reward-share";
import { cn } from "@/lib/utils";

// US-1857: the badge shelf — earned medals, and the ones still to earn.
//
// A gallery of only what you already have is a trophy case: nothing on it tells
// you what to do next. So the shelf shows both, and the locked half is muted and
// SMALLER rather than absent — the medals you own should be the loud part.
//
// Hidden badges (BADGE_CATALOG `hidden: true`) never appear in the locked list;
// the edge leaves them out of the denominator too, so "3 of 11" can't leak that
// a twelfth surprise exists.

// Catalog icon names → components. Explicit map, same convention as the rewards
// page: the bundle carries only what we ship, and an unknown name degrades to a
// generic medal instead of crashing the shelf.
const ICONS: Record<string, LucideIcon> = {
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
};

// The same three colours the shared card renders (cert-og-template.ts
// TIER_COLOR), so an on-screen medal and the PNG a seller posts are one object.
const TIER_BG: Record<string, string> = {
  bronze: "#a97142",
  silver: "#9ca3af",
  gold: "#d4af37",
};

const TIER_LABEL: Record<string, string> = {
  bronze: "Bronze",
  silver: "Silver",
  gold: "Gold",
};

function earnedMonth(iso: string | null): string {
  if (!iso) return "";
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return "";
  return new Date(ms).toLocaleDateString(undefined, { month: "short", year: "numeric" });
}

/**
 * One earned medal. It is a BUTTON because pressing it shares the card — the
 * one-tap share the celebration offers, available forever afterwards rather than
 * only in the eight seconds the toast is on screen.
 */
function BadgeMedal({ badge, size = "md" }: { badge: RewardBadge; size?: "sm" | "md" }) {
  const Icon = ICONS[badge.icon] ?? Medal;
  const tier = TIER_LABEL[badge.tier] ?? badge.tier;
  const when = earnedMonth(badge.earned_at);

  return (
    <button
      type="button"
      onClick={() => {
        void shareRewardCard({
          kind: "badge",
          key: badge.key,
          title: `GradeThread badge: ${badge.name}`,
          text: `Earned the ${badge.name} badge on GradeThread.`,
        });
      }}
      title={`${badge.description}${when ? ` Earned ${when}.` : ""}`}
      aria-label={`Share the ${badge.name} badge — ${tier}. ${badge.description}`}
      className={cn(
        "group flex flex-col items-center gap-1.5 rounded-lg p-1 text-center",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
        size === "sm" ? "w-16" : "w-20",
      )}
    >
      <span
        className={cn(
          "flex flex-shrink-0 items-center justify-center rounded-full text-white",
          size === "sm" ? "h-10 w-10" : "h-14 w-14",
        )}
        style={{ background: TIER_BG[badge.tier] ?? "#0F3460" }}
      >
        <Icon className={size === "sm" ? "h-5 w-5" : "h-6 w-6"} aria-hidden="true" />
      </span>
      <span
        className={cn(
          "w-full truncate font-medium leading-tight",
          size === "sm" ? "text-[11px]" : "text-xs",
        )}
      >
        {badge.name}
      </span>
    </button>
  );
}

/** The medals only — used by the dashboard widget, where space is the constraint. */
export function BadgeMedalStrip({ badges, limit }: { badges: RewardBadge[]; limit: number }) {
  if (badges.length === 0) return null;
  const shown = badges.slice(0, limit);
  const rest = badges.length - shown.length;
  return (
    <div className="flex flex-wrap items-start gap-1">
      {shown.map((b) => <BadgeMedal key={b.key} badge={b} size="sm" />)}
      {rest > 0 && (
        <span className="flex h-10 w-10 items-center justify-center rounded-full bg-muted text-xs font-medium tabular-nums text-muted-foreground">
          +{rest}
        </span>
      )}
    </div>
  );
}

export function BadgeShelf({ shelf }: { shelf: RewardBadgeShelf }) {
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-lg">
          <Medal className="h-5 w-5 text-primary" />
          Badges
        </CardTitle>
        <p className="text-sm text-muted-foreground">
          {shelf.earned_count} of {shelf.total} earned. Tap a medal to share its card.
        </p>
      </CardHeader>
      <CardContent className="space-y-5">
        {shelf.earned.length > 0 ? (
          <div className="flex flex-wrap gap-2">
            {shelf.earned.map((b) => <BadgeMedal key={b.key} badge={b} />)}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            No medals yet. Grade your first item and the first one lands straight away.
          </p>
        )}

        {shelf.upcoming.length > 0 && (
          <div className="space-y-2">
            <h3 className="text-sm font-medium">Still to earn</h3>
            <ul className="space-y-2">
              {shelf.upcoming.map((b) => (
                <li key={b.key} className="flex items-start gap-3">
                  <span className="mt-0.5 flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full bg-muted">
                    <Lock className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
                  </span>
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-muted-foreground">{b.name}</p>
                    <p className="text-xs text-muted-foreground">{b.description}</p>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
