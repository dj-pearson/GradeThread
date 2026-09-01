import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pendingRevisesForItem, reviseFlowLive, staleSinceLabel, type PendingRevise } from "@/hooks/use-pending-revises";
import { MARKETPLACE_EXTENSION_FLOWS } from "@/lib/constants";

// US-9202: the web half of edit sync. The row must say STALE, name the
// channel and the date, and never say applied on its own; the surfaces that
// matter (Listings table, item page, popup) must all read the one queue; and
// every save path that changes a revisable field must queue.

const ROOT = join(__dirname, "..", "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

const row: PendingRevise = {
  listing_id: "L1",
  platform: "poshmark",
  listing_url: "https://poshmark.com/listing/x",
  listing_status: "active",
  fields: ["price"],
  queued_at: "2026-09-01T10:00:00.000Z",
  source: "edit",
  attempts: 0,
  last_error: null,
  auto_revisable: true,
  item_id: "I1",
  item_title: "Tee",
  listing_title: "Tee",
  listing_description: null,
  listing_price: 24,
  photo_count: 0,
};

describe("stale wording", () => {
  it("names the channel and the date it went stale, never 'updated'", () => {
    const s = staleSinceLabel(row, "Poshmark");
    expect(s).toMatch(/^Stale on Poshmark since /);
    expect(s).not.toMatch(/updated|applied/i);
  });

  it("filters the queue to one item for the item page", () => {
    expect(pendingRevisesForItem([row, { ...row, listing_id: "L2", item_id: "I2" }], "I1").map((p) => p.listing_id)).toEqual(["L1"]);
  });

  it("offers Apply only where the extension's revise flow is switched on", () => {
    for (const p of Object.keys(MARKETPLACE_EXTENSION_FLOWS)) {
      expect(reviseFlowLive(p)).toBe(MARKETPLACE_EXTENSION_FLOWS[p as keyof typeof MARKETPLACE_EXTENSION_FLOWS].revise === "live");
    }
    expect(reviseFlowLive("ebay")).toBe(false);
  });
});

describe("the surfaces read the one queue", () => {
  it("Listings table shows the stale badge from usePendingRevises", () => {
    const src = read("src/pages/flipdesk/listings-table.tsx");
    expect(src).toMatch(/usePendingRevises\(\)/);
    expect(src).toMatch(/staleSinceLabel\(/);
  });
  it("item page and listings page mount the banner", () => {
    expect(read("src/pages/flipdesk/item.tsx")).toMatch(/<PendingReviseBanner itemId=\{item\.id\} \/>/);
    expect(read("src/pages/flipdesk/listings.tsx")).toMatch(/<PendingReviseBanner \/>/);
  });
  it("the banner clears a marker only on the marketplace's word or the seller's explicit one", () => {
    const src = read("src/hooks/use-pending-revises.ts");
    expect(src).toMatch(/const applied = res\.ok === true && res\.revised === true;/);
    expect(src).toMatch(/useMarkReviseDone/);
  });
});

describe("every save path queues", () => {
  it("the composer queues title and description saves", () => {
    const src = read("src/pages/flipdesk/composer.tsx");
    expect(src).toMatch(/queueRevise\.mutate\(\{ itemId: item\.id, fields: \["title"\] \}/);
    expect(src).toMatch(/queueRevise\.mutate\(\{ itemId: item\.id, fields: \["title", "description"\] \}/);
  });
  it("the photo manager queues photo changes", () => {
    expect(read("src/components/flipdesk/photo-manager.tsx")).toMatch(/queueRevise\.mutate\(\{ itemId, fields: \["photos"\] \}/);
  });
  it("a single reprice says queued, not updated, on an extension channel", () => {
    const src = read("src/pages/flipdesk/listings-actions.ts");
    expect(src).toMatch(/if \(res\.queued\)/);
    expect(src).toMatch(/reads Stale until then/);
  });
  it("the bulk price page counts queued rows separately", () => {
    expect(read("src/pages/flipdesk/bulk-pricing.tsx")).toMatch(/wait for your desktop extension/);
  });
  it("the automation log says queued vs applied", () => {
    expect(read("src/pages/flipdesk/automations.tsx")).toMatch(/queued on \{/);
  });
});
