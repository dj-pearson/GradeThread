// US-1876: unit tests for the Lister background navigation guard
// (extension/lister-guard.js). The extension has no test harness of its own, so
// these load the pure UMD guard (it assigns to globalThis when `self` is absent)
// and prove the properties that close the XSS-driven arbitrary-navigation
// primitive: origin is checked via sender.origin, list URLs are pinned to the
// bundled config, and delist URLs must be https + host-match the platform.

import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

interface ListerGuard {
  hostOf(v: unknown): string | null;
  hostMatches(host: string | null, domain: string): boolean;
  senderHost(sender: unknown): string | null;
  isOriginAllowed(sender: unknown): boolean;
  newListingUrlFor(selectors: unknown, platform: string): string | null;
  newListingUrlForLocale(
    selectors: unknown,
    platform: string,
    locale: unknown,
  ): string | null;
  localesFor(selectors: unknown, platform: string): string[];
  isAllowedDelistUrl(selectors: unknown, platform: string, url: unknown): boolean;
  isLiveListingUrl(selectors: unknown, platform: string, url: unknown): boolean;
}

interface BundledFlow {
  enabled: boolean;
  newListingUrl: string;
  hosts: string[];
  liveListingUrlPattern: string;
  locales?: Record<string, string>;
}

/**
 * The REAL bundled selectors, evaluated from the shipped content script.
 *
 * The mocks below stay for the property tests (they need hosts that do and
 * don't match), but the coverage assertions must run against what actually
 * ships. A mock cannot tell you that Mercari's delist host is missing from the
 * config the worker loads at runtime — and a missing host means the guard
 * silently refuses every delist for that channel, which is a live listing left
 * behind after the item sold somewhere else.
 */
function loadBundledSelectors(): Record<string, BundledFlow> {
  const src = readFileSync(
    resolve(process.cwd(), "extension-unified/lister/selectors.js"),
    "utf8",
  );
  const scope: Record<string, unknown> = {};
  new Function("self", `${src}; return self.GT_LISTER_SELECTORS;`)(scope);
  return scope.GT_LISTER_SELECTORS as Record<string, BundledFlow>;
}

/** One channel's shipped config, or a diagnosis of why it isn't there. */
function bundledFlow(
  bundled: Record<string, BundledFlow>,
  platform: string,
): BundledFlow {
  const flow = bundled[platform];
  if (!flow) {
    throw new Error(
      `extension-unified/lister/selectors.js has no "${platform}" entry, but the ` +
        `channel is advertised — the seller would be offered a channel the ` +
        `extension refuses as unsupported.`,
    );
  }
  return flow;
}

let guard: ListerGuard;

// Mirror of the bundled selectors shape the worker passes in.
const SELECTORS = {
  poshmark: { newListingUrl: "https://poshmark.com/create-listing", hosts: ["poshmark.com"] },
  mercari: { newListingUrl: "https://www.mercari.com/sell/", hosts: ["mercari.com"] },
  grailed: { newListingUrl: "https://www.grailed.com/sell/", hosts: ["grailed.com"] },
};

beforeAll(async () => {
  // The guard is a vanilla-JS UMD file (extension/ has no allowJs in tsconfig.app),
  // imported only for its globalThis side effect; its runtime API is asserted via
  // the ListerGuard interface above, so the module itself needs no static types.
  // @ts-expect-error — untyped .js side-effect import
  await import("../../extension-unified/lister/lister-guard.js");
  guard = (globalThis as unknown as { GT_LISTER_GUARD: ListerGuard }).GT_LISTER_GUARD;
});

