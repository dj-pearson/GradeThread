// US-871: branded social-card template (functions/_shared/og-template.ts).
//
// The card is rendered to PNG at the edge by workers-og (Satori), which needs
// valid, brand-consistent HTML in the right pixel dimensions. We can't raster
// in a unit test without the WASM worker runtime, but asserting the HTML
// structure (size, brand colors, wordmark, per-kind content, escaping) proves
// the template Satori consumes is well-formed for every aspect ratio.

import { describe, it, expect } from "vitest";
import {
  buildBlogOgHtml,
  buildCertBadgeHtml,
  buildCertOgHtml,
  buildCertSlabHtml,
  buildGradeResultCardHtml,
  buildSellerOgHtml,
  buildSocialCardHtml,
  isSocialCardRatio,
  SOCIAL_CARD_SIZES,
  type SocialCardRatio,
} from "../../functions/_shared/og-template";

const RATIOS: SocialCardRatio[] = ["landscape", "square", "portrait", "pin"];

describe("social card sizes", () => {
  it("exposes the four required aspect ratios at spec dimensions", () => {
    expect(SOCIAL_CARD_SIZES.landscape).toEqual({ width: 1200, height: 630 });
    expect(SOCIAL_CARD_SIZES.square).toEqual({ width: 1080, height: 1080 });
    expect(SOCIAL_CARD_SIZES.portrait).toEqual({ width: 1080, height: 1350 });
    expect(SOCIAL_CARD_SIZES.pin).toEqual({ width: 1000, height: 1500 });
  });

  it("isSocialCardRatio guards the known ratios", () => {
    for (const r of RATIOS) expect(isSocialCardRatio(r)).toBe(true);
    expect(isSocialCardRatio("banner")).toBe(false);
    expect(isSocialCardRatio(null)).toBe(false);
  });
});

describe("buildSocialCardHtml", () => {
  it("renders each ratio at its exact pixel dimensions, on-brand", () => {
    for (const ratio of RATIOS) {
      const { width, height } = SOCIAL_CARD_SIZES[ratio];
      const html = buildSocialCardHtml({
        ratio,
        kind: "title",
        text: "How condition grading builds buyer trust",
        product: "gradethread",
      });
      expect(html).toContain(`width:${width}px`);
      expect(html).toContain(`height:${height}px`);
      // Brand colors (navy + red).
      expect(html).toContain("#0F3460");
      expect(html).toContain("#E94560");
      // Wordmark.
      expect(html).toContain("GradeThread");
    }
  });

  it("renders the product badge per focus", () => {
    expect(buildSocialCardHtml({ ratio: "square", kind: "title", text: "x", product: "flipdesk" }))
      .toContain("FlipDesk");
    expect(buildSocialCardHtml({ ratio: "square", kind: "title", text: "x", product: "both" }))
      .toContain("GradeThread + FlipDesk");
  });

  it("renders the big number + caption for a stat card", () => {
    const html = buildSocialCardHtml({
      ratio: "landscape",
      kind: "stat",
      text: "average grade across 10k items",
      stat: "9.2",
    });
    expect(html).toContain("9.2");
    expect(html).toContain("average grade across 10k items");
  });

  it("renders a pull-quote card", () => {
    const html = buildSocialCardHtml({
      ratio: "pin",
      kind: "quote",
      text: "Buyers pay more when condition is verified.",
      eyebrow: "Reseller insight",
    });
    expect(html).toContain("Buyers pay more when condition is verified.");
    expect(html).toContain("Reseller insight");
  });

  it("escapes HTML in user-supplied text", () => {
    const html = buildSocialCardHtml({
      ratio: "landscape",
      kind: "title",
      text: `<script>alert("x")</script>`,
    });
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });
});

