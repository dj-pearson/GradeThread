import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  ANALYTICS_TABS,
  RANGE_TABS,
  tabFromPath,
  tabHref,
} from "@/lib/analytics-tabs";
import { presetStart } from "@/lib/analytics-range";
import { SCORECARD_TAB_FOR } from "@/lib/seller-scorecard";

// A9: one tab table, every path registered and resolvable both ways, and
// presets built from the LOCAL calendar date.

describe("ANALYTICS_TABS", () => {
  const routes = readFileSync(resolve(process.cwd(), "src/routes/index.tsx"), "utf8");

  it.each(ANALYTICS_TABS.map((t) => [t.id, t.path]))(
    "%s resolves both ways and is a registered route",
    (id, path) => {
      expect(tabFromPath(path)).toBe(id);
      expect(tabFromPath(`${path}/`)).toBe(id);
      expect(tabHref(id)).toBe(path);
      expect(routes).toContain(`path: "${path}"`);
    },
  );

  it("keeps the query string on navigation", () => {
    expect(tabHref("team", "?preset=30d")).toBe(
      "/dashboard/flipdesk/analytics/team?preset=30d",
    );
  });

  it("falls back to the first tab for an unknown path", () => {
    expect(tabFromPath("/dashboard/flipdesk/analytics/nope")).toBe("sell-through");
  });

  it("has a short label for every tab and derives RANGE_TABS", () => {
    for (const t of ANALYTICS_TABS) expect(t.shortLabel.length).toBeGreaterThan(0);
    expect(RANGE_TABS.has("performance")).toBe(false);
    expect(RANGE_TABS.has("team")).toBe(true);
  });

  it("points every scorecard metric at a real tab", () => {
    const paths = new Set(ANALYTICS_TABS.map((t) => t.path));
    for (const p of Object.values(SCORECARD_TAB_FOR)) expect(paths.has(p)).toBe(true);
  });
});

describe("presetStart uses the local date (A9)", () => {
  const prev = process.env.TZ;
  beforeAll(() => {
    process.env.TZ = "America/Chicago";
  });
  afterAll(() => {
    process.env.TZ = prev;
  });

  it("at 20:00 local in UTC-5, 30d is the local date minus 30", () => {
    // 2026-09-24 20:00 CDT is 2026-09-25 01:00 UTC. A UTC-based start would
    // say 2026-08-26; the local one is 2026-08-25.
    const now = new Date("2026-09-25T01:00:00Z");
    expect(now.getHours()).toBe(20);
    expect(presetStart("30d", now)).toBe("2026-08-25");
    expect(presetStart("all", now)).toBeNull();
  });
});
