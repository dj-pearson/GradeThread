import { useEffect, useState } from "react";
import { toast } from "sonner";
import { track } from "@/lib/analytics";
import { useAuth } from "@/hooks/use-auth";
import { useRewards } from "@/hooks/use-rewards";
import type { RewardsState } from "@/hooks/use-rewards";
import {
  applyCelebrationLimits,
  celebrationAnalyticsEvents,
  detectCelebrations,
  prefersReducedMotion,
  readCelebrationState,
  snapshotFromRewards,
  writeCelebrationState,
  type CelebrationContext,
  type CelebrationEvent,
} from "@/lib/reward-celebrations";
import { shareRewardCard } from "@/lib/reward-share";
import { ConfettiBurst } from "@/components/rewards/confetti-burst";

// US-1857: the celebration runner. All of the policy lives in
// lib/reward-celebrations.ts (pure + unit-tested); this component only reads the
// rewards state, hands the diff to that policy, and renders whatever survives.
//
// ── Where this is mounted, and why not the layout ────────────────────────────
// On the two surfaces that ALREADY read /api/rewards/state — the dashboard
// widget and the rewards page. Mounting it in DashboardLayout instead would add
// a rewards read to every authed page in the app for the sake of firing a toast
// a few minutes earlier, and it would interrupt work: a seller mid-way through
// photographing forty items does not need a party over the viewfinder. The
// moment lands when they next look at the dashboard, which is the moment they
// are actually looking for it.
//
// Nothing is lost by waiting either — the level, the badge and the grant are all
// permanently on the rewards page. The toast was always the smaller half.

/** Copy lookups the diff needs, resolved from the same read it is diffing. */
function contextFor(rewards: RewardsState): CelebrationContext {
  const badges = [...rewards.badges.earned, ...rewards.badges.upcoming];
  const byKey = new Map(badges.map((b) => [b.key, b]));
  const milestones = new Map(
    rewards.milestones.granted.map((g) => [g.milestone_key, g.label]),
  );
  return {
    tierName: rewards.level.tier.name,
    badgeName: (key) => byKey.get(key)?.name ?? "New badge",
    badgeTier: (key) => byKey.get(key)?.tier ?? "bronze",
    milestoneLabel: (key) => milestones.get(key) ?? "Your reward",
    // US-1914. "Your standing" rather than a tier name we don't have: the
    // celebration fires on a RANK increase, and a rank can rise while the label
    // read is missing (a mid-deploy edge, a failed tenure query). Naming a tier
    // we can't see would be inventing one.
    tenureName: rewards.loyalty?.tier?.label ?? "Your standing",
  };
}

function announce(event: CelebrationEvent): void {
  const action = event.share
    ? {
        label: "Share",
        // The share sheet (or clipboard) is the whole point of the one-tap —
        // the card image is public and anonymous, so pressing it publishes the
        // achievement, never the account.
        onClick: () => {
          void shareRewardCard(event.share!, "celebration");
        },
      }
    : undefined;

  if (event.tier === "celebrate") {
    toast.success(event.title, {
      description: event.message,
      duration: 8000,
      action,
    });
    return;
  }

  // Routine XP and the steady middle of the badge shelf. Plain, short, and
  // rate-limited upstream so a bulk-processing session can't produce a queue.
  toast(event.title, { description: event.message, duration: 4000, action });
}

export function RewardCelebrations() {
  const { user } = useAuth();
  const { rewards } = useRewards();
  const [burst, setBurst] = useState(0);
  const userId = user?.id ?? null;

  useEffect(() => {
    if (!userId || !rewards) return;

    // US-1912: the integrity tier now has a real value to diff against. Only a
    // DISPLAYABLE tier is passed — below the anti-gaming floor the standing is
    // "building history", which is a state to work toward, not a promotion to
    // celebrate. A demotion is never celebrated either: detectCelebrations only
    // fires on a change, and the edge tells the seller about a drop privately,
    // so the toast this can raise is always good news.
    const next = snapshotFromRewards(
      rewards,
      rewards.integrity?.displayable ? rewards.integrity.tier : null,
    );
    const previous = readCelebrationState(userId);
    const events = detectCelebrations(previous.snapshot, next, contextFor(rewards));
    const { show, log } = applyCelebrationLimits(events, previous.log, Date.now());

    // Persist BEFORE rendering: the snapshot has to advance even when the cap
    // suppressed everything, or the same suppressed moments queue up forever.
    writeCelebrationState(userId, { snapshot: next, log });

    // US-1915 AC4. WHICH events to emit is a pure decision and lives in
    // lib/reward-celebrations.ts — this is a useEffect, and the repo's reward
    // component tests render with renderToStaticMarkup, which never runs
    // effects. A decision left inline here is one no test can reach.
    for (const a of celebrationAnalyticsEvents(events, show)) track(a.event, a.props);
    if (show.length === 0) return;

    for (const event of show) announce(event);
    if (show.some((e) => e.tier === "celebrate") && !prefersReducedMotion()) {
      setBurst((n) => n + 1);
    }
  }, [userId, rewards]);

  return <ConfettiBurst runId={burst} />;
}
