import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  BUYER_FEATURES,
  type BuyerFeatureFlag,
  iosDeliverableFeatures,
  iosDesktopOnlyFeatures,
  isIosDeliverable,
} from "@/lib/buyer-features";
import { SELLER_PLAN_BUYER_TIER } from "@/lib/constants";

// US-2503 slice 2. The four iOS screens are Swift and need macOS. What this
// pins is AC5 — "the iOS plan screen lists exactly the bundled buyer
// capabilities that iOS can actually deliver; no bullet advertises a screen that
// does not exist" — as a PROPERTY rather than a promise to be careful.
//
// The premise is a live over-promise, not a hypothetical: /pricing says every
// FlipDesk plan includes buyer tools, SELLER_PLAN_BUYER_TIER really does bundle
// them, and a phone-only subscriber can reach none of them. The story fixes that
// by building the screens. This makes sure that while it is being fixed, nothing
// claims otherwise, and that the NEXT buyer capability cannot slip into an iOS
// bullet by default.

const flags = () => Object.keys(BUYER_FEATURES) as BuyerFeatureFlag[];

describe("every buyer capability is classified for iOS (US-2503 AC5)", () => {
  it("leaves none unclassified", () => {
    // The type already forces this — BUYER_FEATURES is
    // Record<keyof BuyerGateFlags, …>, so a new gate flag does not compile until
    // somebody decides. Asserted anyway because the value of that guarantee is
    // the DEFAULT it sets: "decide", never "quietly becomes an iOS bullet".
    for (const f of flags()) {
      expect(["shipped", "planned", "desktop-only"], f).toContain(
        BUYER_FEATURES[f].ios,
      );
    }
    expect(flags().length).toBeGreaterThanOrEqual(13);
  });

  it("makes every desktop-only capability say why", () => {
    // AC2: the extension second opinion "must be stated as such". A bundled
    // capability that simply vanishes on one client reads as a bug, and a
    // subscriber who paid for the bundle is owed the sentence.
    for (const { flag, note } of iosDesktopOnlyFeatures()) {
      expect(BUYER_FEATURES[flag].iosNote, `${flag} has no iosNote`).toBeTruthy();
      expect(note.trim().length, flag).toBeGreaterThan(10);
      expect(note, flag).toMatch(/\.$/);
    }
  });

  it("keeps the extension itself desktop-only", () => {
    // The one entry that is desktop-only for a reason about the CAPABILITY
    // rather than about effort: it is a browser extension that reads the
    // marketplace page you are looking at. If this ever flips to planned,
    // somebody has misread "we could build an iOS version of the idea" as "this
    // thing runs on a phone".
    expect(BUYER_FEATURES.extensionSecondOpinion.ios).toBe("desktop-only");
    expect(isIosDeliverable("extensionSecondOpinion")).toBe(false);
  });
});

