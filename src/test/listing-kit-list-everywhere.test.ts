import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// US-3367 put "List everywhere" in the Listing Kit; US-3450 moved the
// checklist and the button into the composer's List on panel, which offers
// every channel (API and extension) with the same per-channel state. Source
// scans, because they pin WHERE the wiring is; the rules themselves are
// called in src/lib/__tests__/channel-state.test.ts and
// src/lib/__tests__/list-on-channels.test.ts.

const kit = readFileSync("src/components/flipdesk/listing-kit.tsx", "utf8");
const panel = readFileSync("src/components/flipdesk/composer/list-on-panel.tsx", "utf8");
const composer = readFileSync("src/pages/flipdesk/composer.tsx", "utf8");

describe("List on panel: one picker, one button (US-3450)", () => {
  it("queues through cross-push, never through N direct sends", () => {
    expect(panel).toContain("useCrossPush()");
    expect(composer).toContain("useCrossPush()");
    // The one interactive send stays in the kit: "Fill {Platform} now".
    expect(kit.match(/sendToLister\(/g)?.length ?? 0).toBe(1);
    expect(panel).not.toContain("sendToLister(");
  });

  it("says the queued sentence and nudges the drain after queueing, on both paths", () => {
    for (const src of [panel, composer]) {
      expect(src).toContain("${QUEUED_NOTICE}");
      expect(src).toContain("requestDrainNow()");
    }
  });

  it("reads the channel state and the rows from one derivation", () => {
    expect(panel).toContain("deriveChannelState(");
    expect(panel).toContain("listOnRows(");
    expect(kit).toContain("deriveChannelState(");
  });

  it("the kit no longer carries its own checklist", () => {
    expect(kit).not.toContain("planListEverywhere(");
    expect(kit).not.toContain("List everywhere");
    expect(composer).not.toContain("<PushToCard");
  });

  it("links to the marketplace for any platform, not only eBay", () => {
    expect(kit).toContain("View on {label}");
    expect(panel).toContain("View on {r.label}");
  });

  it("offers Cancel only on a queued row, never a claimed one (US-3048)", () => {
    expect(kit).toContain('status.queueItem?.status === "queued"');
    expect(panel).toContain('r.status?.queueItem?.status === "queued"');
  });

  it("reads one summary of the cross-push result on both paths", () => {
    expect(panel).toContain("summarizeCrossPush(");
    expect(composer).toContain("summarizeCrossPush(");
  });
});
