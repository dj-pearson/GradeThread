import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// US-3367: the Listing Kit lists to every extension channel through the paced
// queue, and shows each channel's state with its marketplace link. Source
// scans, because they pin WHERE the wiring is; the rules themselves are
// called in src/lib/__tests__/channel-state.test.ts.

const src = readFileSync("src/components/flipdesk/listing-kit.tsx", "utf8");

describe("Listing Kit: List everywhere (US-3367)", () => {
  it("queues through cross-push, never through N direct sends", () => {
    expect(src).toContain("useCrossPush()");
    expect(src).toContain("List everywhere");
    // The one interactive send stays: "Fill {Platform} now" for one channel.
    expect(src.match(/sendToLister\(/g)?.length ?? 0).toBe(1);
  });

  it("says the queued sentence and nudges the drain after queueing", () => {
    expect(src).toContain("${QUEUED_NOTICE}");
    expect(src).toContain("requestDrainNow()");
  });

  it("reads the channel state from one derivation", () => {
    expect(src).toContain("deriveChannelState(");
    expect(src).toContain("planListEverywhere(");
  });

  it("links to the marketplace for any platform, not only eBay", () => {
    expect(src).toContain("View on {label}");
  });

  it("offers Cancel only on a queued row, never a claimed one (US-3048)", () => {
    expect(src).toContain('status.queueItem?.status === "queued"');
  });

  it("never offers List everywhere for a verifying flow or Depop", () => {
    expect(src).toContain('MARKETPLACE_EXTENSION_FLOW[p] !== "verifying"');
    expect(src).toContain("isListerPlatform(p)");
  });
});
