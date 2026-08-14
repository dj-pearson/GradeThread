import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// US-2537. The seller dashboard opened with eight promotional blocks — the
// activation checklist, a first-run card, quick actions, the rewards widget, a
// FlipDesk promo, Discover cards, invite-a-friend and an impact tile — before a
// returning seller saw a single number about their own business.

const PAGE = "src/pages/dashboard.tsx";
const METER = "src/components/billing/usage-meter.tsx";

function src(): string {
  return readFileSync(resolve(process.cwd(), PAGE), "utf8");
}

/** Character offset of a marker, for ordering assertions. */
function at(marker: string): number {
  const i = src().indexOf(marker);
  expect(i, `missing marker: ${marker}`).toBeGreaterThan(-1);
  return i;
}

describe("the seller's own data comes first (US-2537)", () => {
  it("stats, usage and Recent Submissions precede every promo block", () => {
    const dataEnd = at("{/* Recent submissions */}");
    for (const promo of [
      "<ActivationChecklist />",
      "<RewardsWidget />",
      "<FlipdeskPromoCard",
      "<InviteFriendCard />",
      "<ImpactTile />",
      "{/* Quick Actions",
      "{/* Discover GradeThread",
    ]) {
      expect(at(promo), `${promo} still comes before the data`).toBeGreaterThan(
        dataEnd,
      );
    }
  });

  it("usage sits with the data, not down among the promos", () => {
    expect(at("<UsageMeters />")).toBeLessThan(at("{/* Recent submissions */}"));
  });

  it("the PWA banner is the one thing allowed above them", () => {
    // It is an install affordance tied to real intent, not a promotion of
    // another product, and it disappears once dismissed or installed.
    expect(at("<PwaInstallBanner")).toBeLessThan(at("{/* Stats cards */}"));
  });
});

describe("usage is rendered once (US-2537)", () => {
  it("the hand-built Grades Used card is gone", () => {
    const text = src();
    expect(text).not.toContain(">Grades Used<");
    // And with it the local arithmetic that duplicated the meter's.
    expect(text).not.toMatch(/const gradesPercent/);
    expect(text).not.toMatch(/const gradesUsed/);
  });

  it("only the shared component renders usage", () => {
    const uses = src().match(/<UsageMeters\b/g) ?? [];
    expect(uses.length).toBe(1);
  });

  it("the shared meter cannot divide by zero", () => {
    // This is why the duplicate had to go rather than be fixed in place: the
    // removed card computed used / limit with no guard, so a Free plan
    // (includedStandardGradesPerMonth === 0) produced Infinity and rendered
    // "Infinity%" on a new account's very first visit. The shared meter floors
    // the divisor at 1 and clamps the result.
    const meter = readFileSync(resolve(process.cwd(), METER), "utf8");
    expect(meter).toMatch(/used \/ Math\.max\(limit, 1\)/);
  });
});

describe("the quick actions go straight there (US-2537)", () => {
  it("Add Inventory Item targets the intake page, not a redirect", () => {
    const text = src();
    expect(text).toContain('to: "/dashboard/flipdesk/intake"');
    expect(text).not.toContain('to: "/dashboard/inventory/new"');
  });

  it("the redirect it used to use still exists for old links", () => {
    // Removing the quick action's hop must not break a bookmark or an email.
    const routes = readFileSync(
      resolve(process.cwd(), "src/routes/index.tsx"),
      "utf8",
    );
    expect(routes).toMatch(
      /path: "\/dashboard\/inventory\/new"[\s\S]{0,120}?\/dashboard\/flipdesk\/intake/,
    );
  });
});
