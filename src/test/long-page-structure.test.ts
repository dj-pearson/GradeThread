import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// US-2543. Four settings pages had grown to one long scroll: rewards 9 panels,
// referrals 8, flipdesk/verified 7, flipdesk/marketplaces 8. Finding one setting
// meant reading past all the others, and on Marketplaces the single question an
// operator opens the page to answer - which platforms am I connected to - was
// only answerable by reading the whole thing.

function read(rel: string): string {
  return readFileSync(resolve(process.cwd(), rel), "utf8");
}

const PAGES = [
  { rel: "src/pages/rewards.tsx", tabs: ["standing", "season", "perks"] },
  { rel: "src/pages/referrals.tsx", tabs: ["share", "affiliate", "boards"] },
  { rel: "src/pages/flipdesk/verified.tsx", tabs: ["profile", "badges", "passport"] },
  {
    // US-3032 added "ads". Connections had absorbed seven eBay advertising
    // cards, which is the same growth this story split the page for.
    rel: "src/pages/flipdesk/marketplaces.tsx",
    tabs: ["connections", "ads", "settings", "how"],
  },
];

describe("long settings pages are grouped (US-2543)", () => {
  for (const page of PAGES) {
    it(`${page.rel} splits into named tabs`, () => {
      const src = read(page.rel);
      expect(src, "no Tabs import").toMatch(/from "@\/components\/ui\/tabs"/);
      for (const value of page.tabs) {
        expect(src, `missing the "${value}" tab`).toContain(
          `<TabsTrigger value="${value}">`,
        );
        expect(src, `"${value}" has a trigger but no content`).toContain(
          `<TabsContent value="${value}"`,
        );
      }
    });

    it(`${page.rel} opens on its most-used tab`, () => {
      const src = read(page.rel);
      // defaultValue must name a tab that exists. A default pointing at a value
      // no trigger declares renders an empty page, and nothing else here would
      // catch it.
      const m = /<Tabs defaultValue="([a-z-]+)"/.exec(src);
      expect(m, "no defaultValue on <Tabs>").not.toBeNull();
      expect(page.tabs).toContain(m![1]);
      expect(m![1], "the default should be the first tab").toBe(page.tabs[0]);
    });
  }
});

describe("marketplaces answers its own question first (US-2543 AC3)", () => {
  it("the connection summary renders above the tabs", () => {
    const src = read("src/pages/flipdesk/marketplaces.tsx");
    const summary = src.indexOf("<MarketplaceConnectionSummary");
    const tabs = src.indexOf("<Tabs defaultValue=");
    expect(summary, "summary not mounted").toBeGreaterThan(-1);
    expect(summary, "summary must come before the tabs").toBeLessThan(tabs);
  });

  it("it reads every connection the page can hold, not just eBay", () => {
    const src = read("src/components/flipdesk/marketplace-connection-summary.tsx");
    for (const hook of [
      "useEbayConnection",
      "useEbayConnectionIssue",
      "useShopifyConnection",
      "useGoogleConnection",
    ]) {
      expect(src, `${hook} not read`).toContain(hook);
    }
  });

  it("a revoked connection is not reported as simply off", () => {
    // The whole point of pulling in useEbayConnectionIssue: "never connected"
    // and "your grant was revoked, sign in again" need different words, or a
    // seller sits for a week wondering why nothing syncs.
    const src = read("src/components/flipdesk/marketplace-connection-summary.tsx");
    expect(src).toContain("ebayNeedsReauth");
    expect(src).toMatch(/attention/);
  });
});

describe("the verified profile can be seen while it is configured (US-2543 AC4)", () => {
  it("the preview is bound to the unsaved form values", () => {
    const src = read("src/pages/flipdesk/verified.tsx");
    expect(src).toContain("<VerifiedProfilePreview");
    // Bound to the live form state, not to data.profile.* - otherwise it shows
    // the last SAVED profile and the preview is a lie while you type.
    expect(src).toMatch(/handle=\{normalizedHandle\}/);
    expect(src).toMatch(/displayName=\{displayName\}/);
    expect(src).toMatch(/bio=\{bio\}/);
  });

  it("it says when the profile is not published", () => {
    const src = read("src/components/verified/profile-preview.tsx");
    expect(src).toContain("Not published yet");
  });
});

describe("the promo-code box left the referrals page (US-2543 AC5)", () => {
  it("referrals no longer redeems campaign codes", () => {
    const src = read("src/pages/referrals.tsx");
    expect(src, "the campaign-code state is still here").not.toContain(
      "campaignCode",
    );
    expect(src, "the redeem handler is still here").not.toContain(
      "campaign-codes/redeem",
    );
  });

  it("billing does, beside the credit balance it actually affects", () => {
    const src = read("src/pages/billing.tsx");
    expect(src).toContain("<PromoCodeRedeemer />");
    const redeemer = read("src/components/billing/promo-code-redeemer.tsx");
    expect(redeemer).toContain("/api/referrals/campaign-codes/redeem");
    // A code that grants credits must refresh the balance shown next to it.
    expect(redeemer).toContain('queryKey: ["billing_summary"]');
  });

  it("a friend's referral code still lives on the referrals page", () => {
    // AC5 moves the CAMPAIGN code only. Moving the referral code too would
    // break the page's actual job.
    const src = read("src/pages/referrals.tsx");
    expect(src).toContain("Were you referred?");
  });
});
