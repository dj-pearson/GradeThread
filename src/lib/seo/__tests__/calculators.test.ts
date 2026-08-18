import { describe, expect, it } from "vitest";
import {
  CALCULATORS,
  CALCULATOR_HUB_META,
  CALCULATOR_HUB_PATH,
  calculatorBreadcrumbItems,
  calculatorPath,
  calculatorRoutes,
  getCalculatorByPath,
  getCalculatorBySlug,
  isCalculatorHubPath,
  liveCalculators,
} from "@/lib/seo/calculators";
import { PUBLIC_ROUTES } from "@/lib/seo/public-routes";

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

  it("keeps titles and descriptions inside what a SERP will render", () => {
    for (const c of [...CALCULATORS, CALCULATOR_HUB_META]) {
      expect(c.title.length, `${c.title} is too long`).toBeLessThanOrEqual(60);
      expect(c.description.length, `${c.title} description`).toBeLessThanOrEqual(200);
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
    const first = CALCULATORS[0];
    expect(first).toBeDefined();
    if (!first) return;
    const crumbs = calculatorBreadcrumbItems(first);
    expect(crumbs.map((c) => c.path)).toEqual([
      "/",
      CALCULATOR_HUB_PATH,
      calculatorPath(first.slug),
    ]);
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
