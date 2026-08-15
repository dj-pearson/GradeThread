import { describe, it, expect } from "vitest";
import {
  NAVIGATE_FALLBACK_DENYLIST,
  isNavigateFallbackDenied,
} from "@/lib/pwa/navigate-fallback-denylist";
import { PUBLIC_ROUTES } from "@/lib/seo/public-routes";

// The MeasureCard page opens the print-at-home PDF with window.open, which is a
// navigation. The edge served it 200 application/pdf the whole time; the
// service worker answered first with the cached SPA shell, so the router drew
// its 404 over a file that was there. Only a device with the SW installed ever
// saw it, which is why curl and the build both looked fine.

describe("a real file in public/ is never answered with the SPA shell", () => {
  const files = [
    "/measure-card-letter-v2.pdf",
    "/measure-card-letter-v1.pdf",
    "/measure-card-letter-v2.pdf?print=1",
    "/manifest.webmanifest",
    "/favicon.ico",
    "/og-default.png",
    "/apple-touch-icon.png",
  ];

  for (const f of files) {
    it(`denies ${f}`, () => {
      expect(isNavigateFallbackDenied(f)).toBe(true);
    });
  }
});

describe("SPA routes still get the shell", () => {
  const spa = [
    "/dashboard/flipdesk/measure-card",
    "/dashboard",
    "/dashboard/flipdesk/items/8f1c2a44-0000-4000-8000-000000000000",
    "/login",
    "/admin/measure-cards",
  ];

  for (const p of spa) {
    it(`allows ${p}`, () => {
      expect(isNavigateFallbackDenied(p)).toBe(false);
    });
  }

  it("leaves the root to the fallback — it IS index.html", () => {
    expect(isNavigateFallbackDenied("/")).toBe(false);
  });
});

describe("the US-421 exclusions survive", () => {
  const mustDeny = [
    "/api/flipdesk/measure/card-request",
    "/blog",
    "/blog/how-we-grade",
    "/cert/abc123",
    "/verified/dj",
    "/og/cert/abc123",
    "/sitemap.xml",
    "/robots.txt",
    "/rss.xml",
    "/.well-known/assetlinks.json",
  ];

  for (const p of mustDeny) {
    it(`denies ${p}`, () => {
      expect(isNavigateFallbackDenied(p)).toBe(true);
    });
  }

  it("denies every prerendered public route", () => {
    for (const r of PUBLIC_ROUTES) {
      if (r.path === "/") continue;
      expect(isNavigateFallbackDenied(r.path), r.path).toBe(true);
    }
  });

  it("is a list of regexes, which is what Workbox is handed", () => {
    expect(NAVIGATE_FALLBACK_DENYLIST.length).toBeGreaterThan(10);
    for (const re of NAVIGATE_FALLBACK_DENYLIST) {
      expect(re).toBeInstanceOf(RegExp);
      // A global regex is stateful across .test() calls and would skip paths.
      expect(re.global).toBe(false);
    }
  });
});