describe("isOriginAllowed (AC4)", () => {
  it("accepts gradethread.com and its subdomains via sender.origin", () => {
    expect(guard.isOriginAllowed({ origin: "https://gradethread.com" })).toBe(true);
    expect(guard.isOriginAllowed({ origin: "https://app.gradethread.com" })).toBe(true);
  });

  it("falls back to sender.url when origin is absent", () => {
    expect(guard.isOriginAllowed({ url: "https://app.gradethread.com/dashboard" })).toBe(true);
    expect(guard.isOriginAllowed({ url: "https://evil.com/x" })).toBe(false);
  });

  it("prefers sender.origin over a spoofable sender.url", () => {
    // origin is the browser-attested value — it must win over url.
    expect(guard.isOriginAllowed({ origin: "https://evil.com", url: "https://gradethread.com" })).toBe(false);
    expect(guard.isOriginAllowed({ origin: "https://app.gradethread.com", url: "https://evil.com" })).toBe(true);
  });

  it("rejects look-alike and unparseable origins", () => {
    expect(guard.isOriginAllowed({ origin: "https://gradethread.com.evil.com" })).toBe(false);
    expect(guard.isOriginAllowed({ origin: "https://notgradethread.com" })).toBe(false);
    expect(guard.isOriginAllowed({})).toBe(false);
    expect(guard.isOriginAllowed(null)).toBe(false);
  });
});

describe("newListingUrlFor (AC1 — list URL pinned to config)", () => {
  it("returns the config URL for a known platform, ignoring any message URL", () => {
    expect(guard.newListingUrlFor(SELECTORS, "poshmark")).toBe("https://poshmark.com/create-listing");
    // The function has NO parameter for a message-supplied URL — pinning by design.
    expect(guard.newListingUrlFor.length).toBe(2);
  });

  it("returns null for an unknown or misconfigured platform", () => {
    expect(guard.newListingUrlFor(SELECTORS, "ebay")).toBeNull();
    expect(guard.newListingUrlFor({ poshmark: {} }, "poshmark")).toBeNull();
    expect(guard.newListingUrlFor({ poshmark: { newListingUrl: "http://poshmark.com/x" } }, "poshmark")).toBeNull();
  });
});

describe("isAllowedDelistUrl (AC1 — delist URL host-matched)", () => {
  it("accepts an https URL on the platform's domain (incl. subdomains)", () => {
    expect(guard.isAllowedDelistUrl(SELECTORS, "poshmark", "https://poshmark.com/listing/abc")).toBe(true);
    expect(guard.isAllowedDelistUrl(SELECTORS, "poshmark", "https://www.poshmark.com/listing/abc")).toBe(true);
  });

  it("rejects non-https, off-platform, and cross-platform hosts", () => {
    expect(guard.isAllowedDelistUrl(SELECTORS, "poshmark", "http://poshmark.com/listing/abc")).toBe(false);
    expect(guard.isAllowedDelistUrl(SELECTORS, "poshmark", "https://evil.com/listing/abc")).toBe(false);
    // A poshmark job may not open a grailed URL.
    expect(guard.isAllowedDelistUrl(SELECTORS, "poshmark", "https://www.grailed.com/x")).toBe(false);
    // The classic bypass: attacker host that merely CONTAINS the domain.
    expect(guard.isAllowedDelistUrl(SELECTORS, "poshmark", "https://poshmark.com.evil.com/x")).toBe(false);
  });

  it("rejects malformed input and unknown platforms", () => {
    expect(guard.isAllowedDelistUrl(SELECTORS, "poshmark", "not a url")).toBe(false);
    expect(guard.isAllowedDelistUrl(SELECTORS, "poshmark", null)).toBe(false);
    expect(guard.isAllowedDelistUrl(SELECTORS, "ebay", "https://ebay.com/x")).toBe(false);
  });
});


