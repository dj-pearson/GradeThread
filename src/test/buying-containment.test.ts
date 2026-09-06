import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { requireDist } from "./dist-required";
import { resolve } from "node:path";
import { PUBLIC_ROUTES } from "@/lib/seo/public-routes";
import { BUYING_GUIDES, buyingGuidePath } from "@/lib/seo/buying-guides";
import { extensionCtaFor } from "@/lib/seo/extension-cta-copy";
import {
  BUYING_FORBIDDEN_TARGETS,
  BUYING_HUB_PATH,
  HUB_PILLARS,
  hubForPath,
  isBuyingLinkAllowed,
  isCrossHubLinkAllowed,
} from "@/lib/seo/interlink-rules";

// US-3093. These pages are read by a BUYER, on a site whose customer is a
// seller. That is the whole risk: 155,000/mo of buyer-intent search pointed at
// a domain sold on reseller queries, and a site that quietly reorganises itself
// around the bigger number ends up a weaker match for the smaller one it earns
// from.
//
// Every assertion here is about direction and about what a reader is offered.

const read = (p: string) => readFileSync(resolve(process.cwd(), p), "utf8");

/** Source with comments removed, so a guard cannot fire on its own rationale. */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, " ")
    .split("\n")
    .map((l) => {
      const i = l.search(/(^|[^:])\/\//);
      return i === -1 ? l : l.slice(0, i);
    })
    .join("\n");
}

const buyingPaths = PUBLIC_ROUTES.map((r) => r.path).filter(
  (p) => p === BUYING_HUB_PATH || p.startsWith(`${BUYING_HUB_PATH}/`),
);

describe("the buying cluster exists and is bounded (US-3093)", () => {
  it("registers exactly the guides in the registry, and no hub page", () => {
    expect(buyingPaths.length).toBe(BUYING_GUIDES.length);
    expect(buyingPaths).not.toContain(BUYING_HUB_PATH);
    for (const g of BUYING_GUIDES) {
      expect(buyingPaths).toContain(buyingGuidePath(g.slug));
    }
  });

  it("ships is-vinted-legit and nothing US-3087 has not cleared", () => {
    // AC3. The other three terms ship only on an OPEN verdict from the SERP
    // gate. This is a REMINDER, not a ceiling: when the gate comes back, the
    // pages that clear it are added here and this list grows with them.
    expect(BUYING_GUIDES.map((g) => g.slug)).toEqual(["is-vinted-legit"]);
  });

  it("answers the question in the first paragraph", () => {
    // AC4. Somebody who searched "is X legit" is deciding whether to hand money
    // to a stranger in the next minute. Burying the answer under four sections
    // is answering a different question.
    for (const g of BUYING_GUIDES) {
      expect(g.answer.length).toBeGreaterThan(80);
      expect(g.answer.trimStart().slice(0, 4).toLowerCase()).toMatch(/^(yes|no)[.,]/);
    }
  });
});

describe("nothing links INTO buying (US-3093 AC1)", () => {
  it("classifies /buying as its own hub", () => {
    expect(hubForPath("/buying")).toBe("buying");
    expect(hubForPath("/buying/is-vinted-legit")).toBe("buying");
  });

  it("refuses a link into buying from every other hub and from nowhere", () => {
    for (const from of [
      "/",
      "/pricing",
      "/reselling",
      "/reselling/how-to-sell-on-vinted",
      "/grading/scale",
      "/flipdesk",
      "/care/pilling",
      "/compare/vinted-vs-mercari",
    ]) {
      expect(
        isCrossHubLinkAllowed(from, "/buying/is-vinted-legit"),
        `${from} may link into /buying`,
      ).toBe(false);
    }
  });

  it("has no pillar, by its type rather than by omission", () => {
    // Adding one would be a compile error, which is the point of the
    // Exclude<Hub, "care" | "buying"> on HUB_PILLARS. This is the runtime half.
    expect(Object.values(HUB_PILLARS)).not.toContain(BUYING_HUB_PATH);
    for (const target of Object.values(HUB_PILLARS)) {
      expect(target.startsWith(BUYING_HUB_PATH)).toBe(false);
    }
  });
});

