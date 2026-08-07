// US-1857: the badge shelf and the milestone-rewards area — the two panels the
// story adds to the rewards page.
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { BadgeShelf } from "@/components/rewards/badge-shelf";
import { MilestoneRewards } from "@/components/rewards/milestone-rewards";
import type { MilestoneProgress, RewardBadge, RewardBadgeShelf } from "@/hooks/use-rewards";

const EARNED: RewardBadge = {
  key: "perfect_10",
  name: "Perfect 10",
  description: "Graded an item a flawless 10.0.",
  tier: "silver",
  icon: "Star",
  earned_at: "2026-07-04T00:00:00.000Z",
};

const LOCKED: RewardBadge = {
  key: "grades_100",
  name: "Century",
  description: "Graded 100 items.",
  tier: "silver",
  icon: "Medal",
  earned_at: null,
};

function shelf(over: Partial<RewardBadgeShelf> = {}): RewardBadgeShelf {
  return {
    earned: [EARNED],
    upcoming: [LOCKED],
    earned_count: 1,
    total: 2,
    ...over,
  };
}

function milestones(over: Partial<MilestoneProgress> = {}): MilestoneProgress {
  return { enabled: true, granted: [], next: null, ...over };
}

describe("BadgeShelf (US-1857)", () => {
  it("shows earned medals and what is still to earn", () => {
    const html = renderToStaticMarkup(<BadgeShelf shelf={shelf()} />);
    expect(html).toContain("Perfect 10");
    expect(html).toContain("Still to earn");
    expect(html).toContain("Century");
    expect(html).toContain("1 of 2 earned");
  });

  it("makes every earned medal a labelled share control", () => {
    // The one-tap share the celebration offers has to stay available after the
    // toast is gone — and the label has to say what the button does, because a
    // bare medal glyph tells a screen reader nothing.
    const html = renderToStaticMarkup(<BadgeShelf shelf={shelf()} />);
    expect(html).toContain('aria-label="Share the Perfect 10 badge');
    expect(html).toContain("<button");
  });

  it("invites a first grade rather than showing an empty case", () => {
    const html = renderToStaticMarkup(
      <BadgeShelf shelf={shelf({ earned: [], earned_count: 0, total: 1 })} />,
    );
    expect(html).toContain("No medals yet");
    expect(html).not.toContain('aria-label="Share the');
  });

  it("drops the locked list once everything visible is earned", () => {
    const html = renderToStaticMarkup(
      <BadgeShelf shelf={shelf({ upcoming: [], earned_count: 1, total: 1 })} />,
    );
    expect(html).not.toContain("Still to earn");
  });
});

describe("MilestoneRewards (US-1857 over the US-1853 grant model)", () => {
  it("never renders a CLAIM control — crossing the milestone is the claim", () => {
    // A claim button beside an automatic grant invents a step a user can forget
    // to take, and then punishes them for forgetting.
    const html = renderToStaticMarkup(
      <MilestoneRewards
        milestones={milestones({
          granted: [
            {
              milestone_key: "xp_900_credits_1",
              label: "1 free grade",
              reward_type: "free_grade_credits",
              reward_value: 1,
              status: "granted",
              granted_at: "2026-07-01T00:00:00.000Z",
              expires_at: null,
            },
          ],
        })}
      />,
    );
    expect(html).toContain("1 free grade");
    expect(html.toLowerCase()).not.toContain("claim");
    expect(html).toContain("XP is never spent");
  });

  it("shows the next rung as XP remaining, not as something to buy", () => {
    const html = renderToStaticMarkup(
      <MilestoneRewards
        milestones={milestones({
          next: {
            key: "xp_2500_credits_3",
            label: "3 free grades",
            reward_type: "free_grade_credits",
            value: 3,
            xp_threshold: 2_500,
            xp_from: 900,
            xp_remaining: 800,
            percent: 50,
          },
        })}
      />,
    );
    expect(html).toContain("Next: 3 free grades");
    expect(html).toContain("800 XP to go");
    expect(html).toContain("Nothing to press");
  });

  it("renders nothing when the ladder is off and nothing was ever granted", () => {
    // A permanently empty "rewards" section teaches people to ignore the part of
    // the page where their rewards will appear.
    expect(
      renderToStaticMarkup(<MilestoneRewards milestones={milestones({ enabled: false })} />),
    ).toBe("");
  });

  it("keeps past grants visible when the ladder is later switched off", () => {
    const html = renderToStaticMarkup(
      <MilestoneRewards
        milestones={milestones({
          enabled: false,
          granted: [
            {
              milestone_key: "xp_900_credits_1",
              label: "1 free grade",
              reward_type: "free_grade_credits",
              reward_value: 1,
              status: "granted",
              granted_at: "2026-07-01T00:00:00.000Z",
              expires_at: null,
            },
          ],
        })}
      />,
    );
    expect(html).toContain("1 free grade");
    expect(html).toContain("yours to keep");
  });
});