// ── US-2477..US-2480: the SHIPPED config, not a mock ───────────────────────
//
// Every one of these assertions is about a channel we advertise. The guard is
// the last thing standing between "the seller's item sold on eBay" and "the
// Poshmark/Mercari/Grailed/Vinted/Facebook copy is still live and purchasable" —
// and it refuses anything its config does not vouch for. So a channel missing
// from `hosts` does not fail loudly at runtime; it fails as a delist that never
// happens, which the seller discovers when a second buyer pays for an item they
// have already shipped.
describe("the shipped selectors satisfy the guard (US-2477..US-2480)", () => {
  const BUNDLED = loadBundledSelectors();
  const CHANNELS = ["poshmark", "mercari", "grailed", "vinted", "facebook"] as const;

  it("every advertised channel is present", () => {
    for (const p of CHANNELS) expect(BUNDLED[p], `${p} missing`).toBeDefined();
  });

  it("the guard accepts a delist URL on each channel's own hosts", () => {
    for (const p of CHANNELS) {
      const hosts = bundledFlow(BUNDLED, p).hosts;
      expect(hosts.length, `${p} declares no hosts`).toBeGreaterThan(0);
      for (const host of hosts) {
        // Apex and www, because marketplaces serve both and a delist URL saved
        // from either has to be openable.
        expect(
          guard.isAllowedDelistUrl(BUNDLED, p, `https://${host}/listing/abc`),
          `${p}: guard rejects its own host ${host}`,
        ).toBe(true);
        expect(
          guard.isAllowedDelistUrl(BUNDLED, p, `https://www.${host}/listing/abc`),
          `${p}: guard rejects www.${host}`,
        ).toBe(true);
      }
    }
  });

  it("no channel accepts another channel's host", () => {
    // The cross-platform confusion case: a Mercari job must never be able to
    // open a Poshmark URL, however the payload got that way.
    for (const p of CHANNELS) {
      for (const other of CHANNELS) {
        if (other === p) continue;
        for (const host of bundledFlow(BUNDLED, other).hosts) {
          if (bundledFlow(BUNDLED, p).hosts.includes(host)) continue;
          expect(
            guard.isAllowedDelistUrl(BUNDLED, p, `https://${host}/listing/abc`),
            `${p} accepted ${other}'s host ${host}`,
          ).toBe(false);
        }
      }
    }
  });

  it("no channel's create page can be captured as a live listing", () => {
    // Every one of these tabs STARTS on the create page. If the live-listing
    // pattern matched it, the row would flip to active the instant the tab
    // opened — a listing that exists only in our database.
    for (const p of CHANNELS) {
      expect(
        guard.isLiveListingUrl(BUNDLED, p, bundledFlow(BUNDLED, p).newListingUrl),
        `${p}: its own create page matches liveListingUrlPattern`,
      ).toBe(false);
    }
  });
});

// ── US-2479: locale resolution for the multi-domain channels ───────────────
describe("newListingUrlForLocale (US-2479)", () => {
  const BUNDLED = loadBundledSelectors();

  it("resolves a covered locale to that locale's own URL", () => {
    for (const [locale, url] of Object.entries(bundledFlow(BUNDLED, "vinted").locales ?? {})) {
      expect(guard.newListingUrlForLocale(BUNDLED, "vinted", locale)).toBe(url);
    }
  });

  it("tolerates a www prefix and mixed case", () => {
    expect(guard.newListingUrlForLocale(BUNDLED, "vinted", "www.vinted.fr")).toBe(
      "https://www.vinted.fr/items/new",
    );
    expect(guard.newListingUrlForLocale(BUNDLED, "vinted", "VINTED.FR")).toBe(
      "https://www.vinted.fr/items/new",
    );
  });

  it("returns null for an uncovered locale rather than guessing", () => {
    // AC2: an uncovered locale reports "list manually" naming the domain. It
    // must NOT silently fall back to the default — sending a Lithuanian seller
    // to vinted.com lands them on a login wall for an account they don't have.
    expect(guard.newListingUrlForLocale(BUNDLED, "vinted", "vinted.jp")).toBeNull();
    expect(guard.newListingUrlForLocale(BUNDLED, "vinted", "vinted.com.evil.com")).toBeNull();
  });

  it("never accepts a URL smuggled in as a locale", () => {
    // The whole US-1876 primitive, re-checked on the new door: the caller
    // supplies a KEY, never a navigation target.
    expect(
      guard.newListingUrlForLocale(BUNDLED, "vinted", "https://evil.com/x"),
    ).toBeNull();
    expect(
      guard.newListingUrlForLocale(
        { vinted: { locales: { "vinted.fr": "http://evil.com" } } },
        "vinted",
        "vinted.fr",
      ),
    ).toBeNull();
  });

  it("falls back to the platform default when no locale is given", () => {
    expect(guard.newListingUrlForLocale(BUNDLED, "vinted", undefined)).toBe(
      bundledFlow(BUNDLED, "vinted").newListingUrl,
    );
    expect(guard.newListingUrlForLocale(BUNDLED, "vinted", "")).toBe(
      bundledFlow(BUNDLED, "vinted").newListingUrl,
    );
  });

  it("ignores the locale entirely for a single-domain platform", () => {
    // Poshmark has no locales map, so a locale key must not be able to change
    // or break its target.
    expect(guard.newListingUrlForLocale(BUNDLED, "poshmark", "vinted.fr")).toBe(
      bundledFlow(BUNDLED, "poshmark").newListingUrl,
    );
  });

  it("localesFor lists the covered domains, and nothing for a single-domain platform", () => {
    expect(guard.localesFor(BUNDLED, "vinted").length).toBeGreaterThan(10);
    expect(guard.localesFor(BUNDLED, "poshmark")).toEqual([]);
  });
});

