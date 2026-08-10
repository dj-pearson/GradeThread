import { describe, expect, it } from "vitest";
import { rewardShareAnalytics } from "../reward-share";
import type { CelebrationShare } from "../reward-celebrations";

// US-1915 AC4, the share step. These assert the DECISION, not the plumbing —
// the callers are click handlers, and the reward component tests render with
// renderToStaticMarkup, which never runs a handler. Anything decided inline in
// those handlers is unreachable by any test, which is how this step went
// unmeasured across three call sites in the first place.

const BADGE: CelebrationShare = {
  kind: "badge",
  key: "first_grade",
  title: "GradeThread badge: First Grade",
  text: "Earned the First Grade badge on GradeThread.",
};

const LEVEL: CelebrationShare = {
  kind: "level",
  key: "7",
  title: "GradeThread level 7",
  text: "Level 7 on GradeThread.",
};

describe("rewardShareAnalytics", () => {
  it("emits one share event for a native share, tagged web_share", () => {
    const out = rewardShareAnalytics(BADGE, "shared", "badge_shelf");
    expect(out).toHaveLength(1);
    expect(out[0]!.event).toBe("reward_card_share");
    expect(out[0]!.props).toEqual({
      kind: "badge",
      key: "first_grade",
      surface: "badge_shelf",
      method: "web_share",
    });
  });

  it("emits one share event for a clipboard copy, tagged copy", () => {
    // Desktop never opens the OS share sheet (share.ts gates on a coarse
    // pointer), so `copied` is the DOMINANT desktop path — not an edge case.
    // Dropping it would make reward sharing look like a mobile-only behaviour.
    const out = rewardShareAnalytics(LEVEL, "copied", "rewards_page");
    expect(out).toHaveLength(1);
    expect(out[0]!.event).toBe("reward_card_share");
    expect(out[0]!.props).toMatchObject({ method: "copy", kind: "level", key: "7" });
  });

  it("counts an abandoned share sheet SEPARATELY, never as a share", () => {
    // The whole reason there are two names. If this returned reward_card_share
    // with a result property, every correct K-factor query would depend on
    // someone remembering to filter it out.
    const out = rewardShareAnalytics(BADGE, "dismissed", "celebration");
    expect(out).toHaveLength(1);
    expect(out[0]!.event).toBe("reward_card_share_dismissed");
    expect(out[0]!.event).not.toBe("reward_card_share");
    expect(out[0]!.props).not.toHaveProperty("method");
  });

  it("emits NOTHING for a failed share", () => {
    // A clipboard/browser error is not a user decision. Recording it as either
    // a share or an abandonment would assert something about intent that did
    // not happen.
    expect(rewardShareAnalytics(BADGE, "failed", "badge_shelf")).toEqual([]);
  });

  it("always carries the surface, so the three call sites stay distinguishable", () => {
    const surfaces = ["badge_shelf", "celebration", "rewards_page"] as const;
    let checked = 0;
    for (const s of surfaces) {
      const out = rewardShareAnalytics(BADGE, "copied", s);
      expect(out[0]!.props.surface).toBe(s);
      checked++;
    }
    expect(checked).toBe(3);
  });

  it("distinguishes a badge share from a level share", () => {
    // Both cards come from the same Satori template, so without kind+key the
    // two are indistinguishable in PostHog and "which reward do people actually
    // show off" becomes unanswerable.
    const badge = rewardShareAnalytics(BADGE, "shared", "celebration")[0]!;
    const level = rewardShareAnalytics(LEVEL, "shared", "celebration")[0]!;
    expect(badge.props.kind).toBe("badge");
    expect(level.props.kind).toBe("level");
    expect(badge.props.key).not.toBe(level.props.key);
  });
});
