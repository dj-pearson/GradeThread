import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { promotionPerformanceHasContent } from "@/components/flipdesk/promotion-performance";

// US-3032. Marketplaces had grown a second personality.
//
// The Connections tab carried nine cards, seven of which were eBay advertising
// and had nothing to do with connecting anything. Two of those seven were both
// titled "Promoted Listings" and sat four rows apart - one listing what is
// promoted now, one listing what eBay suggests promoting - so the page named
// two different surfaces the same thing and gave a seller no way to tell which
// was which. A third card rendered its own empty state on every load because it
// needed eBay promotions on record and most sellers have none. Account-level
// eBay settings sat on a connections list while the page had a Settings tab.
// And the browser extension was four separate top-level sections.
//
// These guards pin the SHAPE of the fix. They are source scans, in the habit of
// this suite, plus one real unit test on the only piece that is a decision
// rather than a layout.

const PAGE = "src/pages/flipdesk/marketplaces.tsx";
const CAMPAIGN = "src/components/flipdesk/ebay-campaign-card.tsx";
const SETUP = "src/components/flipdesk/cross-post-setup.tsx";

function read(rel: string): string {
  return readFileSync(resolve(process.cwd(), rel), "utf8");
}

/** The file with comments stripped - a guard that reads prose punishes writing it. */
function code(rel: string): string {
  return read(rel)
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

/**
 * Every `<h1>`-`<h6>` on a page, as tag plus its flattened text.
 *
 * Headings and not raw string search, because "Promoted Listings" and
 * "Sold-sync" both appear in body prose on this page for good reasons - one
 * points at eBay's own Promoted Listings report, the other explains what
 * sold-sync does and does not read. Prose naming a thing is fine. Two HEADINGS
 * naming the same thing is the bug.
 */
function headings(src: string): Array<{ tag: string; text: string }> {
  const out: Array<{ tag: string; text: string }> = [];
  const re = /<(h[1-6])\b[^>]*>([\s\S]*?)<\/\1>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    out.push({
      tag: m[1] ?? "",
      text: (m[2] ?? "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim(),
    });
  }
  return out;
}

/**
 * The body of one `<TabsContent value="x">`, up to the next one.
 *
 * Crude on purpose: the page has exactly one Tabs block and its contents are
 * siblings, so "from this trigger to the next" is the whole panel. A nested
 * Tabs would break this, and the last test in this file fails if one appears.
 */
function panel(src: string, value: string): string {
  const open = src.indexOf(`<TabsContent value="${value}"`);
  expect(open, `no <TabsContent value="${value}">`).toBeGreaterThan(-1);
  const next = src.indexOf("<TabsContent value=", open + 1);
  return src.slice(open, next === -1 ? undefined : next);
}

describe("the ads live on their own tab (US-3032)", () => {
  it("Marketplaces declares an ads tab with content", () => {
    const src = code(PAGE);
    expect(src).toContain('<TabsTrigger value="ads">');
    expect(src).toContain('<TabsContent value="ads"');
  });

  it("every eBay advertising card renders under it, and none under Connections", () => {
    const src = code(PAGE);
    const ads = panel(src, "ads");
    const connections = panel(src, "connections");
    const ADVERTISING = [
      "<PromotedListingsSection />",
      "<EbayCampaignCard />",
      "<EbayKeywordsCard />",
      "<EbayPromotionsCard />",
      "<PromotionPerformanceCard />",
      "<FollowerCampaignCard />",
    ];
    for (const card of ADVERTISING) {
      expect(ads, `${card} is not on the ads tab`).toContain(card);
      expect(
        connections,
        `${card} is still on Connections - it is advertising, not a connection`,
      ).not.toContain(card);
    }
  });

  it("an unconnected seller is told where to connect rather than shown empty cards", () => {
    const ads = panel(code(PAGE), "ads");
    // The whole panel is gated on the connection, not each card individually:
    // five "connect eBay first" cards is the state this replaced.
    expect(ads).toMatch(/!connection\s*\?/);
  });
});

describe("Promoted Listings is one name for one thing (US-3032)", () => {
  it("the campaign card no longer titles itself Promoted Listings", () => {
    // It listed eBay's SUGGESTIONS. Sharing a title with the card that lists
    // what is already running made the page unreadable.
    const title = code(CAMPAIGN).slice(
      code(CAMPAIGN).indexOf("<CardTitle"),
      code(CAMPAIGN).indexOf("</CardTitle>"),
    );
    expect(title).not.toMatch(/Promoted\s+Listings/i);
    expect(title).toContain("Worth promoting");
  });

  it("exactly one heading on the page says Promoted Listings", () => {
    const named = headings(code(PAGE)).filter((h) =>
      /^Promoted\s+Listings$/i.test(h.text),
    );
    expect(
      named.length,
      "the section heading is the one place the name belongs",
    ).toBe(1);
  });

  it("no card on the page titles itself Promoted Listings either", () => {
    // The running-now table used to. A CardTitle sits at the same visual weight
    // as these headings, so a duplicate there reads exactly as badly.
    const src = code(PAGE);
    const titles = [...src.matchAll(/<CardTitle[^>]*>([\s\S]*?)<\/CardTitle>/g)];
    for (const t of titles) {
      expect(t[1]).not.toMatch(/Promoted\s+Listings/i);
    }
  });

  it("the running-now table and the suggestions sit in that one section", () => {
    const ads = panel(code(PAGE), "ads");
    const heading = ads.indexOf("Promoted Listings");
    const running = ads.indexOf("<PromotedListingsSection />");
    const suggestions = ads.indexOf("<EbayCampaignCard />");
    // Keywords only exist for these campaigns, so they belong here and not on a
    // connections list.
    const keywords = ads.indexOf("<EbayKeywordsCard />");
    expect(heading).toBeLessThan(running);
    expect(running).toBeLessThan(suggestions);
    expect(suggestions).toBeLessThan(keywords);
  });
});

describe("the performance card says nothing when it knows nothing (US-3032)", () => {
  const none = { onRecord: 0, breaching: 0, liveOnEbay: 0 };

  it("nothing anywhere renders no card at all", () => {
    expect(promotionPerformanceHasContent(none)).toBe(false);
  });

  it("a promotion on record is content", () => {
    expect(promotionPerformanceHasContent({ ...none, onRecord: 1 })).toBe(true);
  });

  it("a cost-floor breach is content even with no promotions", () => {
    // The stack check reads auto-accept offers too, so it finds real breaches
    // for a seller running no sale at all. That half is worth showing alone.
    expect(promotionPerformanceHasContent({ ...none, breaching: 3 })).toBe(true);
  });

  it("an unsynced eBay promotion keeps the card, because it holds the sync button", () => {
    // Hiding here would strand the seller: "Refresh from eBay" lives inside
    // this card, so a hidden card can never become an unhidden one.
    expect(promotionPerformanceHasContent({ ...none, liveOnEbay: 2 })).toBe(true);
  });

  it("the card actually asks before rendering", () => {
    const src = code("src/components/flipdesk/promotion-performance-card.tsx");
    expect(src).toContain("promotionPerformanceHasContent(");
    expect(src).toContain("return null");
  });
});

describe("account-level eBay settings live under Settings (US-3032)", () => {
  it("the programs card moved off the connections list", () => {
    const src = code(PAGE);
    expect(panel(src, "settings")).toContain("<EbayProgramsCard />");
    expect(panel(src, "connections")).not.toContain("<EbayProgramsCard />");
  });
});

describe("the browser extension is one section, not four (US-3032)", () => {
  const PARTS = [
    "<CrossPostSetup />",
    "<ExtensionQueueSection />",
    "<SoldSyncSection />",
  ];

  it("setup, the queue, sold-sync and the channel list share one heading", () => {
    const connections = panel(code(PAGE), "connections");
    const heading = connections.indexOf("Browser extension");
    expect(heading, "no 'Browser extension' section heading").toBeGreaterThan(-1);
    for (const part of PARTS) {
      expect(connections, `${part} is missing`).toContain(part);
      expect(
        connections.indexOf(part),
        `${part} renders above the section that is meant to contain it`,
      ).toBeGreaterThan(heading);
    }
    // The per-channel disclosure list is the fourth part, and it stays inside.
    expect(connections.indexOf("EXTENSION_CHANNELS.map")).toBeGreaterThan(heading);
  });

  it("the parts are sub-heads, so the page has one h2 for the whole subject", () => {
    // Each of these used to open with its own <h2> at the same level as
    // "Active" and "Coming soon". Nested inside one section they are h3.
    const LABELS = ["Sold-sync", "Queued for your desktop", "Set up cross-posting"];
    const found = new Set<string>();
    for (const rel of [PAGE, SETUP]) {
      for (const h of headings(code(rel))) {
        if (!LABELS.includes(h.text)) continue;
        found.add(h.text);
        expect(h.tag, `"${h.text}" in ${rel} is still an ${h.tag}`).toBe("h3");
      }
    }
    // A renamed heading would otherwise pass this by matching nothing.
    expect([...found].sort()).toEqual([...LABELS].sort());
  });
});

describe("the tab split stays flat (US-3032)", () => {
  it("there is one Tabs block on the page", () => {
    // panel() slices from one TabsContent to the next, which a nested Tabs
    // would quietly invalidate - every assertion above would still pass while
    // measuring the wrong thing.
    const opens = code(PAGE).match(/<Tabs\s+defaultValue=/g) ?? [];
    expect(opens.length).toBe(1);
  });
});
