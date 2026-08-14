import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// US-2529. Five auth routes rendered with whatever <title> index.html shipped
// with, so a saved tab read "GradeThread" and told the visitor nothing. Worse,
// the two routes that carry a token in the URL — the email confirmation and the
// OAuth callback — asked for no indexing decision at all.

const TITLED = ["src/pages/login.tsx", "src/pages/signup.tsx"];

const NOINDEXED = [
  "src/pages/reset-password.tsx",
  "src/pages/auth-confirm.tsx",
  "src/pages/auth-callback.tsx",
  "src/pages/waitlist-pending.tsx",
];

function read(rel: string): string {
  return readFileSync(resolve(process.cwd(), rel), "utf8");
}

describe("every auth page states a title and an indexing decision (US-2529)", () => {
  it("sign-in and sign-up carry a real title and description", () => {
    for (const rel of TITLED) {
      const src = read(rel);
      expect(src, `${rel} renders no SEO`).toMatch(/<SEO\b/);
      expect(src, `${rel} has no title`).toMatch(/title="[^"]{4,}"/);
      expect(src, `${rel} has no description`).toMatch(
        /description="[^"]{20,}"/,
      );
    }
  });

  it("every page reached with a token in the URL is noindex", () => {
    for (const rel of NOINDEXED) {
      const src = read(rel);
      expect(src, `${rel} renders no SEO`).toMatch(/<SEO\b/);
      expect(src, `${rel} is indexable`).toMatch(/noindex/);
    }
  });

  it("the SEO block is the first thing the page renders", () => {
    // Not cosmetic: <SEO> writes the head in an effect, and a page that returns
    // early — a loading branch, a redirect — before reaching it leaves the
    // previous page's title in the tab.
    for (const rel of [...TITLED, ...NOINDEXED]) {
      const src = read(rel).replace(/\r\n/g, "\n");
      const returnAt = src.indexOf("\n  return (");
      const seoAt = src.indexOf("<SEO");
      expect(seoAt, `${rel} has no SEO`).toBeGreaterThan(-1);
      // Within a few lines of the render root, not buried at the bottom.
      const between = src.slice(returnAt, seoAt);
      expect(
        between.split("\n").length,
        `${rel} renders SEO far below its render root`,
      ).toBeLessThan(8);
    }
  });

  it("the referral leaderboard's SEO comes from its layout, not a second copy", () => {
    // It is registered in PUBLIC_ROUTES and prerendered; MarketingLayout already
    // renders the SEO block from the same title and description. A hand-added
    // <SEO> here would be a second source for one page's head.
    const src = read("src/pages/referral-leaderboard.tsx");
    expect(src).toMatch(/<MarketingLayout/);
    expect(src).toMatch(/canonicalPath="\/leaderboard"/);
    expect(src).not.toMatch(/<SEO\b/);
  });
});
