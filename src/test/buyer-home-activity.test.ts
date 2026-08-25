import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// US-2553. The buyer home told every buyer to do three things and never noticed
// when they had done them: FIRST_STEPS was a static array with no completion
// tracking, so someone with five live alerts was still told to "Create an
// alert", and the cards never went away. Nothing else on the page was about the
// buyer either — a trust card, an impact card and two grids of links.

const HOME = "src/pages/buyer/home.tsx";
// US-2883 MOVED THE BUYER'S STEPS. buyer-first-steps.tsx is gone: it was a
// second 204-line checklist beside the seller's, with its own step list, its
// own count queries and its own localStorage dismissal. Every assertion below
// is still a real requirement -- they now point at the shared implementation.
const STEPS_LIB = "src/lib/activation-steps.ts";
const ACTIVATION = "src/hooks/use-activation.ts";
const CHECKLIST = "src/components/onboarding/activation-checklist.tsx";
const ACTIVITY = "src/components/buyer/buyer-activity.tsx";
const EXT = "src/lib/lister-extension.ts";
const PLACEHOLDER = "src/pages/buyer/placeholder.tsx";
// US-2859: the seller checklist's dismissal moved out of the component and
// into the shared hook, and the key was renamed with it.
const SELLER_ACTIVATION = "src/hooks/use-activation.ts";

function read(rel: string): string {
  return readFileSync(resolve(process.cwd(), rel), "utf8");
}

/**
 * The file with comments removed.
 *
 * Both of the assertions below are about what the CODE does, and both first
 * failed on the comment explaining the fix — a guard that reads prose is a guard
 * that punishes writing any.
 */
