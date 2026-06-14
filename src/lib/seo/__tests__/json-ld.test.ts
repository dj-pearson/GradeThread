import { describe, it, expect } from "vitest";
import {
  organizationLd,
  webSiteLd,
  softwareApplicationLd,
  faqPageLd,
  breadcrumbLd,
  howToLd,
  certificateLd,
  personLd,
  profilePageLd,
} from "../json-ld";
import { SITE_URL } from "../public-routes";
// US-425: the cert SSR Pages Function builds its Product JSON-LD from this shared
// helper; the SPA route uses certificateLd above. The equivalence test below
// pins the two shapes equal so the two code paths can't drift.
import { certificateProductLd } from "../../../../functions/_shared/blog-render";

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

  it("personLd builds a Person with author-page url, dropping blanks (US-874)", () => {
    const ld = personLd({
      name: "Jane Doe",
      slug: "jane-doe",
      title: "Lead Analyst",
      sameAs: ["https://x.com/jane", "bad"],
      credentials: ["Cert A", "  "],
    });
    expect(ld["@type"]).toBe("Person");
    expect(ld.url).toBe(`${SITE_URL}/authors/jane-doe`);
    expect(ld.jobTitle).toBe("Lead Analyst");
    expect(ld.sameAs).toEqual(["https://x.com/jane"]);
    expect(ld.knowsAbout).toEqual(["Cert A"]);
  });

  it("profilePageLd wraps a Person as mainEntity (US-874)", () => {
    const ld = profilePageLd({ name: "X", slug: "x" });
    expect(ld["@type"]).toBe("ProfilePage");
    expect(ld.url).toBe(`${SITE_URL}/authors/x`);
    expect((ld.mainEntity as Record<string, unknown>)["@type"]).toBe("Person");
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

  // US-425: the cert page renders from two code paths — the SPA route
  // (certificateLd) and the cert SSR Pages Function (certificateProductLd).
  // These must emit equivalent Product JSON-LD so crawler markup doesn't drift.
  const CERT_INPUT = {
    id: "abc123",
    title: "Vintage Levi's 501",
    overallScore: 8.5,
    gradeTier: "Excellent",
    category: "denim",
    brand: "Levi's",
    images: ["https://img.example/front.jpg"],
    datePublished: "2026-01-01T00:00:00Z",
  };

  it("certificateLd includes the image field when images are provided", () => {
    const ld = certificateLd(CERT_INPUT);
    expect(ld.image).toEqual(["https://img.example/front.jpg"]);
    // …and omits it entirely when there are none (graceful, not image: []).
    const noImg = certificateLd({ ...CERT_INPUT, images: undefined });
    expect("image" in noImg).toBe(false);
  });

  it("SPA certificateLd and SSR certificateProductLd emit identical markup", () => {
    const spa = certificateLd(CERT_INPUT);
    const ssr = certificateProductLd({ ...CERT_INPUT, siteUrl: SITE_URL });
    expect(ssr).toEqual(spa);
    // Pin the shared shape so an accidental field change on either path fails here.
    expect(spa["@type"]).toBe("Product");
    expect((spa.review as Record<string, unknown>).name).toBe(
      "Condition grade: Excellent (8.5/10)",
    );
    expect((spa.review as Record<string, unknown>).author).toEqual({
      "@type": "Organization",
      name: "GradeThread",
      url: SITE_URL,
    });
    expect(spa.itemCondition).toBe("https://schema.org/UsedCondition");
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
