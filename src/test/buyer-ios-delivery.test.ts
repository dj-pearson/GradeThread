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

  it("still reflects the truth this story was filed about", () => {
    // AC1's premise, as a number rather than a sentence: almost nothing bundled
    // is reachable on a phone today. Kept alongside the check above, not instead
    // of it — this one tells the next reader whether the story progressed, and
    // the one above is what stops the number being reached by claiming.
    expect(iosDeliverableFeatures().length).toBeLessThanOrEqual(2);
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

  it("the iOS tree still has none of the four screens", () => {
    // A BASELINE, not a permanent assertion — the story exists to make this
    // false. Its value until then is that nobody closes US-2503 believing the
    // Swift landed. Update it when the screens ship; do not delete it.
    // Read the app's own view tree rather than trusting the story's prose.
    const contentView = readFileSync(
      resolve(process.cwd(), "ios/GradeThread/ContentView.swift"),
      "utf8",
    );
    for (const token of ["conditionAlert", "trustScore", "purchaseGuarantee"]) {
      expect(contentView, token).not.toContain(token);
    }
  });
});
