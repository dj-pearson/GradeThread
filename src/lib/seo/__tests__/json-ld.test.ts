import { describe, it, expect } from "vitest";
import {
  organizationLd,
  webSiteLd,
  softwareApplicationLd,
  faqPageLd,
  breadcrumbLd,
  howToLd,
  certificateLd,
} from "../json-ld";

describe("JSON-LD builders (US-298/299/300)", () => {
  it("organizationLd has the core entity fields", () => {
    const ld = organizationLd();
    expect(ld["@type"]).toBe("Organization");
    expect(ld["@id"]).toMatch(/#organization$/);
    expect(ld.name).toBe("GradeThread");
    expect(ld.url).toMatch(/^https:\/\//);
    expect(ld.logo).toMatch(/^https:\/\//);
  });

  it("webSiteLd omits SearchAction unless a real search URL is given", () => {
    expect(webSiteLd().potentialAction).toBeUndefined();
    const withSearch = webSiteLd(
      "https://gradethread.com/blog?q={search_term_string}",
    );
    const action = withSearch.potentialAction as Record<string, unknown>;
    expect(action["@type"]).toBe("SearchAction");
    expect(withSearch["query-input"] ?? action).toBeDefined();
  });

  it("softwareApplicationLd carries an Offer with a numeric price string", () => {
    const ld = softwareApplicationLd();
    expect(ld["@type"]).toBe("SoftwareApplication");
    const offer = ld.offers as Record<string, unknown>;
    expect(offer.priceCurrency).toBe("USD");
    expect(typeof offer.price).toBe("string");
    expect(Number.isNaN(Number(offer.price))).toBe(false);
  });

  it("faqPageLd maps each Q/A to a Question + acceptedAnswer", () => {
    const ld = faqPageLd([
      { q: "Q1", a: "A1" },
      { q: "Q2", a: "A2" },
    ]);
    expect(ld["@type"]).toBe("FAQPage");
    const entities = ld.mainEntity as Array<Record<string, unknown>>;
    expect(entities).toHaveLength(2);
    const first = entities[0]!;
    expect(first["@type"]).toBe("Question");
    expect((first.acceptedAnswer as Record<string, unknown>).text).toBe("A1");
  });

  it("breadcrumbLd numbers positions from 1", () => {
    const ld = breadcrumbLd([
      { name: "Home", url: "https://x/" },
      { name: "Sub", url: "https://x/sub" },
    ]);
    const items = ld.itemListElement as Array<Record<string, unknown>>;
    expect(items[0]!.position).toBe(1);
    expect(items[1]!.position).toBe(2);
    expect(items[1]!.item).toBe("https://x/sub");
  });

  it("howToLd numbers steps from 1", () => {
    const ld = howToLd({
      name: "How",
      steps: [
        { name: "S1", text: "do 1" },
        { name: "S2", text: "do 2" },
      ],
    });
    const steps = ld.step as Array<Record<string, unknown>>;
    expect(steps).toHaveLength(2);
    expect(steps[0]!.position).toBe(1);
    expect(steps[0]!["@type"]).toBe("HowToStep");
  });

  it("certificateLd expresses the grade as a bounded Rating", () => {
    const ld = certificateLd({
      id: "abc123",
      title: "Vintage Levi's 501",
      overallScore: 8.5,
      gradeTier: "Excellent",
      brand: "Levi's",
      datePublished: "2026-01-01T00:00:00Z",
    });
    expect(ld["@type"]).toBe("Product");
    expect(ld["@id"]).toMatch(/\/cert\/abc123$/);
    const review = ld.review as Record<string, unknown>;
    const rating = review.reviewRating as Record<string, unknown>;
    expect(rating.ratingValue).toBe(8.5);
    expect(rating.bestRating).toBe(10);
    expect(rating.worstRating).toBe(1);
    expect(rating.alternateName).toBe("Excellent");
    expect((ld.brand as Record<string, unknown>).name).toBe("Levi's");
  });

  it("every builder is valid JSON (serializes without throwing)", () => {
    const all = [
      organizationLd(),
      webSiteLd(),
      softwareApplicationLd(),
      faqPageLd([{ q: "q", a: "a" }]),
      breadcrumbLd([{ name: "n", url: "https://x/" }]),
      howToLd({ name: "h", steps: [{ name: "s", text: "t" }] }),
      certificateLd({
        id: "1",
        title: "t",
        overallScore: 5,
        gradeTier: "Good",
      }),
    ];
    for (const ld of all) {
      expect(ld["@context"]).toBe("https://schema.org");
      expect(() => JSON.stringify(ld)).not.toThrow();
    }
  });
});
