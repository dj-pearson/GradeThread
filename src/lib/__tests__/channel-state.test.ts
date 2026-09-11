import { describe, expect, it } from "vitest";
import {
  type ChannelState,
  deriveChannelState,
  planListEverywhere,
} from "@/lib/channel-state";
import type { ItemListingRow } from "@/hooks/use-item-listings";
import type { ExtensionQueueItem } from "@/hooks/use-extension-queue";

// US-3367: one answer to "what is this item doing on this marketplace", read
// by the kit tab, the kit status row and the item page card.

function row(over: Partial<ItemListingRow>): ItemListingRow {
  return {
    id: "l1",
    platform: "poshmark",
    listing_status: "draft",
    listing_url: null,
    listing_title: null,
    listing_description: null,
    listing_price: null,
    quantity: 1,
    platform_offer_id: null,
    platform_listing_id: null,
    batch_id: null,
    synced_to_ebay_at: null,
    platform_fields: null,
    publish_error: null,
    publish_failed_at: null,
    delist_requested_at: null,
    updated_at: "2026-09-10T00:00:00Z",
    ...over,
  };
}

function q(over: Partial<ExtensionQueueItem>): ExtensionQueueItem {
  return {
    id: "q1",
    kind: "list",
    platform: "poshmark",
    inventory_item_id: "i1",
    listing_id: "l1",
    payload: {},
    status: "queued",
    attempts: 0,
    source: "web",
    claimed_at: null,
    completed_at: null,
    result: null,
    expires_at: "2026-09-18T00:00:00Z",
    created_at: "2026-09-11T00:00:00Z",
    ...over,
  };
}

const LIVE_URL = "https://poshmark.com/listing/x";

describe("deriveChannelState", () => {
  it("is none with no row and no queue item", () => {
    expect(deriveChannelState([], [], "poshmark").state).toBe("none");
  });

  it("is live for an active row, carrying the url", () => {
    const s = deriveChannelState(
      [row({ listing_status: "active", listing_url: LIVE_URL })],
      [],
      "poshmark",
    );
    expect(s.state).toBe("live");
    expect(s.url).toBe(LIVE_URL);
  });

  it("is queued while a list job is queued or claimed", () => {
    expect(deriveChannelState([row({})], [q({ status: "queued" })], "poshmark").state).toBe("queued");
    expect(deriveChannelState([row({})], [q({ status: "claimed" })], "poshmark").state).toBe("queued");
  });

  it("is delist_queued when a delist job is pending, and it beats live", () => {
    const s = deriveChannelState(
      [row({ listing_status: "active", listing_url: LIVE_URL })],
      [q({ kind: "delist", status: "queued" })],
      "poshmark",
    );
    expect(s.state).toBe("delist_queued");
  });

  it("is delist_queued when the row is ended with a delist stamp and no queue item", () => {
    const s = deriveChannelState(
      [row({ listing_status: "ended", delist_requested_at: "2026-09-11T00:00:00Z" })],
      [],
      "poshmark",
    );
    expect(s.state).toBe("delist_queued");
  });

  it("is prefilled for a draft row with no pending job", () => {
    expect(deriveChannelState([row({ listing_status: "draft" })], [], "poshmark").state).toBe("prefilled");
  });

  it("is failed when the latest queue item failed or expired, and that beats a draft row", () => {
    const s = deriveChannelState(
      [row({ listing_status: "draft" })],
      [q({ status: "failed", result: { error: "login wall" } })],
      "poshmark",
    );
    expect(s.state).toBe("failed");
    expect(s.queueItem?.result?.error).toBe("login wall");
    expect(deriveChannelState([row({})], [q({ status: "expired" })], "poshmark").state).toBe("failed");
  });

  it("an active row beats a stale done queue item", () => {
    const s = deriveChannelState(
      [row({ listing_status: "active", listing_url: LIVE_URL })],
      [q({ status: "done" })],
      "poshmark",
    );
    expect(s.state).toBe("live");
  });

  it("uses the newest queue item for the platform", () => {
    const s = deriveChannelState([row({})], [
      q({ id: "old", status: "failed", created_at: "2026-09-01T00:00:00Z" }),
      q({ id: "new", status: "queued", created_at: "2026-09-11T00:00:00Z" }),
    ], "poshmark");
    expect(s.state).toBe("queued");
    expect(s.queueItem?.id).toBe("new");
  });

  it("is ended / sold from the row status", () => {
    expect(deriveChannelState([row({ listing_status: "ended" })], [], "poshmark").state).toBe("ended");
    expect(deriveChannelState([row({ listing_status: "sold" })], [], "poshmark").state).toBe("sold");
  });

  it("ignores other platforms", () => {
    expect(
      deriveChannelState(
        [row({ platform: "mercari", listing_status: "active", listing_url: LIVE_URL })],
        [q({ platform: "mercari" })],
        "poshmark",
      ).state,
    ).toBe("none");
  });

  it("is unconfirmed for an active row with the marker and no url; a url makes it live", () => {
    const marked = { listed_unconfirmed: { at: "2026-09-11T00:00:00Z" } };
    expect(
      deriveChannelState([row({ listing_status: "active", platform_fields: marked })], [], "poshmark").state,
    ).toBe("unconfirmed");
    expect(
      deriveChannelState(
        [row({ listing_status: "active", platform_fields: marked, listing_url: LIVE_URL })],
        [],
        "poshmark",
      ).state,
    ).toBe("live");
  });

  it("drops a url that is not https", () => {
    const s = deriveChannelState(
      [row({ listing_status: "active", listing_url: "javascript:alert(1)" })],
      [],
      "poshmark",
    );
    expect(s.url).toBeNull();
  });
});

describe("planListEverywhere", () => {
  const st = (state: ChannelState) => ({ state, row: null, queueItem: null, url: null, since: null });

  it("pre-checks channels with nothing going on and disables live or queued ones with a reason", () => {
    const plan = planListEverywhere(["poshmark", "mercari", "grailed", "vinted"], {
      poshmark: st("live"),
      mercari: st("queued"),
      grailed: st("none"),
      vinted: st("failed"),
    });
    expect(plan.checked).toEqual(["grailed", "vinted"]);
    expect(plan.disabled).toEqual({ poshmark: "live", mercari: "queued" });
  });

  it("an unconfirmed channel is disabled with a question mark", () => {
    const plan = planListEverywhere(["poshmark"], { poshmark: st("unconfirmed") });
    expect(plan.checked).toEqual([]);
    expect(plan.disabled.poshmark).toBe("listed?");
  });

  it("a delist in flight is disabled too", () => {
    const plan = planListEverywhere(["poshmark"], { poshmark: st("delist_queued") });
    expect(plan.checked).toEqual([]);
    expect(plan.disabled.poshmark).toBe("ending");
  });

  it("prefilled and ended are offered but unchecked", () => {
    const plan = planListEverywhere(["poshmark", "mercari"], {
      poshmark: st("prefilled"),
      mercari: st("ended"),
    });
    expect(plan.checked).toEqual([]);
    expect(plan.disabled).toEqual({});
  });

  it("a platform with no status entry counts as none", () => {
    expect(planListEverywhere(["vinted"], {}).checked).toEqual(["vinted"]);
  });
});
