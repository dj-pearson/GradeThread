// R13: every reward share goes through shareRewardCard, so every one is
// tracked, and each names the surface it actually came from.
import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { shareOrCopy } from "@/lib/share";
import { track } from "@/lib/analytics";
import { anniversaryShare, shareRewardCard } from "@/lib/reward-share";
import { BadgeMedalStrip } from "@/components/rewards/badge-shelf";
import type { RewardBadge } from "@/hooks/use-rewards";

vi.mock("@/lib/share", () => ({ shareOrCopy: vi.fn(async () => "copied") }));
vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.mocked(track).mockClear();
  vi.mocked(shareOrCopy).mockClear();
});

describe("reward share surfaces (R13)", () => {
  it("the anniversary share is tracked as loyalty_card, with a correct title", async () => {
    await shareRewardCard(anniversaryShare(1), "loyalty_card");
    expect(track).toHaveBeenCalledWith("reward_card_share", {
      kind: "anniversary",
      key: "1",
      surface: "loyalty_card",
      method: "copy",
    });
    const args = vi.mocked(shareOrCopy).mock.calls[0]![0];
    expect(args.title).toBe("1 year on GradeThread");
    expect(args.url).toMatch(/^https?:\/\/[^/]+\/how-it-works$/);
    expect(anniversaryShare(3).title).toBe("3 years on GradeThread");
  });

  it("a medal tapped on the dashboard widget is logged as dashboard_widget", async () => {
    const badge: RewardBadge = {
      key: "first_grade",
      name: "First Grade",
      description: "Your first grade.",
      tier: "bronze",
      icon: "Award",
      earned_at: "2026-09-01T00:00:00Z",
    };
    container = document.createElement("div");
    document.body.appendChild(container);
    act(() => {
      root = createRoot(container!);
      root.render(<BadgeMedalStrip badges={[badge]} limit={6} surface="dashboard_widget" />);
    });
    await act(async () => {
      (container!.querySelector("button") as HTMLButtonElement).click();
      await Promise.resolve();
    });
    expect(track).toHaveBeenCalledWith(
      "reward_card_share",
      expect.objectContaining({ surface: "dashboard_widget", key: "first_grade" }),
    );
  });

  it("no rewards component calls shareOrCopy directly", () => {
    const dir = resolve(process.cwd(), "src/components/rewards");
    const offenders = readdirSync(dir)
      .filter((f) => f.endsWith(".tsx"))
      .filter((f) => readFileSync(join(dir, f), "utf8").includes("shareOrCopy"));
    expect(offenders).toEqual([]);
  });
});
