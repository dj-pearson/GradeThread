import { describe, it, expect } from "vitest";
import {
  badgeSettingFrom,
  isMissingBadgeColumn,
  LISTING_BADGE_QUERY_KEY,
} from "../listing-badge-setting";
import { ANALYTICS_EVENTS } from "../analytics-events";

// US-3060 AC2 (UI half) and AC6.
//
// Migration 00727 is applied separately from the deploy, so between the two this
// component runs against a schema with no `listing_badge_opt_out`. Every case
// below is about that window, because it is the one nobody will be watching.

describe("US-3060: the badge switch survives its own column not existing", () => {
  it("reads a stored opt-out", () => {
    expect(badgeSettingFrom({ listing_badge_opt_out: true }, null)).toEqual({
      optOut: true,
      writable: true,
    });
  });

  it("treats an absent row and an explicit false the same way", () => {
    // A seller who has never touched a FlipDesk setting has no row at all.
    // That is not a third state — they have not opted out.
    for (const row of [null, {}, { listing_badge_opt_out: null }, { listing_badge_opt_out: false }]) {
      expect(badgeSettingFrom(row, null), JSON.stringify(row)).toEqual({
        optOut: false,
        writable: true,
      });
    }
  });

  it("a MISSING COLUMN is 'not opted out' and NOT writable", () => {
    // This is the true answer rather than a lenient one: with no column and no
    // switch, nobody can have opted out yet. What is genuinely broken in that
    // window is the write, and `writable: false` is what says so — instead of
    // the switch taking a click and reporting a save that did not happen.
    for (const err of [
      { code: "42703", message: 'column flipdesk_settings.listing_badge_opt_out does not exist' },
      { message: 'column "listing_badge_opt_out" does not exist' },
      { code: "42703", message: "" },
    ]) {
      expect(badgeSettingFrom(null, err), JSON.stringify(err)).toEqual({
        optOut: false,
        writable: false,
      });
    }
  });

  it("any OTHER read failure stays WRITABLE, so a retry is a real save", () => {
    // The distinction that matters: a network blip must not disable the switch
    // for the rest of the session. It shows "not opted out" because a toggle
    // rendering a preference we could not read would be a claim we cannot
    // support, but the seller can still act on it.
    for (const err of [
      { code: "PGRST301", message: "JWT expired" },
      { message: "Failed to fetch" },
      { code: "500", message: "internal" },
    ]) {
      expect(badgeSettingFrom(null, err), JSON.stringify(err)).toEqual({
        optOut: false,
        writable: true,
      });
    }
  });

  it("tells a missing column apart from every other error", () => {
    expect(isMissingBadgeColumn({ code: "42703", message: "x" })).toBe(true);
    expect(isMissingBadgeColumn({ message: "listing_badge_opt_out is undefined" })).toBe(true);
    expect(isMissingBadgeColumn({ code: "PGRST116", message: "no rows" })).toBe(false);
    expect(isMissingBadgeColumn(null)).toBe(false);
    expect(isMissingBadgeColumn(undefined)).toBe(false);
    // A DIFFERENT column going missing is not this column going missing, or the
    // switch would silently disable itself over an unrelated schema problem.
    expect(isMissingBadgeColumn({ message: 'column "auto_end_cross_listings" does not exist' }))
      .toBe(false);
  });

  it("namespaces its query key so it cannot collide with the settings read", () => {
    // marketplaces.tsx already caches ["flipdesk_settings", userId] and that
    // query THROWS on error. Sharing a key would let this read's tolerated
    // failure overwrite a good auto-end value, or vice versa.
    expect(LISTING_BADGE_QUERY_KEY).toBe("flipdesk-listing-badge-opt-out");
    expect(LISTING_BADGE_QUERY_KEY).not.toBe("flipdesk_settings");
  });
});

describe("US-3060 AC6: the certificate arrival is a declared event", () => {
  it("registers badge_certificate_click", () => {
    expect("badge_certificate_click" in ANALYTICS_EVENTS).toBe(true);
  });

  it("documents the platform property and promises no listing id", () => {
    const note = ANALYTICS_EVENTS["badge_certificate_click"];
    expect(note).toMatch(/platform/);
    // The badge works without us learning what anyone browses, and the note is
    // where that promise is written down for whoever adds a property later.
    expect(note).not.toMatch(/listing_id|listingId|url/i);
  });
});
