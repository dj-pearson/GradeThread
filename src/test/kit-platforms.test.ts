// US-3046: the kit's channel list and the two rules the web reads off the
// seller's selection. The edge holds the same list (cross-list-kit.ts) with a
// stricter rule for the unprompted batch; its test pins the same order.
import { describe, expect, it } from "vitest";
import {
  channelsNeverChosen,
  KIT_PLATFORMS,
  kitPlatformsFor,
} from "@/lib/kit-platforms";

describe("KIT_PLATFORMS", () => {
  it("is the five copy-paste channels in tab order, matching the edge", () => {
    expect(KIT_PLATFORMS).toEqual(["poshmark", "mercari", "depop", "grailed", "vinted"]);
  });
});

describe("kitPlatformsFor (the kit's own button)", () => {
  it("never chosen and unticked-all both mean every channel", () => {
    expect(kitPlatformsFor(null)).toEqual(KIT_PLATFORMS);
    expect(kitPlatformsFor(undefined)).toEqual(KIT_PLATFORMS);
    expect(kitPlatformsFor([])).toEqual(KIT_PLATFORMS);
  });

  it("narrows to the chosen channels, in tab order", () => {
    expect(kitPlatformsFor(["vinted", "poshmark"])).toEqual(["poshmark", "vinted"]);
  });

  it("an API-only selection still renders the full kit rather than no tabs", () => {
    expect(kitPlatformsFor(["ebay", "shopify"])).toEqual(KIT_PLATFORMS);
  });
});

describe("channelsNeverChosen", () => {
  it("is true only for null, the state where the batch writes no kit", () => {
    expect(channelsNeverChosen(null)).toBe(true);
    expect(channelsNeverChosen(undefined)).toBe(true);
    expect(channelsNeverChosen([])).toBe(false);
    expect(channelsNeverChosen(["mercari"])).toBe(false);
  });
});