function code(rel: string): string {
  return read(rel)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

describe("the get-started cards complete (US-2553 AC1, AC2)", () => {
  it("the static array is gone", () => {
    const src = read(HOME);
    expect(src).not.toContain("FIRST_STEPS");
    expect(src).not.toContain("interface FirstStep");
    expect(src).toContain('<ActivationChecklist persona="buyer" />');
  });

  it("each step is done when the THING happened, not when a button was clicked", () => {
    // The rule the seller checklist already follows, and the only one that
    // survives a page reload.
    const src = read(ACTIVATION);
    expect(src).toContain('head("saved_searches")');
    expect(src).toContain('head("closet_items")');
    expect(src).toContain("isExtensionInstalled()");
    // Counts only — head:true sends no rows over the wire.
    expect(src).toMatch(/count: "exact", head: true/);
    expect(src).not.toContain("localStorage.setItem(\"step");
    // And the done-checks read those counts rather than a click.
    const lib = read(STEPS_LIB);
    expect(lib).toContain("isDone: (s) => s.alertCount > 0");
    expect(lib).toContain("isDone: (s) => s.closetCount > 0");
    expect(lib).toContain("isDone: (s) => s.extensionInstalled");
  });

  it("it hides itself when there is nothing left to do", () => {
    expect(read(CHECKLIST)).toContain("if (remaining.length === 0) return null");
    // And can be dismissed, per user AND per persona: dismissing the buyer
    // list must not hide the seller one, because every seller can shop.
    const src = read(SELLER_ACTIVATION);
    expect(src).toContain("gt.activation.dismissed.buyer");
    expect(src).toContain("gt.activation.dismissed");
  });

  it("the extension check survives a late content script", () => {
    // The marker is dropped by a content script that can land after first
    // paint, so a render-time call would report "not installed" forever.
    const src = read(ACTIVATION);
    expect(src).toContain("setExtensionInstalled(isExtensionInstalled())");
    expect(src).toContain("setTimeout");
  });

  it("no step claims completion it cannot observe", () => {
    // "Verify a certificate" was replaced: /verify is a public marketing page
    // that records nothing against an account, so that card could never have
    // completed — which is the defect, not a fix for it.
    const src = read(STEPS_LIB);
    expect(src).not.toMatch(/key: "verify"/);
    expect(read("src/pages/marketing/verify.tsx")).not.toContain("closet_items");
    // The journey survives: the closet step still starts at /verify.
    expect(src).toContain('to: "/verify"');
    // US-2883: and no step is written un-completable. US-2859's `scan` step
    // was `isDone: () => false` -- the very defect this case exists for,
    // reintroduced on the buyer persona by a story that did not know this
    // component existed.
    // code(), not read(): the comment ABOVE the buyer steps quotes that exact
    // string while explaining why it is banned, and the first version of this
    // assertion failed on its own documentation.
    expect(code(STEPS_LIB), "a step can never complete").not.toContain(
      "isDone: () => false",
    );
  });
});

describe("the home shows the buyer's own activity (US-2553 AC3)", () => {
  it("both feeds are rendered", () => {
    expect(read(HOME)).toContain("<BuyerActivity />");
    const src = read(ACTIVITY);
    expect(src).toContain("useBuyerAlertMatches");
    expect(src).toContain("useBuyerCloset");
  });

  it("every row goes somewhere", () => {
    // A feed you cannot click is a list of regrets.
    const src = read(ACTIVITY);
    expect(src).toContain('to={m.link ?? "/buyer/alerts"}');
    expect(src).toContain("to={`/cert/${item.certificate_id}`}");
  });

  it("a failed feed says so instead of rendering as empty", () => {
    // US-2026's rule: a false empty state tells a buyer with 40 saved garments
    // that they have none.
    const src = read(ACTIVITY);
    expect((src.match(/<ErrorState/g) ?? []).length).toBe(2);
    for (const feed of ["matches", "closet"]) {
      const at = src.indexOf(`${feed}.isError`);
      const loadingAt = src.indexOf(`${feed}.isLoading`);
      expect(at, feed).toBeGreaterThan(-1);
      expect(at, `${feed}: isError must be checked before isLoading`).toBeLessThan(
        loadingAt,
      );
    }
  });
});

describe("the extension link points at the extension (US-2553 AC4)", () => {
  it("the store URL is derived from the id already configured", () => {
    const src = read(EXT);
    expect(src).toContain("export function extensionWebStoreUrl()");
    expect(src).toContain("https://chromewebstore.google.com/detail/");
    // Explicit override wins, so a vanity URL does not need a code change.
    expect(src).toContain("VITE_EXTENSION_WEBSTORE_URL");
  });

  it("the card no longer sends people to settings to find an extension", () => {
    const src = read(ACTIVATION);
    expect(src).toContain("extensionWebStoreUrl()");
    // The fallback only applies when no id is configured at all (local dev),
    // and it is the ONLY remaining reference to that route.
    expect((code(ACTIVATION).match(/\/buyer\/settings/g) ?? []).length).toBe(1);
    // US-2883: it is a window.open now rather than an <a>, because the step
    // runs through the shared complete() rather than rendering its own link.
    // Same safety, stated the way window.open states it.
    expect(src).toContain('window.open(url, "_blank", "noopener,noreferrer")');
  });

  it("the install check is not gated on the seller feature flag", () => {
    // isListerAvailable() is about offering the SELLER cross-listing UI. A
    // buyer asking "have I installed it" is a different question.
    const src = read(EXT);
    const at = src.indexOf("export function isExtensionInstalled()");
    const body = src.slice(at, at + 200);
    expect(body).toContain("bridgeAvailable()");
    expect(body).not.toContain("VITE_LISTER_EXTENSION");
  });
});

describe("arrows are icons, not characters (US-2553 P3)", () => {
  it("the buyer surfaces stopped typing them", () => {
    for (const rel of [HOME, STEPS_LIB, CHECKLIST, ACTIVITY, PLACEHOLDER]) {
      const src = code(rel);
      // A bare arrow character is announced as "leftwards arrow" by a screen
      // reader and does not mirror in a right-to-left locale.
      expect(src, rel).not.toMatch(/[←→]/);
    }
    expect(read(PLACEHOLDER)).toContain("<ArrowLeft");
  });
});
