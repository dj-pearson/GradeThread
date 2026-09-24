import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  BADGE_ACTIONS,
  GOAL_ACTIONS,
  grantAction,
  METRIC_ACTIONS,
  seasonPaceLine,
} from "../reward-actions";

// R15: every goal, quest metric and badge links to the work that moves it. The
// catalogs live on the edge, so their keys are read from the source there: a key
// added on the edge without an action here fails this test.

const EDGE = resolve(process.cwd(), "services/edge-functions/src/lib");
const read = (f: string) => readFileSync(resolve(EDGE, f), "utf8");

function block(src: string, start: string): string {
  const at = src.indexOf(start);
  expect(at, `${start} not found`).toBeGreaterThan(-1);
  return src.slice(at, src.indexOf("\n];", at));
}

const ROUTES = readFileSync(resolve(process.cwd(), "src/routes/index.tsx"), "utf8");

describe("reward actions cover the catalogs", () => {
  it("every season goal has an action", () => {
    const goals = [...block(read("rewards-seasons.ts"), "export const SEASON_GOALS")
      .matchAll(/key: "([a-z0-9_]+)"/g)].map((m) => m[1]!);
    expect(goals.length).toBeGreaterThanOrEqual(5);
    for (const key of goals) expect(GOAL_ACTIONS[key], key).toBeDefined();
  });

  it("every badge in the catalog has an action and a goal sentence", () => {
    const badges = [...block(read("rewards-badges.ts"), "export const BADGE_CATALOG")
      .matchAll(/\{ key: "([a-z0-9_]+)"/g)].map((m) => m[1]!);
    expect(badges.length).toBeGreaterThanOrEqual(10);
    for (const key of badges) {
      expect(BADGE_ACTIONS[key], key).toBeDefined();
      expect(BADGE_ACTIONS[key]!.goal.length, key).toBeGreaterThan(5);
    }
  });

  it("every event type a quest can count has an action", () => {
    const union = read("rewards-engine.ts");
    const type = union.slice(
      union.indexOf("export type RewardEventType ="),
      union.indexOf(";", union.indexOf("export type RewardEventType =")),
    );
    const types = [...type.matchAll(/\| "([a-z_]+)"/g)].map((m) => m[1]!);
    // Not quest metrics (rewards-quests.ts QUEST_METRICS excludes them).
    const excluded = new Set(["quest_completed", "share_milestone", "integrity_tier_up"]);
    for (const t of types.filter((t) => !excluded.has(t))) {
      expect(METRIC_ACTIONS[t], t).toBeDefined();
    }
    expect(METRIC_ACTIONS.xp).toBeDefined();
  });

  it("every action points at a route that exists", () => {
    const all = [
      ...Object.values(METRIC_ACTIONS),
      ...Object.values(GOAL_ACTIONS),
      ...Object.values(BADGE_ACTIONS),
      grantAction("free_grade_credits"),
      grantAction("subscription_discount"),
    ];
    for (const a of all) expect(ROUTES, a.href).toContain(`path: "${a.href}"`);
  });
});

describe("grantAction", () => {
  it("sends a plan discount to billing and everything else to a new grade", () => {
    expect(grantAction("subscription_discount")).toEqual({
      href: "/dashboard/billing",
      label: "Apply to your plan",
    });
    expect(grantAction("free_grade_credits").label).toBe("Use a free grade");
  });
});

describe("seasonPaceLine", () => {
  const goals = [
    { current: 10, target: 15, complete: false },
    { current: 1, target: 3, complete: false },
    { current: 25, target: 25, complete: true },
  ];

  it("projects each goal's rate to the end of the season", () => {
    // Halfway: 10/0.5 = 20 >= 15 on pace; 1/0.5 = 2 < 3 not; the done one counts.
    expect(seasonPaceLine(goals, 0.5)).toBe("On pace for 2 of 3 goals.");
  });

  it("says nothing in the first days of a season", () => {
    expect(seasonPaceLine(goals, 0.01)).toBeNull();
  });
});
