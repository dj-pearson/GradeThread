// US-3369: the links a seller uses to end a listing by hand, and the small
// rules around them. These are the fallback for when the extension cannot do
// the job, so a wrong one is exactly the moment a seller has nothing else.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  activeListingsLink,
  defaultSoldListing,
  delistRedirectTarget,
  isValidSellerHandle,
  needsSellerHandle,
  parseSellerHandle,
  SOLD_ELSEWHERE,
} from "@/lib/delist-links";
import { LISTER_EXTENSION_PLATFORMS } from "@/lib/lister-extension";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

describe("activeListingsLink", () => {
  it("links every extension platform somewhere a seller can act", () => {
    for (const p of LISTER_EXTENSION_PLATFORMS) {
      const link = activeListingsLink(p, { handles: { poshmark: "jane" } });
      expect(link, p).not.toBeNull();
      expect(link!.url.startsWith("https://"), p).toBe(true);
    }
  });

  it("builds Poshmark's closet from the saved username, available items only", () => {
    expect(activeListingsLink("poshmark", { handles: { poshmark: "jane_closet" } })).toEqual({
      url: "https://poshmark.com/closet/jane_closet?availability=available",
      exact: true,
    });
  });

  it("gives Poshmark no link at all without a username, rather than a 404", () => {
    // /closet with no username 404s on Poshmark (checked 2026-09-11).
    expect(activeListingsLink("poshmark")).toBeNull();
    expect(activeListingsLink("poshmark", { handles: { poshmark: "bad/one" } })).toBeNull();
    expect(needsSellerHandle("poshmark")).toBe(true);
    expect(needsSellerHandle("mercari")).toBe(false);
  });

  it("says when a link is only the site's front door", () => {
    expect(activeListingsLink("vinted")).toEqual({ url: "https://www.vinted.com/", exact: false });
    // A seller on vinted.fr has no account on vinted.com.
    expect(activeListingsLink("vinted", { locales: { vinted: "vinted.fr" } })?.url).toBe(
      "https://www.vinted.fr/",
    );
    expect(activeListingsLink("vinted", { locales: { vinted: "evil.test" } })?.url).toBe(
      "https://www.vinted.com/",
    );
  });

  it("covers the API marketplaces too", () => {
    expect(activeListingsLink("ebay")?.url).toBe("https://www.ebay.com/sh/lst/active");
    expect(activeListingsLink("nowhere")).toBeNull();
  });

  it("agrees with the extension's own locate pages", () => {
    // The web link and the page the extension searches are the same page. If
    // one moves and the other does not, the seller is sent somewhere different
    // from where the extension looked.
    const sel = readFileSync(path.join(root, "extension-unified/lister/selectors.js"), "utf8");
    for (const p of ["poshmark", "mercari", "grailed", "facebook"]) {
      const link = activeListingsLink(p, { handles: { poshmark: "{handle}" } });
      // {handle} is not a valid username, so rebuild Poshmark's template by hand.
      const expected = p === "poshmark"
        ? "https://poshmark.com/closet/{handle}?availability=available"
        : link!.url;
      expect(sel, p).toContain(`activeListingsUrl: "${expected}"`);
    }
  });
});

describe("seller handles", () => {
  it("accepts a plain username and refuses anything that reshapes a URL", () => {
    expect(isValidSellerHandle("jane.closet_22")).toBe(true);
    for (const bad of ["", "a b", "../x", "x?y", "https://x", "x".repeat(41)]) {
      expect(isValidSellerHandle(bad), bad).toBe(false);
    }
  });

  it("forgives what people paste", () => {
    expect(parseSellerHandle("  @jane_closet ")).toBe("jane_closet");
    expect(parseSellerHandle("https://poshmark.com/closet/jane_closet?availability=available")).toBe(
      "jane_closet",
    );
    expect(parseSellerHandle("not a name")).toBeNull();
  });
});

describe("delistRedirectTarget", () => {
  const id = "3f1c2b8e-1a2b-4c3d-8e9f-001122334455";
  it("sends the still-live notification to the item's Delist panel", () => {
    expect(delistRedirectTarget(new URLSearchParams(`item=${id}&pendingDelists=1`))).toBe(
      `/dashboard/flipdesk/items/${id}#delist`,
    );
  });
  it("leaves every other inventory link alone", () => {
    expect(delistRedirectTarget(new URLSearchParams(`item=${id}`))).toBeNull();
    expect(delistRedirectTarget(new URLSearchParams("item=../../x&pendingDelists=1"))).toBeNull();
    expect(delistRedirectTarget(new URLSearchParams("mode=grid"))).toBeNull();
  });
});

describe("defaultSoldListing", () => {
  it("preselects the only live listing", () => {
    expect(
      defaultSoldListing([
        { id: "a", listing_status: "active" },
        { id: "b", listing_status: "ended" },
      ]),
    ).toBe("a");
  });
  it("assumes nothing when more than one is live", () => {
    // Guessing wrong marks the wrong listing sold and ends the one that sold.
    expect(
      defaultSoldListing([
        { id: "a", listing_status: "active" },
        { id: "b", listing_status: "active" },
      ]),
    ).toBe(SOLD_ELSEWHERE);
    expect(defaultSoldListing([])).toBe(SOLD_ELSEWHERE);
  });
});
