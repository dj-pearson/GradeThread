// US-871: branded social-card template (functions/_shared/og-template.ts).
//
// The card is rendered to PNG at the edge by workers-og (Satori), which needs
// valid, brand-consistent HTML in the right pixel dimensions. We can't raster
// in a unit test without the WASM worker runtime, but asserting the HTML
// structure (size, brand colors, wordmark, per-kind content, escaping) proves
// the template Satori consumes is well-formed for every aspect ratio.

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, sep } from "node:path";
import {
  buildBlogOgHtml,  buildGradeResultCardHtml,
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
// dynamic share-image surfaces (blog OG, help, seller, grade result). Exercising
// both arms of their optional-field branches keeps the shared template honest.
//
// THE CERT OG / SLAB / BADGE CASES USED TO BE HERE AND WERE WORSE THAN NOTHING
// (US-2619 AC9). Those three routes proxy to the Deno edge, which owns their
// layout in lib/cert-og-template.ts — the Pages copies had zero importers and
// had already DIVERGED from the live ones. So the tests passed on markup nobody
// rendered, and anyone changing the certificate card here would have seen green
// and shipped nothing. The Pages copies are deleted; the edge copies are covered
// by the edge suite, which is where the bytes actually come from.
describe("sibling share-image templates", () => {
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

});

describe("US-2619: every in-Function OG endpoint buffers before responding", () => {
  // The fix, asserted at the call sites rather than only in the helper.
  //
  // ImageResponse streams: the raster runs as the body is consumed, AFTER the
  // Response has been constructed and returned. So `return new ImageResponse(…)`
  // inside a try/catch is a try/catch that cannot see its own failure — which is
  // how /og/social/card and /og/blog served 200 with zero bytes while their
  // branded fallback sat there unused.
  const OG_DIR = join(process.cwd(), "functions/og");

  function ogEntrypoints(dir: string): string[] {
    const out: string[] = [];
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) out.push(...ogEntrypoints(p));
      else if (e.name.endsWith(".ts")) out.push(p);
    }
    return out;
  }

  it("no endpoint returns an ImageResponse directly", () => {
    const offenders: string[] = [];
    for (const file of ogEntrypoints(OG_DIR)) {
      const src = readFileSync(file, "utf8");
      if (!src.includes("ImageResponse")) continue;
      // `return new ImageResponse(` — the shape that streams past the catch.
      if (/return\s+new\s+ImageResponse\s*\(/.test(src)) {
        offenders.push(file.replace(process.cwd(), "").split(sep).join("/"));
      }
    }
    expect(
      offenders,
      "these return a streaming ImageResponse, so a raster failure escapes their " +
        "own try/catch and the client gets a 200 with an empty body. Wrap with " +
        "renderOgImage().",
    ).toEqual([]);
  });

  it("renderOgImage treats zero bytes as a failure", () => {
    // The observed symptom was silence, not an exception. Whatever the root
    // cause turns out to be, an empty buffer must never leave as a success.
    const helper = readFileSync(
      join(process.cwd(), "functions/_shared/og-template.ts"),
      "utf8",
    );
    expect(helper).toContain("export async function renderOgImage");
    expect(helper).toMatch(/byteLength === 0/);
    expect(helper).toMatch(/throw new Error\("og render produced 0 bytes"\)/);
  });
});

describe("US-2619: the font-weight theory is disproven, not merely untested", () => {
  // A previous pass restricted weights to {500,600,800} and asserted it here,
  // on the correlation that the one template rendering in a Pages Function was
  // the only one without a 700.
  //
  // The deployed bundle now carries a commit AFTER that change and the cards
  // still fall back, so the restriction had no basis and the weights are
  // restored. This case replaces the guard: it exists to stop the same
  // correlation being rediscovered and re-implemented.
  const src = readFileSync(
    join(process.cwd(), "functions/_shared/og-template.ts"),
    "utf8",
  );

  it("records that 700 was ruled out, so nobody re-derives it", () => {
    expect(src).toMatch(/700 is NOT the problem/);
    expect(src).toMatch(/THAT THEORY IS DISPROVEN/);
    // And the eliminations stay listed, because the value of this investigation
    // is mostly in what it has already excluded.
    expect(src).toMatch(/ELIMINATED SO FAR/);
  });
});
