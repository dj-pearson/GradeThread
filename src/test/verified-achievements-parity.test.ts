// US-1850 AC3: the verified seller profile has TWO read paths, and an earned
// achievement medal has to appear on both.
//
// This is the same shape as the public-certificate two-read-path trap: humans in
// production get the Pages Function SSR (functions/verified/[handle].ts), while
// the SPA route (src/pages/verified-seller.tsx) serves the in-app/dev render.
// Both consume the SAME edge payload. Extending one and stopping fails silently
// — the field just reads `undefined` on the other side and the section vanishes
// with nothing going red.
//
// So this guards the whole chain: the edge emits `achievements`, and both
// renderers consume it.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const edgeRoute = readFileSync(
  "services/edge-functions/src/routes/content-public.ts",
  "utf8",
);
const ssr = readFileSync("functions/verified/[handle].ts", "utf8");
const spa = readFileSync("src/pages/verified-seller.tsx", "utf8");

describe("verified profile achievements (US-1850 AC3)", () => {
  it("the edge seller payload carries the projected achievements", () => {
    // Projected — never the raw user_badges rows, which hold the owner's
    // private context snapshot.
    expect(edgeRoute).toContain("publicAchievements(");
    expect(edgeRoute).toContain('.from("user_badges")');
    // Scoped to the profile's owner (US-268) — the service-role client bypasses
    // RLS, so an unscoped read here would hand out every user's medals.
    expect(edgeRoute).toContain('.eq("user_id", seller.id)');
  });

  it("the SSR profile renders the medals", () => {
    expect(ssr).toContain("data.achievements");
    expect(ssr).toContain("${achievementsSection}");
    // Each medal links to its own shareable card image.
    expect(ssr).toContain("/badge/achievement/");
  });

  it("the SPA profile renders the medals", () => {
    expect(spa).toContain("data.achievements");
    expect(spa).toContain("<AchievementMedals");
  });

  // US-1851: level flair rides the SAME payload and therefore the same trap.
  it("the edge seller payload carries the projected level flair", () => {
    // Projected — publicLevelFlair drops XP, which is a private business metric.
    expect(edgeRoute).toContain("publicLevelFlair(");
    expect(edgeRoute).toContain("level: flair");
  });

  it("both renderers render the level flair", () => {
    expect(ssr).toContain("data.level");
    expect(ssr).toContain("${flairHtml}");
    expect(spa).toContain("data.level");
    expect(spa).toContain("flair.tier_name");
  });

  it("neither renderer reads a seller's raw XP", () => {
    // The flair projection carries tier + level only. If a renderer reached for
    // XP, it would have to be added back to the public payload first — and a
    // seller's XP total says how much they grade and how often they list.
    for (const [name, src] of [["ssr", ssr], ["spa", spa]] as const) {
      expect(src, `${name} reads a seller's XP`).not.toContain("xp_total");
      expect(src, `${name} reads a seller's XP peak`).not.toContain("xp_peak");
    }
  });

  it("neither renderer reads the private context snapshot", () => {
    // The edge projection drops it; if a renderer ever reached for it, the
    // field would have to be added back to the public payload first.
    for (const [name, src] of [["ssr", ssr], ["spa", spa]] as const) {
      expect(src, `${name} reads the private badge context`).not.toContain(
        "a.context",
      );
    }
  });
});
