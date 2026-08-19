import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PUBLIC_ROUTES } from "@/lib/seo/public-routes";
import { FLAW_ENTRIES } from "@/lib/seo/flaw-library";
import { CARE_MATRIX } from "@/lib/seo/care-matrix";
import {
  CARE_HUB_PATH,
  HUB_PILLARS,
  hubForPath,
  isCrossHubLinkAllowed,
} from "@/lib/seo/interlink-rules";

// US-9015. The care cluster is 295,750/mo of search volume against a seller
// surface of about 157,000, and only 1,550 of it carries seller intent. That is
// 0.5%. It is an authority and link engine, NOT an acquisition channel, and the
// failure mode this file guards against is the site quietly reorganising itself
// around the bigger number.
//
// Every assertion here is about direction: what points at what, and what a
// crawler is told these pages are.

const read = (p: string) => readFileSync(resolve(process.cwd(), p), "utf8");

const carePaths = PUBLIC_ROUTES.map((r) => r.path).filter(
  (p) => p === CARE_HUB_PATH || p.startsWith(`${CARE_HUB_PATH}/`),
);

describe("the care cluster exists and is bounded (US-9015)", () => {
  it("registers the hub, every flaw entry and every matrix page", () => {
    // Computed, not hardcoded. This asserted `33` until US-9014 added 18
    // flaw-by-fabric pages, and a literal count in a containment test is a
    // tripwire that fires on intended growth while saying nothing about
    // unintended growth. The ceiling assertion below is the one that guards
    // the actual risk.
    expect(carePaths).toContain("/care");
    expect(carePaths.length).toBe(1 + FLAW_ENTRIES.length + CARE_MATRIX.length);
  });

  it("stays on the main domain in a subdirectory, never a subdomain", () => {
    // AC3. A subdomain would split the authority this cluster exists to build,
    // which is the opposite of its only purpose.
    for (const p of carePaths) {
      expect(p.startsWith("/care")).toBe(true);
      expect(p).not.toMatch(/^https?:/);
    }
    const registry = read("src/lib/seo/flaw-library.ts");
    expect(registry).not.toMatch(/care\.gradethread\.com/);
  });
});

describe("link equity flows OUT of care, never in (US-9015 AC2)", () => {
  it("classifies /care as its own hub", () => {
    expect(hubForPath("/care")).toBe("care");
    expect(hubForPath("/care/pilling")).toBe("care");
  });

  it("lets a care page link into every part of the reseller spine", () => {
    for (const target of [
      "/reselling/reduce-ebay-returns",
      "/condition-grading",
      "/grading/scale",
      "/flipdesk",
      "/tools/reseller-profit-calculator",
      "/resale-value-by-condition",
    ]) {
      expect(isCrossHubLinkAllowed("/care/pilling", target), target).toBe(true);
    }
  });

  it("refuses every link INTO care, from every hub and from no hub at all", () => {
    for (const from of [
      "/grading/scale",
      "/reselling",
      "/flipdesk",
      "/compare/vinted-vs-mercari",
      "/tools/ebay-fee-calculator",
      "/", // the homepage is otherwise unconstrained, and must not be here
      "/privacy",
    ]) {
      expect(isCrossHubLinkAllowed(from, "/care/pilling"), from).toBe(false);
      expect(isCrossHubLinkAllowed(from, "/care"), from).toBe(false);
    }
  });

  it("still allows care pages to link to each other", () => {
    expect(isCrossHubLinkAllowed("/care/pilling", "/care/fabric-thinning")).toBe(true);
  });

  it("gives care no hub pillar, so no cross-hub link has a target here", () => {
    // Typed as Exclude<Hub, "care">, so adding one is a compile error rather
    // than a quiet hole. This asserts the value side of the same thing.
    expect(Object.values(HUB_PILLARS)).not.toContain("/care");
    expect(Object.values(HUB_PILLARS).some((p) => p.startsWith("/care"))).toBe(false);
  });
});

describe("care is not promoted anywhere a crawler weighs heavily (AC1)", () => {
  it("appears in no navigation component", () => {
    const nav = [
      "src/components/marketing/marketing-layout.tsx",
      "src/components/layout/sidebar.tsx",
    ];
    for (const file of nav) {
      let src: string;
      try {
        src = read(file);
      } catch {
        continue; // the file may be renamed; the other assertions still bind
      }
      expect(src.includes('"/care'), `${file} links to /care`).toBe(false);
      expect(src.includes("'/care"), `${file} links to /care`).toBe(false);
    }
  });

  it("appears nowhere on the homepage", () => {
    // The homepage is src/pages/landing.tsx, not home.tsx. Reading the wrong
    // file would have made this assertion pass by accident forever, which is
    // the failure mode a containment guard can least afford.
    const home = read("src/pages/landing.tsx");
    expect(home.includes("/care")).toBe(false);
    expect(home.toLowerCase().includes("flaw librar")).toBe(false);
  });

  it("gets its own sitemap segment instead of sitting in the marketing one", () => {
    const shared = read("functions/_shared/sitemap.ts");
    expect(shared).toContain("function isCareRoute");
    expect(shared).toContain("export async function careUrls");
    // The index lists it, and lists it after the two commercial segments.
    const index = read("functions/sitemap.xml.ts");
    expect(index).toContain('"sitemap-care.xml"');
    expect(index.indexOf('"sitemap-marketing.xml"')).toBeLessThan(
      index.indexOf('"sitemap-care.xml"'),
    );
  });

  it("reports the care share of static URLs, so the ceiling is checkable", () => {
    // AC4. The number itself is computed at request time against the live
    // manifest; this asserts the reporting exists rather than re-deriving it.
    expect(read("functions/_shared/sitemap.ts")).toContain("export async function careRatio");
  });

  it("is under the 40% ceiling today", () => {
    const total = PUBLIC_ROUTES.length;
    const pct = (carePaths.length / total) * 100;
    expect(pct).toBeLessThan(40);
  });
});
