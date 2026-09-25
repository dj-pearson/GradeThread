import { describe, expect, it } from "vitest";
import {
  ACCOUNT_HUB_TAB_VALUES,
  DEFAULT_REFERRAL_SECTION,
  isReferralSection,
  paletteMatches,
  REFERRAL_SECTIONS,
  referralPaletteActions,
  referralSectionHref,
} from "@/lib/settings-tabs";

describe("Referrals sections", () => {
  it("each section is a URL inside the Account hub", () => {
    expect(referralSectionHref("affiliate")).toBe("/dashboard/account?tab=referrals&section=affiliate");
    expect(ACCOUNT_HUB_TAB_VALUES).toContain("referrals");
    expect(REFERRAL_SECTIONS[0]).toBe(DEFAULT_REFERRAL_SECTION);
  });

  it("only the four sections are sections", () => {
    for (const s of REFERRAL_SECTIONS) expect(isReferralSection(s)).toBe(true);
    for (const s of ["boards", "", null, "tab", "Share"]) expect(isReferralSection(s)).toBe(false);
  });

  it("the palette reaches each section by what it holds", () => {
    const actions = referralPaletteActions();
    expect(actions.map((a) => a.section)).toEqual([...REFERRAL_SECTIONS]);
    const find = (q: string) =>
      actions.filter((a) => paletteMatches(a.label, a.keywords, q)).map((a) => a.section);
    expect(find("invite")).toEqual(["share"]);
    expect(find("stripe")).toEqual(["affiliate"]);
    expect(find("payout")).toEqual(["affiliate"]);
    expect(find("creator")).toEqual(["creator"]);
    expect(find("leaderboard")).toEqual(["leaderboard"]);
    for (const a of actions) expect(a.href).toBe(referralSectionHref(a.section));
  });
});
