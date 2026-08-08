// US-1851 AC4: the level-tier flair sits on the verified seller profile, and the
// profile has TWO read paths — so it has to appear on both.
//
// Same trap the achievement medals hit (verified-achievements-parity.test.ts):
// humans in production get the Pages Function SSR (functions/verified/
// [handle].ts) while the SPA route (src/pages/verified-seller.tsx) serves the
// in-app/dev render, and both consume the SAME edge payload. Add the field to one
// renderer and stop, and the other silently reads `undefined` — the chip just
// never appears, with nothing going red.
//
// The privacy half matters as much as the parity half: the flair is the ONLY
// piece of the ladder that goes public. XP totals stay private, because a public
// XP number turns a contribution ladder into a scoreboard strangers can rank
// sellers by. `publicLevelFlair` is the projection that enforces it — it is
// asserted here rather than the raw field list, so a future field added to the
// tier object cannot leak by being forgotten in a test.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const edgeRoute = readFileSync(
  "services/edge-functions/src/routes/content-public.ts",
  "utf8",
);
const ssr = readFileSync("functions/verified/[handle].ts", "utf8");
const spa = readFileSync("src/pages/verified-seller.tsx", "utf8");

/** The seller-payload block of the public profile route. */
const sellerHandler = edgeRoute.slice(edgeRoute.indexOf('"/sellers/:handle"'));

describe("verified profile level flair (US-1851 AC4)", () => {
  it("the edge seller payload carries the tier flair", () => {
    expect(sellerHandler).toContain("publicLevelFlair(");
    expect(sellerHandler).toContain("rewardLevelFor(seller.id)");
  });

  it("the level read is scoped to the profile's owner", () => {
    // US-268: the service-role client bypasses RLS, so an unscoped read here
    // would hand out another seller's level.
    const helper = edgeRoute.slice(edgeRoute.indexOf("async function rewardLevelFor"));
    expect(helper).toContain('.from("user_reward_state")');
    expect(helper).toContain('.eq("user_id", userId)');
  });

  it("only the public tier vocabulary crosses the wire", () => {
    // The chip carries the level, the tier name and its blurb. If xp_total ever
    // joins them, a stranger can rank sellers by raw contribution.
    expect(sellerHandler).not.toContain("xp_total");
  });

  it("the SSR profile renders the flair chip", () => {
    expect(ssr).toContain("data.level");
    expect(ssr).toContain("${flairHtml}");
    expect(ssr).toContain(".lv-flair"); // the chip has a style, not just markup
  });

  it("the SPA profile renders the flair chip", () => {
    expect(spa).toContain("data.level");
    expect(spa).toContain("flair.tier_name");
  });

  it("both renderers carry the blurb so the word means something", () => {
    // "Curator" is meaningless to a first-time visitor without the one-liner.
    expect(ssr).toContain("flair.tier_blurb");
    expect(spa).toContain("flair.tier_blurb");
  });

  it("neither renderer shows the flair at level 0", () => {
    // "Thrifter" on a brand-new profile reads as a downgrade rather than a
    // start, so the entry rung renders nothing at all.
    expect(ssr).toContain("flair.level > 0");
    expect(spa).toContain("data.level.level > 0");
  });
});
