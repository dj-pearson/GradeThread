import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { StaticRouter } from "react-router";
import { Breadcrumbs, type BreadcrumbItem } from "./breadcrumbs";
import {
  breadcrumbListLd,
  renderBreadcrumbs,
} from "../../functions/_shared/blog-render";
import { SITE_URL } from "@/lib/seo/site";

// US-433: the visible breadcrumb (React + SSR) must match the BreadcrumbList
// JSON-LD on every public surface, and use canonical-derived URLs.

const TRAIL: BreadcrumbItem[] = [
  { name: "GradeThread", url: `${SITE_URL}/` },
  { name: "Condition grading", url: `${SITE_URL}/condition-grading` },
  { name: "Excellent (8/10)", url: `${SITE_URL}/grading/excellent` },
];

function renderReact(items: BreadcrumbItem[]): string {
  return renderToStaticMarkup(
    <StaticRouter location="/grading/excellent">
      <Breadcrumbs items={items} />
    </StaticRouter>,
  );
}

describe("Breadcrumbs (React, US-433)", () => {
  it("renders a labelled nav with every trail name", () => {
    const html = renderReact(TRAIL);
    expect(html).toContain('aria-label="Breadcrumb"');
    for (const item of TRAIL) expect(html).toContain(item.name);
  });

  it("links non-final items to root-relative paths; final is aria-current", () => {
    const html = renderReact(TRAIL);
    expect(html).toContain('href="/condition-grading"');
    expect(html).toContain('href="/"');
    expect(html).toContain('aria-current="page"');
    // The current page is NOT a link.
    expect(html).not.toContain('href="/grading/excellent"');
  });

  it("renders nothing for a single-item trail", () => {
    expect(renderReact([TRAIL[0]!])).toBe("");
  });
});

describe("SSR breadcrumbs (US-433)", () => {
  it("breadcrumbListLd positions + names + URLs match the trail", () => {
    const ld = breadcrumbListLd(TRAIL) as {
      itemListElement: Array<{ position: number; name: string; item: string }>;
    };
    expect(ld.itemListElement).toHaveLength(3);
    ld.itemListElement.forEach((el, i) => {
      expect(el.position).toBe(i + 1);
      expect(el.name).toBe(TRAIL[i]!.name);
      expect(el.item).toBe(TRAIL[i]!.url);
    });
  });

  it("renderBreadcrumbs emits a nav whose links + current match the JSON-LD", () => {
    const html = renderBreadcrumbs(TRAIL, SITE_URL);
    expect(html).toContain('aria-label="Breadcrumb"');
    expect(html).toContain('href="/condition-grading"');
    expect(html).toContain('aria-current="page"');
    for (const item of TRAIL) expect(html).toContain(item.name);
    // Absolute SITE_URL never leaks into the visible href (root-relative only).
    expect(html).not.toContain(SITE_URL);
  });

  it("wide variant aligns with .container--wide pages", () => {
    expect(renderBreadcrumbs(TRAIL, SITE_URL, { wide: true })).toContain(
      "breadcrumbs--wide",
    );
  });

  it("returns empty string for a single-item trail", () => {
    expect(renderBreadcrumbs([TRAIL[0]!], SITE_URL)).toBe("");
  });

  it("the visible nav and the JSON-LD carry the same ordered names", () => {
    const ld = breadcrumbListLd(TRAIL) as {
      itemListElement: Array<{ name: string }>;
    };
    const html = renderBreadcrumbs(TRAIL, SITE_URL);
    const visibleOrder = TRAIL.map((t) => html.indexOf(t.name));
    // Names appear in trail order in the rendered HTML.
    expect(visibleOrder).toEqual([...visibleOrder].sort((a, b) => a - b));
    expect(ld.itemListElement.map((e) => e.name)).toEqual(
      TRAIL.map((t) => t.name),
    );
  });
});
