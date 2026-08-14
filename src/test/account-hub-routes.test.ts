import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// US-2511. settings / billing / api-keys / team / referrals were each routed
// twice: as a tab of the Account hub, and standalone. The sidebar only ever
// linked the hub, so the standalone paths were reached from in-app links and
// from email — and they rendered the page with no tab strip and no way back.
//
// They now RENDER the hub with their tab preselected rather than redirecting to
// it. That choice is load-bearing and this test pins it: those five paths are
// baked into Stripe checkout return URLs, the legally-required cancellation
// link, the drip subscribe CTA, Stripe Connect's return, and the unsubscribe
// deep-link — which carries BOTH a child `?tab=notifications` and an
// `#email-preferences` hash. A client-side redirect would add a hop to a money
// path and a chance to drop either.
//
// The `?tab=` collision is the reason the fallback matters: `?tab=` is owned by
// the CHILD on /dashboard/settings, so an unrecognised value must fall through
// to initialTab instead of being treated as an error.

const ROUTES = "src/routes/index.tsx";
const ACCOUNT = "src/pages/account.tsx";

const LEGACY: Array<[string, string]> = [
  ["/dashboard/settings", "settings"],
  ["/dashboard/billing", "billing"],
  ["/dashboard/api-keys", "api-keys"],
  ["/dashboard/team", "team"],
  ["/dashboard/referrals", "referrals"],
];

const routes = readFileSync(resolve(process.cwd(), ROUTES), "utf8");
const account = readFileSync(resolve(process.cwd(), ACCOUNT), "utf8");

describe("the account hub owns its five legacy paths (US-2511)", () => {
  for (const [path, tab] of LEGACY) {
    it(`${path} renders the hub with tab="${tab}"`, () => {
      const line = routes
        .split("\n")
        .find((l) => l.includes(`path: "${path}"`));
      expect(line, `${path} is no longer routed`).toBeDefined();
      expect(
        line!.includes(`<AccountPage initialTab="${tab}" />`),
        `${path} must render <AccountPage initialTab="${tab}" /> so the tab ` +
          "strip is present. Do NOT convert it to a redirect — see the comment " +
          "on AccountPage's initialTab prop.",
      ).toBe(true);
    });
  }

  it("/dashboard/account is still the canonical hub route", () => {
    expect(routes).toContain('path: "/dashboard/account"');
  });

  it("an unknown ?tab= falls through to initialTab, not to an error", () => {
    // The unsubscribe email sends /dashboard/settings?tab=notifications, where
    // `tab` belongs to settings.tsx. The hub must not treat that as invalid and
    // land the user somewhere else.
    expect(account).toMatch(/initialTab && allowed\.has\(initialTab\)/);
    expect(account).toMatch(/raw && allowed\.has\(raw\) \? raw : fallback/);
  });

  it("the five legacy paths are not ALSO redirected somewhere", () => {
    for (const [path] of LEGACY) {
      const line = routes.split("\n").find((l) => l.includes(`path: "${path}"`));
      expect(line!.includes("Navigate")).toBe(false);
    }
  });
});