describe("the deliverable list cannot advertise what does not exist", () => {
  it("counts only shipped, never planned", () => {
    // The whole point. `planned` is exactly the category that gets listed early
    // — somebody intends to build it, so it feels true. The screen has to exist.
    const deliverable = iosDeliverableFeatures();
    for (const f of deliverable) {
      expect(BUYER_FEATURES[f].ios, f).toBe("shipped");
    }
    const planned = flags().filter((f) => BUYER_FEATURES[f].ios === "planned");
    for (const f of planned) {
      expect(deliverable, f).not.toContain(f);
      expect(isIosDeliverable(f), f).toBe(false);
    }
  });

  it("the three groups partition the registry", () => {
    // No capability may be in two groups or in none, or the plan screen either
    // repeats a bullet or drops one silently.
    const deliverable = new Set(iosDeliverableFeatures());
    const desktop = new Set(iosDesktopOnlyFeatures().map((x) => x.flag));
    const planned = flags().filter((f) => BUYER_FEATURES[f].ios === "planned");
    expect(deliverable.size + desktop.size + planned.length).toBe(flags().length);
    for (const f of planned) {
      expect(deliverable.has(f), f).toBe(false);
      expect(desktop.has(f), f).toBe(false);
    }
  });

  it("a capability may only claim `shipped` if the Swift file exists", () => {
    // AC5, literally: no bullet advertises a screen that does not exist.
    //
    // This replaced a count-based check that did not work. That version asserted
    // only "at most two capabilities claim shipped", so flipping a `planned`
    // entry to `shipped` stayed green — the count was still under the limit. The
    // single thing the guard was written to catch was the thing it let through,
    // and I only found out by breaking it on purpose. A threshold is not a
    // property.
    for (const f of iosDeliverableFeatures()) {
      const screen = BUYER_FEATURES[f].iosScreen;
      expect(screen, `${f} claims iOS support but names no screen`).toBeTruthy();
      expect(
        existsSync(resolve(process.cwd(), screen!)),
        `${f} names ${screen}, which does not exist`,
      ).toBe(true);
    }
  });

  it("names exactly what iOS delivers today", () => {
    // This began as `length <= 2` — AC1's premise as a number, "almost nothing
    // bundled is reachable on a phone". Two screens later it failed, correctly,
    // and the obvious fix was to raise the number.
    //
    // A raised number is a worse test than the one it replaces. It only ever
    // catches growth, so a capability that STOPS being delivered — a screen
    // deleted, an entry flipped back — slides under a ceiling and nothing
    // notices. Naming the set checks both directions: adding a claim and
    // dropping one each require an edit here, which is where the next reader
    // finds out what actually shipped.
    expect(iosDeliverableFeatures().sort()).toEqual([
      "conditionAlerts",
      "prioritySupport",
      "purchaseGuarantee",
      "trustScore",
      "wardrobePortfolio",
    ]);
  });
});

describe("the bundling that makes this a promise, not a gap (AC1)", () => {
  it("still bundles buyer tiers into paid seller plans", () => {
    // If this ever stopped being true the story would be moot, and the plan
    // screen would owe the user nothing. It is true.
    expect(SELLER_PLAN_BUYER_TIER.starter).toBe("guard");
    expect(SELLER_PLAN_BUYER_TIER.pro).toBe("guard");
    expect(SELLER_PLAN_BUYER_TIER.business).toBe("connoisseur");
    expect(SELLER_PLAN_BUYER_TIER.free).toBe("free");
  });

  it("routes to every buyer screen it claims to have shipped", () => {
    // THIS TEST USED TO ASSERT THE OPPOSITE, and it was green for the wrong
    // reason when I came to invert it.
    //
    // It read: the iOS tree contains none of "conditionAlert", "trustScore",
    // "purchaseGuarantee". Its own comment called it a baseline and said to
    // update it when the screens shipped. But those are the REGISTRY's flag
    // names, and Swift files are named after their views — so `BuyerTrustScoreView`
    // and `BuyerGuaranteeView` were both wired into ContentView while this
    // assertion still passed. It would have gone on passing with all four
    // screens shipped, reporting that none of them existed.
    //
    // Inverted, and keyed on the file the registry NAMES rather than on a token
    // somebody hoped would appear. Scoped to Buyer/ because prioritySupport is
    // an existing screen reached from its own place in the app, not a new row.
    const contentView = readFileSync(
      resolve(process.cwd(), "ios/GradeThread/ContentView.swift"),
      "utf8",
    );
    const buyerScreens = iosDeliverableFeatures()
      .map((f) => BUYER_FEATURES[f].iosScreen ?? "")
      .filter((path) => path.startsWith("ios/GradeThread/Buyer/"));
    expect(
      buyerScreens.length,
      "no shipped capability names a Buyer/ screen — did the registry change?",
    ).toBeGreaterThan(0);
    for (const path of buyerScreens) {
      const viewName = path.split("/").pop()!.replace(/\.swift$/, "");
      expect(
        contentView,
        `${viewName} is marked shipped but nothing in ContentView routes to it`,
      ).toContain(`${viewName}()`);
    }
  });
});
