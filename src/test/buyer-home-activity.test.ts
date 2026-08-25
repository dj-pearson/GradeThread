import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// US-2553. The buyer home told every buyer to do three things and never noticed
// when they had done them: FIRST_STEPS was a static array with no completion
// tracking, so someone with five live alerts was still told to "Create an
// alert", and the cards never went away. Nothing else on the page was about the
// buyer either — a trust card, an impact card and two grids of links.

const HOME = "src/pages/buyer/home.tsx";
const STEPS = "src/components/buyer/buyer-first-steps.tsx";
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
    expect(src).toContain("<BuyerFirstSteps />");
  });

  it("each step is done when the THING happened, not when a button was clicked", () => {
    // The rule the seller checklist already follows, and the only one that
    // survives a page reload.
    const src = read(STEPS);
    expect(src).toContain('supabase.from("saved_searches")');
    expect(src).toContain('supabase.from("closet_items")');
    expect(src).toContain("isExtensionInstalled()");
    // Counts only — head:true sends no rows over the wire.
    expect(src).toMatch(/count: "exact", head: true/);
    expect(src).not.toContain("localStorage.setItem(\"step");
  });

  it("it hides itself when there is nothing left to do", () => {
    const src = read(STEPS);
    expect(src).toContain("doneCount === steps.length) return null");
    // And can be dismissed, per user, like the seller one.
    expect(src).toContain("gt.buyer-first-steps.dismissed");
    expect(read(SELLER_ACTIVATION)).toContain("gt.activation.dismissed");
  });

  it("the extension check survives a late content script", () => {
    // The marker is dropped by a content script that can land after first
    // paint, so a render-time call would report "not installed" forever.
    const src = read(STEPS);
    expect(src).toContain("setHasExtension(isExtensionInstalled())");
    expect(src).toContain("setTimeout");
  });

  it("no step claims completion it cannot observe", () => {
    // "Verify a certificate" was replaced: /verify is a public marketing page
    // that records nothing against an account, so that card could never have
    // completed — which is the defect, not a fix for it.
    const src = read(STEPS);
    expect(src).not.toMatch(/key: "verify"/);
    expect(read("src/pages/marketing/verify.tsx")).not.toContain("closet_items");
    // The journey survives: the closet step still starts at /verify.
    expect(src).toContain('to: "/verify"');
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
    const src = read(STEPS);
    expect(src).toContain("extensionWebStoreUrl()");
    // The fallback only applies when no id is configured at all (local dev),
    // and it is the ONLY remaining reference to that route.
    expect((code(STEPS).match(/\/buyer\/settings/g) ?? []).length).toBe(1);
    expect(src).toContain("storeUrl ?? \"/buyer/settings\"");
    // An external link opens safely.
    expect(src).toContain('rel="noopener noreferrer"');
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
    for (const rel of [HOME, STEPS, ACTIVITY, PLACEHOLDER]) {
      const src = code(rel);
      // A bare arrow character is announced as "leftwards arrow" by a screen
      // reader and does not mirror in a right-to-left locale.
      expect(src, rel).not.toMatch(/[←→]/);
    }
    expect(read(PLACEHOLDER)).toContain("<ArrowLeft");
  });
});
