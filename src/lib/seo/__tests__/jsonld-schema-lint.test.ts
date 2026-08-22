// US-1681: build/CI guard — every route's JSON-LD (and the dynamic cert/passport
// nodes) must pass the structured-data linter, so a pSEO template can never ship
// broken schema.org markup at scale. A violation fails CI (which runs before the
// build gate).
//
// There is no docs/STRUCTURED_DATA_LINT.md and there never has been — this
// header used to promise one. What to read instead when a case here goes red:
// the rules live in src/lib/seo/jsonld-lint.ts (LINTED_TYPES and the per-type
// requirements), and what each route emits is built by
// src/prerender/head-builder.ts jsonLdForRoute.

import { describe, it, expect } from "vitest";
import { PUBLIC_ROUTES } from "@/lib/seo/public-routes";
import { jsonLdForRoute } from "@/prerender/head-builder";
import {
  lintJsonLd,
  lintJsonLdNode,
  LINTED_TYPES,
  type JsonLdNode,
} from "@/lib/seo/jsonld-lint";
import { certificateLd, passportLd } from "@/lib/seo/json-ld";

describe("JSON-LD schema lint (US-1681)", () => {
  // Every registered route type: marketing, grading pillars, glossary
  // (DefinedTerm/Set), FlipDesk (SoftwareApplication), legal, disambiguation.
  it.each(PUBLIC_ROUTES.map((r) => [r.path] as const))(
    "%s emits valid JSON-LD",
    (path) => {
      const nodes = jsonLdForRoute(path) as JsonLdNode[];
      expect(nodes.length).toBeGreaterThan(0);
      expect(lintJsonLd(nodes)).toEqual([]);
    },
  );

  it("home route emits valid Organization/WebSite/SoftwareApplication/FAQPage", () => {
    expect(lintJsonLd(jsonLdForRoute("/") as JsonLdNode[])).toEqual([]);
  });

  // Dynamic Product nodes (not in PUBLIC_ROUTES) — the highest-volume surface.
  it("certificate Product JSON-LD is valid (itemCondition + PropertyValue + Rating)", () => {
    const ld = certificateLd({
      id: "11111111-2222-3333-4444-555555555555",
      title: "Nike Sportswear Hoodie",
      overallScore: 8.5,
      gradeTier: "Excellent",
      category: "outerwear",
      brand: "Nike",
      images: ["https://gradethread.com/x/front.jpg"],
      datePublished: "2026-01-01",
    }) as JsonLdNode;
    expect(lintJsonLdNode(ld)).toEqual([]);
    // The grade really is in shared vocabulary.
    expect((ld.additionalProperty as JsonLdNode).name).toBe("GradeThread Grade");
    expect(ld.itemCondition).toBe("https://schema.org/UsedCondition");
  });

  it("a New-condition (grade 10) certificate maps to NewCondition", () => {
    const ld = certificateLd({
      id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      title: "NWT Levi's 501",
      overallScore: 10,
      gradeTier: "NWT",
    }) as JsonLdNode;
    expect(lintJsonLdNode(ld)).toEqual([]);
    expect(ld.itemCondition).toBe("https://schema.org/NewCondition");
  });

  it("passport Product JSON-LD is valid", () => {
    const ld = passportLd({
      slug: "some-garment-slug",
      name: "Carhartt Detroit Jacket",
      category: "outerwear",
      brand: "Carhartt",
      latestGrade: { score: 7, tier: "Very Good", datePublished: "2026-01-01" },
    }) as JsonLdNode;
    expect(lintJsonLdNode(ld)).toEqual([]);
  });

  // The linter must actually KNOW the AC's required types (so a green run means
  // real coverage, not "no checker ran").
  it("covers the AC's required schema types", () => {
    for (const t of [
      "DefinedTermSet",
      "DefinedTerm",
      "HowTo",
      "Article",
      "SoftwareApplication",
      "Product",
    ]) {
      expect(LINTED_TYPES).toContain(t);
    }
  });

  // Negative control: the linter must FLAG a broken node (so it isn't a no-op).
  it("flags broken markup", () => {
    expect(
      lintJsonLdNode({ "@context": "https://schema.org", "@type": "Product" }).length,
    ).toBeGreaterThan(0); // missing name + itemCondition
    expect(
      lintJsonLdNode({
        "@context": "https://schema.org",
        "@type": "Product",
        name: "X",
        itemCondition: "https://schema.org/BananaCondition",
      }).some((v) => v.includes("OfferItemCondition")),
    ).toBe(true);
    expect(
      lintJsonLdNode({ "@type": "Article", headline: "x" }).some((v) =>
        v.includes("@context"),
      ),
    ).toBe(true);
  });
});
