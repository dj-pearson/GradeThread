import { describe, expect, it } from "vitest";
import {
  CALCULATORS,
  CALCULATOR_HUB_META,
  CALCULATOR_HUB_PATH,
  calculatorPath,
  calculatorRoutes,
  getCalculatorByPath,
  getCalculatorBySlug,
  isCalculatorHubPath,
  liveCalculators,
} from "@/lib/seo/calculators";
import { PUBLIC_ROUTES } from "@/lib/seo/public-routes";
import {
  calculatorBreadcrumbLdItems,
  calculatorHubBreadcrumbLdItems,
} from "@/pages/marketing/marketing-jsonld";

// US-9002. The family's whole safety property is that a calculator is not
// routable until its compute exists, so most of what is worth asserting here is
// about what does NOT get registered.

describe("calculator registry", () => {
  it("has unique slugs", () => {
    const slugs = CALCULATORS.map((c) => c.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  it("every entry names the story that ships its compute", () => {
    for (const c of CALCULATORS) {
      expect(c.story, `${c.slug} has no story`).toMatch(/^US-\d+$/);
    }
  });

  it("every entry carries a non-empty primary keyword", () => {
    for (const c of CALCULATORS) {
      expect(c.primaryKeyword.trim().length, `${c.slug}`).toBeGreaterThan(0);
    }
  });

  it("keeps titles and descriptions inside the real US-435 budget", () => {
    // 60 minus the " | GradeThread" the SEO layer appends. The first draft of
    // this test used a bare 60 and let four over-length titles through;
    // route-metadata.test.ts caught them once the family went live.
    const TITLE_MAX = 60 - " | GradeThread".length;
    for (const c of [...CALCULATORS, CALCULATOR_HUB_META]) {
      expect(c.title.length, `title too long: "${c.title}"`).toBeLessThanOrEqual(TITLE_MAX);
      expect(c.description.length, `description too long: "${c.title}"`).toBeLessThanOrEqual(160);
      expect(c.description.length, `description too short: "${c.title}"`).toBeGreaterThanOrEqual(70);
    }
  });

  it("resolves slugs and paths back to the same entry", () => {
    for (const c of CALCULATORS) {
      expect(getCalculatorBySlug(c.slug)).toBe(c);
      expect(getCalculatorByPath(calculatorPath(c.slug))).toBe(c);
      expect(getCalculatorByPath(`${calculatorPath(c.slug)}/`)).toBe(c);
    }
    expect(getCalculatorBySlug("not-a-calculator")).toBeUndefined();
  });

  it("recognises the hub path with or without a trailing slash", () => {
    expect(isCalculatorHubPath(CALCULATOR_HUB_PATH)).toBe(true);
    expect(isCalculatorHubPath(`${CALCULATOR_HUB_PATH}/`)).toBe(true);
    expect(isCalculatorHubPath("/tools/authenticity-check")).toBe(false);
  });

  it("breadcrumbs run home, hub, page", () => {
    // MOVED OFF A DEAD FUNCTION. This asserted calculatorBreadcrumbItems, which
    // returned relative paths and was called by nothing — so the trail that
    // every calculator page actually emits was untested, while the one nothing
    // rendered had a passing case. The live builders are the *LdItems pair in
    // marketing-jsonld.ts, and they return absolute urls.
    const first = CALCULATORS[0];
    expect(first).toBeDefined();
    if (!first) return;
    const crumbs = calculatorBreadcrumbLdItems(first);
    expect(crumbs.map((c) => c.name)).toEqual([
      "GradeThread",
      "Calculators",
      first.h1,
    ]);
    expect(crumbs.map((c) => c.url)).toEqual([
      "https://gradethread.com/",
      `https://gradethread.com${CALCULATOR_HUB_PATH}`,
      `https://gradethread.com${calculatorPath(first.slug)}`,
    ]);
  });

  it("the hub's own trail stops at the hub", () => {
    // The hub is the second crumb, not a third pointing at itself.
    const crumbs = calculatorHubBreadcrumbLdItems();
    expect(crumbs.map((c) => c.name)).toEqual(["GradeThread", "Calculators"]);
    expect(crumbs[crumbs.length - 1]?.url).toBe(
      `https://gradethread.com${CALCULATOR_HUB_PATH}`,
    );
  });
});

describe("calculator routing", () => {
  it("registers nothing at all while every calculator is planned", () => {
    // The hub included. An empty list page is a worse result than no page, so
    // US-9002's wiring only takes effect when US-9003 flips the first entry to
    // live. Delete this test at that point, not before.
    if (liveCalculators().length === 0) {
      expect(calculatorRoutes()).toEqual([]);
    }
  });

  it("routes exactly the live calculators, plus the hub", () => {
    const routes = calculatorRoutes();
    const live = liveCalculators();
    if (live.length === 0) {
      expect(routes).toHaveLength(0);
      return;
    }
    expect(routes).toHaveLength(live.length + 1);
    expect(routes[0]?.path).toBe(CALCULATOR_HUB_PATH);
    for (const c of live) {
      const r = routes.find((x) => x.path === calculatorPath(c.slug));
      expect(r, `${c.slug} is live but unrouted`).toBeDefined();
      expect(r?.title).toBe(c.title);
      expect(r?.description).toBe(c.description);
      expect(r?.jsonLdType).toBe("WebApplication");
    }
  });

  it("never registers a planned calculator in PUBLIC_ROUTES", () => {
    const planned = CALCULATORS.filter((c) => c.status === "planned");
    const paths = new Set(PUBLIC_ROUTES.map((r) => r.path));
    for (const c of planned) {
      expect(paths.has(calculatorPath(c.slug)), `${c.slug} is planned but routed`).toBe(false);
    }
  });

  it("puts every live calculator into PUBLIC_ROUTES", () => {
    const paths = new Set(PUBLIC_ROUTES.map((r) => r.path));
    for (const c of liveCalculators()) {
      expect(paths.has(calculatorPath(c.slug)), `${c.slug} is live but missing`).toBe(true);
    }
  });

  it("does not collide with the tool pages that already exist", () => {
    const existing = ["/tools/authenticity-check", "/tools/fit-checker", "/tools/grade-checker"];
    for (const c of CALCULATORS) {
      expect(existing).not.toContain(calculatorPath(c.slug));
    }
  });
});