// ── US-1877 (AC1): live-listing URL capture ────────────────────────────────
//
// After a fill, the background watches the tab for the URL the marketplace
// navigates to when the seller SUBMITS. That capture promotes the row from draft
// to active and records the URL the delist queue later opens.
//
// So a false positive is not cosmetic — it is the phantom-listing bug US-1877
// exists to remove, wearing a plausible URL. The guard is strict on BOTH axes.
describe("isLiveListingUrl (US-1877 AC1)", () => {
  const SEL = {
    poshmark: {
      hosts: ["poshmark.com"],
      liveListingUrlPattern: "^https://[^/]*poshmark\\.(com|ca)/listing/[^/]+",
    },
    mercari: {
      hosts: ["mercari.com"],
      liveListingUrlPattern: "^https://[^/]*mercari\\.com/(us/)?item/[^/]+",
    },
    grailed: {
      hosts: ["grailed.com"],
      liveListingUrlPattern: "^https://[^/]*grailed\\.com/listings/[^/]+",
    },
  };

  it("captures a real live listing on each platform", () => {
    expect(guard.isLiveListingUrl(SEL, "poshmark", "https://poshmark.com/listing/Nike-Tee-abc")).toBe(true);
    expect(guard.isLiveListingUrl(SEL, "mercari", "https://www.mercari.com/us/item/m123/")).toBe(true);
    expect(guard.isLiveListingUrl(SEL, "grailed", "https://www.grailed.com/listings/9-tee")).toBe(true);
  });

  it("NEVER captures the create-listing page it was opened on", () => {
    // The tab starts on the form. If this matched, every fill would instantly
    // "capture" the form URL and mark the listing live — the exact phantom.
    expect(guard.isLiveListingUrl(SEL, "poshmark", "https://poshmark.com/create-listing")).toBe(false);
    expect(guard.isLiveListingUrl(SEL, "mercari", "https://www.mercari.com/sell/")).toBe(false);
    expect(guard.isLiveListingUrl(SEL, "grailed", "https://www.grailed.com/sell/")).toBe(false);
  });

  it("NEVER captures a foreign host, however listing-shaped its path", () => {
    // The seller clicks an ad or an outbound link mid-flow.
    expect(guard.isLiveListingUrl(SEL, "poshmark", "https://evil.com/listing/x")).toBe(false);
    expect(guard.isLiveListingUrl(SEL, "grailed", "https://poshmark.com/listing/x")).toBe(false);
  });

  it("requires https and a real url", () => {
    expect(guard.isLiveListingUrl(SEL, "poshmark", "http://poshmark.com/listing/x")).toBe(false);
    expect(guard.isLiveListingUrl(SEL, "poshmark", "")).toBe(false);
    expect(guard.isLiveListingUrl(SEL, "poshmark", null)).toBe(false);
  });

  it("fails closed on a platform with no pattern, or a malformed one", () => {
    // A remote config could ship either. Failing closed means the seller falls back
    // to "I published it" — never a wrong URL written onto their listing.
    expect(guard.isLiveListingUrl(SEL, "depop", "https://depop.com/products/x")).toBe(false);
    expect(
      guard.isLiveListingUrl(
        { x: { hosts: ["x.com"], liveListingUrlPattern: "([unclosed" } },
        "x",
        "https://x.com/anything",
      ),
    ).toBe(false);
  });
});
