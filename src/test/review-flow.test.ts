import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  approveSummary,
  firstPhotoMsFrom,
  formatDuration,
  medianSeconds,
  planApprove,
  resolveReviewFlow,
  reviewChannels,
  reviewFlowDefault,
  reviewPath,
  secondsFromFirstPhoto,
} from "@/lib/review-flow";
import { reviewHardBlockers } from "@/pages/flipdesk/draft-quality";
import { ANALYTICS_EVENTS } from "@/lib/analytics-events";

// US-9204: the one-screen review flow, web half. The decisions live in
// src/lib/review-flow.ts and draft-quality.ts so they can be asserted here
// without rendering the page.

const ROOT = join(__dirname, "..", "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

describe("default and switch (AC7)", () => {
  it("accounts created after the ship date default on, older ones off", () => {
    expect(reviewFlowDefault("2026-09-02T10:00:00Z")).toBe(true);
    expect(reviewFlowDefault("2026-09-01T00:00:00Z")).toBe(true);
    expect(reviewFlowDefault("2026-08-31T23:59:59Z")).toBe(false);
    expect(reviewFlowDefault(null)).toBe(false);
    expect(reviewFlowDefault("not a date")).toBe(false);
  });
  it("the stored choice wins over the default, both ways", () => {
    expect(resolveReviewFlow(false, "2026-09-02T10:00:00Z")).toBe(false);
    expect(resolveReviewFlow(true, "2020-01-01T00:00:00Z")).toBe(true);
    expect(resolveReviewFlow(null, "2026-09-02T10:00:00Z")).toBe(true);
    expect(resolveReviewFlow(undefined, "2020-01-01T00:00:00Z")).toBe(false);
  });
});

describe("timing (AC5)", () => {
  it("the first photo is the earliest capture time, else the staging moment", () => {
    expect(firstPhotoMsFrom([{ lastModified: 5000 }, { lastModified: 3000 }], 9000)).toBe(3000);
    expect(firstPhotoMsFrom([{ lastModified: 5000 }], 4000)).toBe(4000);
    expect(firstPhotoMsFrom([{}], 4000)).toBe(4000);
    expect(firstPhotoMsFrom([], null)).toBeNull();
  });
  it("seconds are whole, never negative, null without a start", () => {
    expect(secondsFromFirstPhoto(1000, 61_400)).toBe(60);
    expect(secondsFromFirstPhoto(5000, 1000)).toBe(0);
    expect(secondsFromFirstPhoto(null, 1000)).toBeNull();
  });
  it("median and duration", () => {
    expect(medianSeconds([])).toBeNull();
    expect(medianSeconds([30])).toBe(30);
    expect(medianSeconds([10, 400, 30])).toBe(30);
    expect(medianSeconds([10, 20, 30, 40])).toBe(25);
    expect(formatDuration(48)).toBe("48s");
    expect(formatDuration(252)).toBe("4m 12s");
    expect(formatDuration(3780)).toBe("1h 3m");
  });
  it("the path carries the first-photo time so a reload keeps it", () => {
    expect(reviewPath("abc", 1700000000000)).toBe("/dashboard/flipdesk/review/abc?from=1700000000000");
    expect(reviewPath("abc", null)).toBe("/dashboard/flipdesk/review/abc");
  });
  it("the event is registered and emitted with its literal name", () => {
    expect(ANALYTICS_EVENTS.review_approved).toMatch(/seconds_from_first_photo/);
    expect(read("src/pages/flipdesk/review.tsx")).toMatch(/track\("review_approved"/);
  });
});

describe("channels (AC2)", () => {
  it("API channels run now, extension channels queue, pending APIs wait", () => {
    const all = reviewChannels(null);
    const by = Object.fromEntries(all.map((c) => [c.platform, c.mode]));
    expect(by.ebay).toBe("now");
    expect(by.shopify).toBe("now");
    expect(by.poshmark).toBe("queued");
    expect(by.mercari).toBe("queued");
    expect(by.depop).toBe("later");
    expect(by.etsy).toBe("later");
    expect(by.whatnot).toBeUndefined();
  });
  it("a channel unticked on Marketplaces is not offered", () => {
    const some = reviewChannels(["ebay", "poshmark"]);
    expect(some.map((c) => c.platform)).toEqual(["ebay", "poshmark"]);
  });
  it("the plan splits a selection and the sentence never says listed about a queue", () => {
    const plan = planApprove(new Set(["ebay", "poshmark", "mercari", "depop"]));
    expect(plan.now).toEqual(["ebay"]);
    expect(plan.queued).toEqual(["poshmark", "mercari"]);
    const s = approveSummary(plan);
    expect(s).toBe("eBay goes live now. Poshmark and Mercari wait for your desktop browser.");
    expect(approveSummary({ now: [], queued: [] })).toBe("Pick at least one channel.");
  });
  it("the page uses the US-2481 queue sentence", () => {
    expect(read("src/pages/flipdesk/review.tsx")).toMatch(/QUEUED_NOTICE/);
  });
});

describe("hard blockers (AC4)", () => {
  it("blocks only on a missing required photo, no price, no category", () => {
    const ok = reviewHardBlockers({
      photoTypes: ["front", "back", "tag"],
      requiredPhotoTypes: ["front", "back"],
      price: 24,
      category: "tops",
    });
    expect(ok).toEqual([]);
    const bad = reviewHardBlockers({
      photoTypes: ["front", null],
      requiredPhotoTypes: ["front", "back"],
      price: 0,
      category: null,
    });
    expect(bad.map((b) => b.code)).toEqual(["missing_photo", "no_price", "no_category"]);
    expect(bad[0]?.message).toBe("Add a back photo.");
  });
});

describe("wiring (AC1, AC3)", () => {
  it("the route exists and intake hands off to it when the flow is on", () => {
    expect(read("src/routes/index.tsx")).toMatch(/"\/dashboard\/flipdesk\/review\/:id"/);
    const intake = read("src/pages/flipdesk/intake.tsx");
    expect(intake).toMatch(/reviewFlow\.enabled/);
    expect(intake).toMatch(/reviewPath\(/);
    expect(intake).toMatch(/\/dashboard\/flipdesk\/items\?focus=/);
  });
  it("every block links to an existing stage page", () => {
    const page = read("src/pages/flipdesk/review.tsx");
    expect(page).toMatch(/#canvas-grading/);
    expect(page).toMatch(/\/draft`/);
    expect(page).toMatch(/\/dashboard\/flipdesk\/marketplaces/);
  });
});
