// US-1850 AC3: the earned-medal strip on a public verified-seller profile.
//
// Two things matter here and neither is visible from a code read: a medal's
// SHARE action must hand over the badge CARD image url (the shareable artifact
// the story asks for), not the profile url; and an unknown icon name — what a
// future catalog entry looks like to an older bundle — must degrade to a
// generic medal rather than crashing a public trust page.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createElement as h, act } from "react";
import { createRoot, type Root } from "react-dom/client";

interface ShareArgs {
  title?: string;
  text?: string;
  url: string;
  copiedMessage?: string;
}

const shareOrCopy = vi.fn(async (_data: ShareArgs) => "copied" as const);
const track = vi.fn();
vi.mock("@/lib/share", () => ({
  shareOrCopy: (data: ShareArgs) => shareOrCopy(data),
}));
vi.mock("@/lib/analytics", () => ({
  track: (...args: unknown[]) => track(...args),
}));

const { AchievementMedals } = await import(
  "@/components/verified/achievement-medals"
);

type Medal = Parameters<typeof AchievementMedals>[0]["achievements"][number];

const medal = (over: Partial<Medal> = {}): Medal => ({
  key: "perfect_10",
  name: "Perfect 10",
  description: "Graded an item a flawless 10.0.",
  tier: "silver",
  icon: "Star",
  earned_at: "2026-02-01T00:00:00Z",
  ...over,
});

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  shareOrCopy.mockClear();
  track.mockClear();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function render(achievements: Medal[], handle = "jane") {
  act(() => {
    root.render(h(AchievementMedals, { achievements, handle }));
  });
}

describe("AchievementMedals (US-1850 AC3)", () => {
  it("renders each earned medal with its tier and earned month", () => {
    render([medal(), medal({ key: "grades_1000", name: "Master Grader", tier: "gold", icon: "Trophy" })]);
    const text = container.textContent ?? "";
    expect(text).toContain("Perfect 10");
    expect(text).toContain("Silver");
    expect(text).toContain("Master Grader");
    expect(text).toContain("Gold");
    expect(container.querySelectorAll("li")).toHaveLength(2);
  });

  it("renders nothing at all when no medals are earned", () => {
    render([]);
    expect(container.innerHTML).toBe("");
  });

  it("shares the badge CARD image url, not the profile url", async () => {
    render([medal()]);
    const button = container.querySelector("button")!;
    await act(async () => {
      button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(shareOrCopy).toHaveBeenCalledTimes(1);
    const arg = shareOrCopy.mock.calls[0]![0];
    expect(arg.url).toContain("/badge/achievement/perfect_10");
    expect(arg.url).not.toContain("/verified/");
    expect(track).toHaveBeenCalledWith(
      "achievement_badge_share",
      expect.objectContaining({ badge_key: "perfect_10", handle: "jane" }),
    );
  });

  it("degrades an unknown icon name to a generic medal instead of crashing", () => {
    render([medal({ icon: "SomeIconAddedLater" })]);
    expect(container.textContent).toContain("Perfect 10");
    expect(container.querySelector("svg")).not.toBeNull();
  });
});
