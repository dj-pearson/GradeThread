import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { extensionCtaFor, BUYER_HOME_CTA } from "@/lib/seo/extension-cta-copy";
import { isFirefoxUserAgent } from "@/lib/lister-extension";
import { PUBLIC_ROUTES } from "@/lib/seo/public-routes";
import { COMPARISONS, comparePath } from "@/lib/seo/comparison-guides";
import { GARMENT_GUIDES, guidePath } from "@/lib/seo/garment-guides";
import { FLIPDESK_LANDINGS } from "@/lib/seo/flipdesk-landing";

// US-9210 AC2: an install call to action on every /tools/* page, every
// /compare/* page, the garment guides, the FlipDesk landings and the buyer
// home, with copy that says what the extension does on the site the reader is
// about to visit.

const ROOT = join(__dirname, "..", "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

describe("extension install CTA (US-9210)", () => {
  it("every tool page has copy", () => {
    const tools = PUBLIC_ROUTES.filter((r) => r.path.startsWith("/tools/"));
    expect(tools.length).toBeGreaterThan(5);
    for (const r of tools) expect(extensionCtaFor(r.path), r.path).not.toBeNull();
  });
  it("every comparison names both marketplaces", () => {
    for (const c of COMPARISONS) {
      const copy = extensionCtaFor(comparePath(c.slug));
      expect(copy?.does, c.slug).toContain(c.platformA);
      expect(copy?.does, c.slug).toContain(c.platformB);
    }
  });
  it("every garment guide names the garment", () => {
    for (const g of GARMENT_GUIDES) {
      expect(extensionCtaFor(guidePath(g.slug))?.does, g.slug).toContain(g.garment.toLowerCase());
    }
  });
  it("every FlipDesk landing gets the seller copy, and the buyer home its own", () => {
    for (const l of FLIPDESK_LANDINGS) expect(extensionCtaFor(l.path)?.role, l.path).toBe("seller");
    expect(BUYER_HOME_CTA.role).toBe("buyer");
  });
  it("pages outside the funnel get nothing", () => {
    expect(extensionCtaFor("/pricing")).toBeNull();
    expect(extensionCtaFor("/")).toBeNull();
    expect(extensionCtaFor("/reselling/vendoo-alternative")).toBeNull();
  });
  it("the copy says what it does, never a marketplace brand list", () => {
    // The store-copy rule (SUBMISSION.md) is about the LISTING; site copy may
    // name the site it is about, but a tool page must not enumerate brands.
    for (const r of PUBLIC_ROUTES.filter((r) => r.path.startsWith("/tools/"))) {
      const does = extensionCtaFor(r.path)?.does ?? "";
      expect(does).toMatch(/before you pay|marketplace|listing/);
      expect(does).not.toMatch(/eBay, Poshmark, Mercari/);
    }
  });
  it("Firefox gets the Firefox store, everything else Chrome", () => {
    expect(isFirefoxUserAgent("Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0")).toBe(true);
    expect(isFirefoxUserAgent("Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 Chrome/120.0 Safari/537.36")).toBe(false);
    expect(isFirefoxUserAgent(null)).toBe(false);
  });
  it("is wired into the marketing layout and the buyer home, and the event is emitted", () => {
    expect(read("src/components/marketing/marketing-layout.tsx")).toMatch(/<ExtensionInstallCta path=\{canonicalPath\}/);
    expect(read("src/pages/buyer/home.tsx")).toMatch(/BUYER_HOME_CTA/);
    expect(read("src/components/marketing/extension-install-cta.tsx")).toMatch(/track\("extension_install_cta_click"/);
    expect(read(".env.example")).toMatch(/VITE_EXTENSION_AMO_URL=/);
  });
});
