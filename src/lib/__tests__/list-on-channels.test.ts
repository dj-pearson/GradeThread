import { describe, expect, it } from "vitest";
import {
  API_CROSS_LISTING_PLATFORMS,
  EXTENSION_CROSS_LISTING_PLATFORMS,
  MARKETPLACE_EXTENSION_FLOW,
  MARKETPLACE_TIER,
  type CrossPushPlatform,
} from "@/lib/constants";
import { filterChannels, isChannelSelectable } from "@/lib/cross-post-channels";
import type { ChannelStatus } from "@/lib/channel-state";
import { listOnRows, summarizeCrossPush } from "@/lib/list-on-channels";
import type { CrossPushPlatformResult } from "@/hooks/use-cross-listing";

// US-3450: the one List on panel offers exactly what the two controls it
// replaced offered between them, and blocks a row for the reasons each of
// them blocked it.

function status(state: ChannelStatus["state"]): ChannelStatus {
  return { state, row: null, queueItem: null, url: null, since: null };
}

describe("listOnRows (US-3450 AC3)", () => {
  it("offers the union of the API and extension channel lists, API first", () => {
    const rows = listOnRows(null, {});
    expect(rows.map((r) => r.platform)).toEqual([
      ...API_CROSS_LISTING_PLATFORMS,
      ...EXTENSION_CROSS_LISTING_PLATFORMS,
    ]);
    for (const r of rows) {
      expect(r.mechanism).toBe(
        (API_CROSS_LISTING_PLATFORMS as readonly string[]).includes(r.platform) ? "api" : "extension",
      );
    }
  });

  it("narrows by the seller's selection the way both old controls did (US-2721)", () => {
    const chosen = ["ebay", "poshmark"];
    const rows = listOnRows(chosen, {});
    expect(rows.map((r) => r.platform)).toEqual([
      ...filterChannels(API_CROSS_LISTING_PLATFORMS, chosen),
      ...filterChannels(EXTENSION_CROSS_LISTING_PLATFORMS, chosen),
    ]);
    // Empty means all, never none.
    expect(listOnRows([], {}).length).toBe(listOnRows(null, {}).length);
  });

  it("blocks what the Push-to card blocked: an API channel awaiting approval", () => {
    for (const r of listOnRows(null, {})) {
      if (MARKETPLACE_TIER[r.platform] === "api_pending") {
        expect(r.blocked, r.platform).toMatch(/coming once approved/i);
      }
    }
  });

  it("blocks what the kit blocked: an extension channel whose list flow is not live", () => {
    for (const r of listOnRows(null, {})) {
      if (r.mechanism === "extension" && !isChannelSelectable(r.platform)) {
        expect(r.blocked, r.platform).toBe("You list it");
        expect(MARKETPLACE_EXTENSION_FLOW[r.platform as keyof typeof MARKETPLACE_EXTENSION_FLOW]).not.toBe("live");
      }
    }
  });

  it("blocks a channel the item is already on, in the checklist's words (US-3367)", () => {
    const rows = listOnRows(["ebay", "poshmark", "mercari"], {
      ebay: status("live"),
      poshmark: status("queued"),
      mercari: status("delist_queued"),
    });
    const by = Object.fromEntries(rows.map((r) => [r.platform, r.blocked]));
    expect(by.ebay).toBe("live");
    expect(by.poshmark).toBe("queued");
    expect(by.mercari).toBe("ending");
  });

  it("leaves a channel with no row, an ended row or a failed job tickable", () => {
    const rows = listOnRows(["ebay", "poshmark", "mercari"], {
      ebay: status("prefilled"),
      poshmark: status("failed"),
      mercari: status("ended"),
    });
    for (const r of rows) expect(r.blocked, r.platform).toBeNull();
  });
});

describe("summarizeCrossPush (US-3450 AC2)", () => {
  const r = (over: Partial<CrossPushPlatformResult>): CrossPushPlatformResult => ({
    ok: true,
    listing_row_id: "row",
    price: 10,
    ...over,
  });

  it("sorts every outcome into the vocabulary both buttons toast", () => {
    const platforms: CrossPushPlatform[] = ["ebay", "shopify", "poshmark", "mercari", "grailed", "vinted"];
    const s = summarizeCrossPush(
      {
        ebay: r({}),
        shopify: r({ ok: false, status: 501 }),
        poshmark: r({ queued: true }),
        mercari: r({ skipped: "already_live" }),
        grailed: r({ skipped: "already_queued" }),
        vinted: r({ ok: false, blockers: ["Add a size"] }),
      },
      platforms,
    );
    expect(s.published).toEqual(["eBay"]);
    expect(s.stubbed).toEqual(["Shopify"]);
    expect(s.queued).toEqual(["Poshmark"]);
    expect(s.live).toEqual(["Mercari"]);
    expect(s.waiting).toEqual(["Grailed"]);
    expect(s.blocked).toEqual(["Vinted: Add a size"]);
  });

  it("ignores a platform the server did not answer for", () => {
    const s = summarizeCrossPush({}, ["ebay"]);
    expect(Object.values(s).every((list) => list.length === 0)).toBe(true);
  });
});
