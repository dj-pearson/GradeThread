// US-2721: which marketplaces a seller cross-posts to.
//
// ONE RULE CARRIES THIS WHOLE STORY: an empty selection means ALL, never none.
//
// Two states arrive as "nothing selected" - a seller who never opened the
// setting (null) and one who unticked the last box (an empty array). Reading
// either as "none" silently removes every channel from every draft for somebody
// who never asked for that, and they would have no way to tell whether it was
// their doing or a bug. The setting NARROWS what is offered; it cannot switch
// cross-posting off.
//
// The second rule is quieter and easier to get wrong: turning a channel off
// changes what is OFFERED. It must not reach back into items already listed
// there.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  filterChannels,
  isChannelEnabled,
  isChannelSelectable,
  normalizeSelection,
  unavailableChannels,
} from "@/lib/cross-post-channels";
import {
  CROSS_LISTING_PLATFORMS,
  MARKETPLACE_EXTENSION_FLOW,
} from "@/lib/constants";

describe("US-2721 AC6: nothing selected means ALL", () => {
  it("treats null as every channel", () => {
    // The state of every seller who has not visited the setting. They must keep
    // exactly what they have today.
    for (const p of CROSS_LISTING_PLATFORMS) {
      expect(isChannelEnabled(p, null), `${p} was hidden by a null selection`).toBe(true);
    }
  });

  it("treats an EMPTY ARRAY as every channel too", () => {
    // A seller who unticked the last box. Different state, same intent - and
    // this is the one a straightforward `selected.includes(p)` gets wrong.
    for (const p of CROSS_LISTING_PLATFORMS) {
      expect(isChannelEnabled(p, []), `${p} was hidden by an empty selection`).toBe(true);
    }
  });

  it("stores null rather than a frozen copy of today's channel list", () => {
    // A seller who ticks everything must still be offered the seventh channel
    // when it ships. Writing the full list would freeze them at six.
    const all = [...CROSS_LISTING_PLATFORMS];
    expect(normalizeSelection(all, all)).toBeNull();
    expect(normalizeSelection([], all)).toBeNull();
  });

  it("stores a real selection when it is a real narrowing", () => {
    const all = [...CROSS_LISTING_PLATFORMS];
    const picked = normalizeSelection(["poshmark", "mercari"], all);
    expect(picked).toEqual(["poshmark", "mercari"]);
  });

  it("drops a value that is not a channel, rather than storing it", () => {
    const all = [...CROSS_LISTING_PLATFORMS];
    expect(normalizeSelection(["poshmark", "not_a_channel"], all)).toEqual(["poshmark"]);
    // And a selection of ONLY junk is nothing, which means all - not a
    // selection that silently hides everything.
    expect(normalizeSelection(["not_a_channel"], all)).toBeNull();
  });

  it("de-duplicates", () => {
    const all = [...CROSS_LISTING_PLATFORMS];
    expect(normalizeSelection(["poshmark", "poshmark"], all)).toEqual(["poshmark"]);
  });
});

describe("US-2721 AC3: the selection narrows what is offered", () => {
  it("filters a platform list and keeps the caller's order", () => {
    // The caller's order is the order the seller sees; re-sorting here would
    // shuffle their tabs for no reason.
    const kit = ["poshmark", "mercari", "depop", "grailed"] as const;
    expect(filterChannels(kit, ["grailed", "poshmark"])).toEqual(["poshmark", "grailed"]);
  });

  it("returns everything when nothing is selected", () => {
    const kit = ["poshmark", "mercari"] as const;
    expect(filterChannels(kit, null)).toEqual(["poshmark", "mercari"]);
    expect(filterChannels(kit, [])).toEqual(["poshmark", "mercari"]);
  });
});

describe("US-2721 AC4: a channel whose flow is off says why", () => {
  it("refuses to select a channel that is not live", () => {
    const notLive = Object.entries(MARKETPLACE_EXTENSION_FLOW)
      .filter(([, flow]) => flow !== "live")
      .map(([p]) => p);
    // Guard the guard: if every channel goes live this test would pass
    // vacuously, and that is worth noticing rather than silently allowing.
    expect(notLive.length, "no channel is off — this case now proves nothing").toBeGreaterThan(0);
    for (const p of notLive) {
      expect(isChannelSelectable(p), `${p} is selectable but its flow is off`).toBe(false);
    }
  });

  it("keeps API channels selectable — the flow map only speaks about extension ones", () => {
    // eBay and Shopify are not in MARKETPLACE_EXTENSION_FLOW at all. Reading an
    // absent entry as "off" would quietly remove the two channels that work
    // best.
    expect(isChannelSelectable("ebay")).toBe(true);
    expect(isChannelSelectable("shopify")).toBe(true);
  });

  it("names the unavailable channels with a reason, rather than hiding them", () => {
    const listed = unavailableChannels();
    expect(listed.length).toBeGreaterThan(0);
    for (const entry of listed) {
      expect(entry.reason.length, `${entry.platform} has no reason`).toBeGreaterThan(20);
    }
  });
});

