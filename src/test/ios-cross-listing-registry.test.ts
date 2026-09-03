import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CROSS_LISTING_PLATFORMS,
  MARKETPLACE_MECHANISM,
  MARKETPLACE_TIER,
} from "@/lib/constants";

// US-3103: the iOS cross-listing registry must not drift from the TypeScript.
//
// `ios/GradeThread/Marketplaces/CrossListingRegistry.swift` is a hand-mirror of
// three constants in `src/lib/constants.ts`. Swift cannot be compiled on a
// Linux dev box or in `npm run verify`, so a guard written as an XCTest would
// only run on the macOS CI job — and a channel badge that overstates what a
// seller can do is precisely the failure that must not wait for a slower lane.
//
// This is not a theoretical drift. Mercari, Grailed and Vinted rendered
// "Connect via browser extension" for months while their selectors sat disabled
// and every attempt reported "list manually for now" (US-2477..US-2480). A
// seller reading the badge cross-posted into nothing and found out days later.
//
// The parse is deliberately literal: it reads the Swift source as text rather
// than executing anything, so it works everywhere and fails loudly when the
// file's shape changes rather than passing on an empty match.

const SWIFT_PATH = resolve(
  __dirname,
  "../../ios/GradeThread/Marketplaces/CrossListingRegistry.swift",
);

interface SwiftChannel {
  id: string;
  label: string;
  tier: string;
  mechanism: string;
}

/** The `Channel(...)` literals in the registry's `channels` array. */
function parseSwiftChannels(source: string): SwiftChannel[] {
  const start = source.indexOf("static let channels:");
  expect(start, "CrossListingRegistry.channels has been renamed or removed").toBeGreaterThan(-1);
  const end = source.indexOf("\n    ]", start);
  expect(end, "could not find the end of the channels array").toBeGreaterThan(start);

  const body = source.slice(start, end);
  const pattern =
    /Channel\(\s*id:\s*"([^"]+)",\s*label:\s*"([^"]+)",\s*tier:\s*\.(\w+),\s*mechanism:\s*\.(\w+)\s*\)/g;

  const out: SwiftChannel[] = [];
  for (const match of body.matchAll(pattern)) {
    const [, id, label, tier, mechanism] = match;
    // Every group is non-optional in the pattern, but `matchAll` types them as
    // possibly-undefined. Skipping rather than asserting keeps the "parses a
    // real list" test below as the thing that catches a broken regex.
    if (!id || !label || !tier || !mechanism) continue;
    out.push({ id, label, tier, mechanism });
  }
  return out;
}

/** Swift enum case name → the TypeScript string it mirrors. */
const TIER_CASE_TO_TS: Record<string, string> = {
  api: "api",
  apiPending: "api_pending",
  extensionLister: "extension",
  comingSoon: "coming_soon",
};

const MECHANISM_CASE_TO_TS: Record<string, string> = {
  api: "api",
  extensionLister: "extension",
  none: "none",
};

describe("US-3103: the iOS cross-listing registry mirrors src/lib/constants.ts", () => {
  const source = readFileSync(SWIFT_PATH, "utf8");
  const channels = parseSwiftChannels(source);

  it("parses a real list rather than passing on an empty match", () => {
    // Without this, a rename that broke the regex would make every assertion
    // below vacuously true — the classic way a drift guard stops guarding.
    expect(channels.length).toBeGreaterThan(3);
  });

  it("covers every cross-listing platform except eBay", () => {
    // eBay is excluded deliberately: it has its own publish path with its own
    // policies, specifics and format, which is the composer this sheet opens
    // from. Two ways to publish to eBay carrying different fields is worse than
    // one.
    const expected = CROSS_LISTING_PLATFORMS.filter((p) => p !== "ebay");
    expect(channels.map((c) => c.id)).toEqual([...expected]);
  });

  it("gives every channel the tier the TypeScript gives it", () => {
    for (const channel of channels) {
      const tsTier = MARKETPLACE_TIER[channel.id as keyof typeof MARKETPLACE_TIER];
      expect(
        TIER_CASE_TO_TS[channel.tier],
        `${channel.id}: Swift tier .${channel.tier} is not a known case`,
      ).toBeDefined();
      expect(
        TIER_CASE_TO_TS[channel.tier],
        `${channel.id}: iOS says ${TIER_CASE_TO_TS[channel.tier]}, constants.ts says ${tsTier}`,
      ).toBe(tsTier);
    }
  });

  it("gives every channel the mechanism the TypeScript gives it", () => {
    for (const channel of channels) {
      const tsMechanism =
        MARKETPLACE_MECHANISM[channel.id as keyof typeof MARKETPLACE_MECHANISM];
      expect(
        MECHANISM_CASE_TO_TS[channel.mechanism],
        `${channel.id}: iOS says ${MECHANISM_CASE_TO_TS[channel.mechanism]}, constants.ts says ${tsMechanism}`,
      ).toBe(tsMechanism);
    }
  });

  it("declares the four tier cases the TypeScript union has", () => {
    // A tier added to the TypeScript and not here would fall through to a
    // default somewhere in Swift and render as something it is not.
    for (const swiftCase of Object.keys(TIER_CASE_TO_TS)) {
      expect(source).toContain(`case ${swiftCase}`);
    }
  });

  it("only lets api and extension channels be selected", () => {
    // `api_pending` is built-but-unapproved: a push would fail at the
    // marketplace with an error the seller cannot act on, so the chip must not
    // be selectable. That rule lives in Swift; this asserts the source says so.
    const selectable = source.slice(source.indexOf("var isSelectable: Bool"));
    expect(selectable).toContain("case .api, .extensionLister: return true");
    expect(selectable).toContain("case .apiPending, .comingSoon: return false");
  });
});
