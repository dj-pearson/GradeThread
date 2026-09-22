import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { delistLogLine } from "@/lib/delist-log-words";
import type { DelistLogEvent } from "@/hooks/use-delist-log";

// US-3452: the sentence per event, and where the log is rendered.

const ev = (over: Partial<DelistLogEvent>): DelistLogEvent => ({
  at: "2026-09-21T14:06:00Z",
  platform: "poshmark",
  listing_id: "l1",
  event: "ended_extension",
  actor: "browser",
  url: null,
  note: null,
  ...over,
});

describe("delistLogLine", () => {
  it("names the marketplace and who acted, and marks only the open rows", () => {
    expect(delistLogLine(ev({ event: "sold", platform: "ebay", actor: "server" }))).toMatchObject({
      headline: "Sold on eBay",
      open: false,
    });
    const ended = delistLogLine(ev({}));
    expect(ended.headline).toBe("Poshmark ended");
    expect(ended.detail).toContain("your browser");
    expect(ended.open).toBe(false);
    expect(delistLogLine(ev({ event: "ended_by_hand", actor: "seller" })).detail).toContain("by you");
    expect(delistLogLine(ev({ event: "ended_api", platform: "ebay", actor: "server" })).detail).toContain("GradeThread");
  });

  it("the three states the seller still owns read as open and say what to do", () => {
    for (const event of ["queued", "waiting", "unresolved"] as const) {
      const line = delistLogLine(ev({ event, platform: "grailed" }));
      expect(line.open, event).toBe(true);
      expect(line.headline, event).toContain("Grailed");
    }
    expect(delistLogLine(ev({ event: "waiting" })).detail).toContain("End it yourself");
    expect(delistLogLine(ev({ event: "unresolved", note: "no delist path" })).detail).toContain("no delist path");
    expect(delistLogLine(ev({ event: "queued", note: "A browser has picked it up." })).detail).toContain(
      "A browser has picked it up.",
    );
  });

  it("is rendered on the item page and in the Record Sale confirmation (AC3)", () => {
    expect(readFileSync("src/pages/flipdesk/item.tsx", "utf8")).toContain("<DelistLog itemId={item.id} />");
    expect(readFileSync("src/components/flipdesk/record-sale-dialog.tsx", "utf8")).toContain(
      "<DelistLog itemId={delistStepFor} bare />",
    );
    // The log refreshes when a sale is recorded, a listing is ended or a
    // delist is confirmed, so it never shows a stale "still live".
    for (const rel of [
      "src/components/flipdesk/record-sale-dialog.tsx",
      "src/hooks/use-listing-lifecycle.ts",
      "src/hooks/use-pending-delists.ts",
    ]) {
      expect(readFileSync(rel, "utf8"), rel).toContain('queryKey: ["delist_log"]');
    }
  });
});
