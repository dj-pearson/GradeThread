import { lazy } from "react";
import { Gift } from "lucide-react";
import { AdminTabHost } from "@/pages/admin/admin-tab-host";
import { REWARD_VIEWS, resolveRewardView, type RewardView } from "@/pages/admin/admin-host-tabs";

// US-2559: the reward domain was five sidebar entries — Quests, Milestone
// Rewards, Reward Economics, Reward North Star and Incentives.
//
// VERIFIED as a MERGE, not a de-duplication: every one does a distinct job.
// Quests configures quests; Milestone Rewards decides what a milestone GIVES;
// Economics owns the budget those grants come out of; North Star measures
// whether any of it worked; Incentives is the super-admin lever. Nothing is
// deleted here — five pages become five tabs.
//
// AC4, and the reason "economics" is the DEFAULT view: reward-economics opens
// with the payout kill switch and today's spend, because an operator arriving
// in an incident wants "is money still leaving?" answered before anything else.
// Landing on it keeps that immediate. Any other default would put the kill
// switch one click deep, which the story names as a regression — so if the
// default ever moves, that guarantee has to move with it.

const EconomicsPage = lazy(() =>
  import("@/pages/admin/growth/reward-economics").then((m) => ({
    default: m.GrowthRewardEconomicsPage,
  })),
);
const MilestonesPage = lazy(() =>
  import("@/pages/admin/growth/reward-milestones").then((m) => ({
    default: m.GrowthRewardMilestonesPage,
  })),
);
const QuestsPage = lazy(() =>
  import("@/pages/admin/growth/quests").then((m) => ({
    default: m.GrowthQuestsPage,
  })),
);
const NorthStarPage = lazy(() =>
  import("@/pages/admin/growth/reward-north-star").then((m) => ({
    default: m.GrowthRewardNorthStarPage,
  })),
);
const IncentivesPage = lazy(() =>
  import("@/pages/admin/incentives").then((m) => ({
    default: m.AdminIncentivesPage,
  })),
);

const VIEWS = [
  { value: "economics", label: "Economics", Component: EconomicsPage },
  { value: "milestones", label: "Milestone rewards", Component: MilestonesPage },
  { value: "quests", label: "Quests", Component: QuestsPage },
  { value: "north-star", label: "North Star", Component: NorthStarPage },
  { value: "incentives", label: "Incentives", Component: IncentivesPage },
] satisfies ReadonlyArray<{ value: RewardView; label: string; Component: React.ComponentType }>;

// The order the tabs render in IS the order declared in admin-host-tabs.ts, and
// the first is the default. Asserted in the guard so the two cannot drift.
void REWARD_VIEWS;

export function AdminRewardsHostPage() {
  return (
    <AdminTabHost
      title="Rewards"
      subtitle="What the reward rail costs, what it grants, and whether it worked."
      icon={Gift}
      views={VIEWS}
      resolve={resolveRewardView}
    />
  );
}