describe("buying links OUT to one product surface only (US-3093 AC6)", () => {
  it("refuses the seller pages by path, not by hub", () => {
    // ⚠ THE HUB CHECK ALONE IS NOT ENOUGH, and that is why this list exists.
    // /pricing is a NON-HUB path, and isCrossHubLinkAllowed lets non-hub
    // targets through — so a buying page linking at /pricing would pass a
    // hub-only rule while being exactly the thing AC6 forbids.
    for (const bad of BUYING_FORBIDDEN_TARGETS) {
      expect(isBuyingLinkAllowed(bad), bad).toBe(false);
      expect(isBuyingLinkAllowed(`${bad}/anything`), `${bad}/anything`).toBe(false);
      expect(
        isCrossHubLinkAllowed("/buying/is-vinted-legit", bad),
        `a buying page may link at ${bad}`,
      ).toBe(false);
    }
    expect(BUYING_FORBIDDEN_TARGETS).toContain("/pricing");
    expect(BUYING_FORBIDDEN_TARGETS).toContain("/flipdesk");
  });

  it("still lets it link at what a buyer actually asked about", () => {
    for (const good of ["/grading/scale", "/verify", "/buyer-guarantee"]) {
      expect(isBuyingLinkAllowed(good), good).toBe(true);
      expect(isCrossHubLinkAllowed("/buying/is-vinted-legit", good)).toBe(true);
    }
  });

  it("renders no seller CTA and no forbidden link in the page source", () => {
    // The source assertion, because a rendered page with a signup CTA and one
    // without look equally finished. MarketingCTA is what every other marketing
    // page ends with, and adding it back here would read as consistency.
    // Comments stripped first. The page explains at length WHY it has no
    // MarketingCTA, and a guard that reads the explanation fires on the reason
    // rather than the behaviour — which is the second time today.
    const page = stripComments(read("src/pages/marketing/buying-guide.tsx"));
    expect(page).not.toMatch(/MarketingCTA/);
    for (const bad of BUYING_FORBIDDEN_TARGETS) {
      expect(page.includes(`"${bad}"`), `the page links at ${bad}`).toBe(false);
    }
    // And the prose does not sneak one in either.
    const registry = read("src/lib/seo/buying-guides.ts");
    for (const bad of BUYING_FORBIDDEN_TARGETS) {
      expect(registry.includes(`](${bad}`), `the copy links at ${bad}`).toBe(false);
    }
  });

  it("⚠ and the RENDERED page carries none of them either", () => {
    // The assertion this file used to stop short of, and the reason AC6 was
    // recorded as unmet: the page COMPONENT linked nothing forbidden, while the
    // shared chrome linked all three on every marketing page. The header nav
    // was the more visible half — a buyer reading "am I about to be scammed"
    // meets Pricing and FlipDesk before the article — and it was the half a
    // grep for /pricing in the page source could never find.
    //
    // Skips locally without a build, fails loudly in CI, per US-2038/US-2637.
    if (!requireDist(resolve(process.cwd(), "dist/index.html"), "buying containment")) return;
    const page = resolve(process.cwd(), "dist/buying/is-vinted-legit.html");
    if (!existsSync(page)) return;
    const html = readFileSync(page, "utf8");

    for (const bad of BUYING_FORBIDDEN_TARGETS) {
      expect(
        new RegExp(`href="[^"]*${bad}"`).test(html),
        `the rendered /buying page links ${bad}`,
      ).toBe(false);
    }

    // And the things that MUST survive the lean chrome. Dropping the footer
    // wholesale would have taken these with it, which on a page about not being
    // scammed is the wrong trade.
    for (const kept of ["/privacy", "/terms", "/dmca"]) {
      expect(
        new RegExp(`href="[^"]*${kept}"`).test(html),
        `the rendered /buying page lost ${kept}`,
      ).toBe(true);
    }
    // The one product surface it is allowed.
    expect(html).toContain("chromewebstore.google.com");
  });

  it("offers the extension install, with buyer copy naming the marketplace", () => {
    // AC4's CTA half. The role matters as much as the words: a button labelled
    // for listing, shown to somebody deciding whether to buy, is the wrong ask
    // at the one moment they are paying attention.
    for (const g of BUYING_GUIDES) {
      const cta = extensionCtaFor(buyingGuidePath(g.slug));
      expect(cta, `${g.slug} has no CTA copy`).toBeTruthy();
      expect(cta!.role).toBe("buyer");
      expect(cta!.does).toContain(g.marketplace);
      expect(cta!.does).toMatch(/before you (pay|buy)/i);
    }
  });
});

describe("its own sitemap segment and ratio ceiling (US-3093 AC2)", () => {
  const sitemap = read("functions/_shared/sitemap.ts");

  it("partitions buying out of marketing and grading", () => {
    expect(sitemap).toMatch(/function isBuyingRoute/);
    expect(sitemap).toMatch(/export async function buyingUrls/);
    // Checked BEFORE grading, or a page about condition lands in the grading
    // segment and stops being measurable on its own.
    expect(sitemap.indexOf("isBuyingRoute(r.path)")).toBeLessThan(
      sitemap.indexOf("isGradingRoute(r.path)"),
    );
  });

  it("caps buying at 10%, a quarter of care's ceiling", () => {
    expect(sitemap).toMatch(/export async function buyingRatio/);
    expect(sitemap).toMatch(/THE CEILING IS 10%/);
    // ⚠ AND BUYING IS IN CARE'S DENOMINATOR. Leaving it out would shrink the
    // total and inflate care's share — a ceiling reading high rather than low,
    // which is the safe direction and still a wrong number.
    const careFn = sitemap.slice(sitemap.indexOf("export async function careRatio"));
    expect(careFn).toMatch(/const \{ marketing, grading, care, buying \}/);
    expect(careFn).toMatch(/care\.length \+ buying\.length/);
  });

  it("is listed in the sitemap index and served by _routes.json", () => {
    expect(read("functions/sitemap.xml.ts")).toContain('"sitemap-buying.xml"');
    const routes = JSON.parse(read("public/_routes.json")) as { include: string[] };
    expect(routes.include).toContain("/sitemap-buying.xml");
    // After the commercial segments, which is a statement about what these
    // pages are rather than a cosmetic ordering.
    const index = read("functions/sitemap.xml.ts");
    expect(index.indexOf('"sitemap-buying.xml"')).toBeGreaterThan(
      index.indexOf('"sitemap-marketing.xml"'),
    );
  });
});
