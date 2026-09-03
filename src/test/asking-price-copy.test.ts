import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// US-3107 — while the Marketplace Insights grant is ungranted, every price the
// product shows is an ASKING price.
//
// The distinction is not pedantry. An asking price is the right input for a
// sourcing ceiling and the wrong one for how fast something sells: sellers ask
// what they hope for, and the realized number is routinely lower. A reseller who
// reads "comps" and thinks "sold" pays too much for the item in their hand, and
// there is nothing on the screen that would tell them.
//
// So the copy says "asking prices" in those words — and this test is what stops
// that quietly ceasing to be true in either direction:
//
//   • Someone edits the disclaimer for length and the qualifier goes with it.
//   • Someone flips EBAY_MARKETPLACE_INSIGHTS to true, the prices become sold
//     prices, and the copy still says asking. That failure is the useful one:
//     the flag's whole risk is that a number changes meaning with no sentence
//     changing alongside it.
//
// The switch is read from `services/edge-functions/.env.example`, which is the
// repository's record of the intended default and the file US-3107's own
// acceptance criterion says to change. Prod is set in Coolify and this cannot
// see it; the point is that the copy and the documented intent move together.

const ROOT = resolve(__dirname, "../..");
const EDGE_ENV_EXAMPLE = resolve(ROOT, "services/edge-functions/.env.example");
const WEB_SCOUT = resolve(ROOT, "src/pages/flipdesk/scout.tsx");
const IOS_SCOUT = resolve(ROOT, "ios/GradeThread/Scout/ScoutView.swift");
const IOS_PROSPECT = resolve(ROOT, "ios/GradeThread/Prospect/ProspectView.swift");

/** Whitespace-collapsed, so JSX line wrapping does not decide whether a phrase exists. */
function flat(path: string): string {
  return readFileSync(path, "utf8").replace(/\s+/g, " ");
}

function marketplaceInsightsIntended(): boolean {
  const env = readFileSync(EDGE_ENV_EXAMPLE, "utf8");
  const line = env.match(/^EBAY_MARKETPLACE_INSIGHTS=(.*)$/m)?.[1];
  expect(line, "EBAY_MARKETPLACE_INSIGHTS left .env.example").toBeDefined();
  return (line ?? "").trim().toLowerCase() === "true";
}

const WHEN_GRANTED =
  "The Marketplace Insights grant has landed (EBAY_MARKETPLACE_INSIGHTS=true in " +
  "services/edge-functions/.env.example), so these prices are SOLD prices and the " +
  "disclaimer must stop calling them asking prices. Reword it, then invert this test.";

describe("asking-price copy (US-3107)", () => {
  it("the flag is off, which is what makes every claim below the right one", () => {
    // Stated as its own case so a future reader sees the premise fail first
    // rather than three confusing copy assertions.
    expect(marketplaceInsightsIntended(), WHEN_GRANTED).toBe(false);
  });

  it("web Scout says the values are asking prices, not sold prices", () => {
    const src = flat(WEB_SCOUT);
    expect(src, WHEN_GRANTED).toContain("asking prices, not sold prices");
  });

  it("iOS Scout says the same thing in the same words", () => {
    // The same words on purpose. Two surfaces describing one number with two
    // different hedges is how a seller learns to trust neither.
    const src = flat(IOS_SCOUT);
    expect(src, WHEN_GRANTED).toContain("asking prices, not sold prices");
  });

  it("iOS Prospect names asking prices in its opening line, not in a footnote", () => {
    // Prospect is iOS-only by ADR (vault/60-decisions/adr-prospect-stays-phone-only.md),
    // so there is no web half to check. The seller is standing in a shop with the
    // item in their hand; the qualifier has to arrive before the number does.
    const src = flat(IOS_PROSPECT);
    expect(src, WHEN_GRANTED).toContain("pull eBay asking prices");
  });

  it("no client disclaimer calls an active listing a sold comp", () => {
    // The failure this is aimed at is a rewrite that reaches for the shorter
    // word. "Sold comps" is a claim about realized transactions we cannot make
    // until the grant lands.
    for (const path of [WEB_SCOUT, IOS_SCOUT, IOS_PROSPECT]) {
      const src = flat(path).toLowerCase();
      const claimsSold = /(?:from|based on|using) (?:condition-matched )?sold (?:comps|prices|listings)/;
      expect(src, `${path} claims sold data. ${WHEN_GRANTED}`).not.toMatch(claimsSold);
    }
  });

  it("the edge still gates the sold-price path on the flag", () => {
    // If this ever reads sold data unconditionally, the copy above is wrong
    // whatever .env.example says.
    const client = readFileSync(
      resolve(ROOT, "services/edge-functions/src/lib/ebay-client.ts"),
      "utf8",
    );
    expect(client).toContain('Deno.env.get("EBAY_MARKETPLACE_INSIGHTS")');
  });
});