describe("US-2721 AC5: turning a channel off never hides an existing listing", () => {
  // The property is structural, so it is checked structurally: the selection is
  // read by the two surfaces that OFFER channels, and by nothing that RENDERS
  // what is already listed. A seller who turns Depop off and finds their live
  // Depop listing gone from the item would reasonably think we deleted it.
  const OFFERS = [
    "src/components/flipdesk/composer/push-to-card.tsx",
    "src/components/flipdesk/listing-kit.tsx",
  ];
  const RENDERS_EXISTING = [
    "src/pages/flipdesk/marketplaces.tsx",
    "src/components/flipdesk/item-listings.tsx",
    "src/pages/flipdesk/item.tsx",
  ];

  function read(rel: string): string | null {
    try {
      return readFileSync(resolve(process.cwd(), rel), "utf8");
    } catch {
      return null;
    }
  }

  it("both offering surfaces NARROW by the selection, not merely mention it", () => {
    // Checked on the narrowing call, not on the hook name. Sabotage deleted the
    // import from the Listing Kit and this still passed, because the hook CALL
    // was still in the file - "the string appears somewhere" is not "the list
    // is filtered".
    for (const rel of OFFERS) {
      const src = read(rel);
      expect(src, `${rel} is missing`).not.toBeNull();
      expect(
        src!.includes("useCrossPostChannels"),
        `${rel} does not read the seller's channel selection`,
      ).toBe(true);
      // US-3046: the Listing Kit narrows through kitPlatformsFor (src/lib/
      // kit-platforms.ts), which is filterChannels plus the never-empty
      // fallback; kit-platforms.test.ts pins that it narrows. Either call is
      // the narrowing call. The bare hook name is still not.
      expect(
        src!.includes("filterChannels(") || src!.includes("kitPlatformsFor("),
        `${rel} reads the selection and then offers every channel anyway`,
      ).toBe(true);
    }
  });

  it("the Listing Kit generates for the NARROWED list, not the full one", () => {
    // The tabs and the generate call must agree. Narrowing only the tabs would
    // still spend an AI call per unselected marketplace on every generate,
    // which is the cost half of this story.
    const src = read("src/components/flipdesk/listing-kit.tsx")!;
    expect(src).toMatch(/platforms: kitPlatforms/);
    expect(
      /platforms: KIT_PLATFORMS/.test(src),
      "generate() still asks for every channel",
    ).toBe(false);
  });

  it("no surface that renders EXISTING listings filters them by the selection", () => {
    const offenders: string[] = [];
    for (const rel of RENDERS_EXISTING) {
      const src = read(rel);
      if (!src) continue;
      // The picker itself lives on the Marketplaces page, so reading the hook
      // there is expected. What must not appear is the narrowing helper being
      // applied to listings.
      if (src.includes("filterChannels(")) offenders.push(rel);
    }
    expect(
      offenders,
      "these render listings that already exist and now filter them by the " +
        "cross-post selection. Turning a channel off must not make a live " +
        "listing disappear from the item.",
    ).toEqual([]);
  });
});

describe("US-2721: the picker says what the setting does", () => {
  const picker = readFileSync(
    resolve(process.cwd(), "src/components/flipdesk/cross-post-channel-picker.tsx"),
    "utf8",
  );

  it("tells the seller that all-off means all-on", () => {
    // Otherwise the honest behaviour reads as a bug the first time somebody
    // unticks everything and the channels stay.
    // Whitespace-tolerant: JSX copy wraps, so the sentence is split across
    // lines in the source even though the seller reads it as one.
    expect(picker.replace(/\s+/g, " ")).toMatch(
      /turning them all off does the same thing/i,
    );
  });

  it("tells the seller their existing listings are untouched", () => {
    expect(picker.replace(/\s+/g, " ")).toMatch(/already listed on a channel you turn off/i);
  });

  it("starts from what is EFFECTIVE, not from what is stored", () => {
    // With nothing stored every channel is on, so unticking one must write the
    // other five. Starting from the stored value would write a single-entry
    // list and turn five channels off in one click.
    expect(picker).toMatch(/selectable\.filter\(\(p\) => isChannelEnabled\(p, stored\)\)/);
  });
});