// The card endpoint shares functions/_shared/og-template.ts with the other
// dynamic share-image surfaces (cert OG/slab/badge, blog OG, seller). Exercising
// both arms of their optional-field branches keeps the shared template honest.
describe("sibling share-image templates", () => {
  it("buildCertOgHtml renders the score + tier, with and without a brand", () => {
    const withBrand = buildCertOgHtml({
      title: "Vintage Levi's 501",
      brand: "Levi's",
      score: 9.5,
      gradeTier: "Excellent",
      heroImageUrl: "https://cdn.example.com/a.jpg",
    });
    expect(withBrand).toContain("9.5");
    expect(withBrand).toContain("Excellent");
    expect(withBrand).toContain("Levi&#39;s");
    const noBrand = buildCertOgHtml({
      title: "Mystery jacket",
      brand: null,
      score: 7,
      gradeTier: "Very Good",
    });
    expect(noBrand).toContain("Pre-owned garment");
  });

  it("buildBlogOgHtml renders the title and joins available meta", () => {
    const full = buildBlogOgHtml({
      title: "How to grade denim",
      category: "Guides",
      authorName: "Jordan",
      publishedAt: "June 1, 2026",
    });
    expect(full).toContain("How to grade denim");
    expect(full).toContain("Guides · Jordan · June 1, 2026");
    const bare = buildBlogOgHtml({
      title: "Untitled",
      category: null,
      authorName: null,
      publishedAt: null,
    });
    expect(bare).toContain("GradeThread Insights");
  });

  it("buildSellerOgHtml handles capped totals and a zero average", () => {
    const capped = buildSellerOgHtml({
      displayName: "Thrift King",
      totalGraded: 1000,
      averageGrade: 8.4,
      totalIsCapped: true,
    });
    expect(capped).toContain("1,000+");
    expect(capped).toContain("8.4");
    const empty = buildSellerOgHtml({
      displayName: "New Seller",
      totalGraded: 0,
      averageGrade: 0,
    });
    expect(empty).toContain("—"); // no average yet
  });

  it("buildCertBadgeHtml renders the compact trust badge", () => {
    const html = buildCertBadgeHtml({ score: 6.5, gradeTier: "Good" });
    expect(html).toContain("6.5");
    expect(html).toContain("Good");
    expect(html).toContain("width:700px");
  });

  it("buildGradeResultCardHtml renders the grade, value range and subject, escaping input", () => {
    const withValue = buildGradeResultCardHtml({
      width: 1200,
      height: 630,
      score: 8.5,
      gradeTier: "Excellent",
      brand: "Patagonia",
      itemLabel: "fleece jacket",
      valueText: "$15 – $26",
      qrDataUri: "data:image/svg+xml;base64,AAAA",
    });
    expect(withValue).toContain("width:1200px");
    expect(withValue).toContain("8.5");
    expect(withValue).toContain("Excellent");
    expect(withValue).toContain("$15 – $26");
    expect(withValue).toContain("Estimated resale value");
    expect(withValue).toContain("Patagonia · fleece jacket");
    expect(withValue).toContain("Scan to try it free");
    // Brand colors present.
    expect(withValue).toContain("#0F3460");
    expect(withValue).toContain("#E94560");

    // No value → the fallback prompt, not a value block.
    const noValue = buildGradeResultCardHtml({
      width: 1200,
      height: 630,
      score: 6,
      gradeTier: "Very Good",
      valueText: null,
      qrDataUri: "data:image/svg+xml;base64,AAAA",
    });
    expect(noValue).not.toContain("Estimated resale value");
    expect(noValue).toContain("Free condition grade");

    // User-supplied brand/item is HTML-escaped.
    const xss = buildGradeResultCardHtml({
      width: 1200,
      height: 630,
      score: 5,
      gradeTier: "Good",
      brand: `<script>alert("x")</script>`,
      valueText: null,
      qrDataUri: "data:image/svg+xml;base64,AAAA",
    });
    expect(xss).not.toContain("<script>");
    expect(xss).toContain("&lt;script&gt;");
  });

  it("buildCertSlabHtml renders both the photo and label-only variants", () => {
    const photo = buildCertSlabHtml({
      width: 1080,
      height: 1080,
      title: "Carhartt Jacket",
      brand: "Carhartt",
      score: 8,
      gradeTier: "Excellent",
      heroImageUrl: "https://cdn.example.com/jacket.jpg",
      qrDataUri: "data:image/svg+xml;base64,AAAA",
      certId: "abcdef0123456789",
    });
    expect(photo).toContain("jacket.jpg");
    expect(photo).toContain("Scan to verify");
    const labelOnly = buildCertSlabHtml({
      width: 1080,
      height: 1080,
      title: "No-photo card",
      brand: null,
      score: 9,
      gradeTier: "NWOT",
      heroImageUrl: null,
      qrDataUri: "data:image/svg+xml;base64,AAAA",
      certId: "abcdef0123456789",
    });
    expect(labelOnly).toContain("out of 10");
    expect(labelOnly).toContain("Pre-owned garment");
  });
});
