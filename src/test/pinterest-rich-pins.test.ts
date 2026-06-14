import { describe, it, expect } from "vitest";
import {
  renderArticleMetaTags,
  buildPinImageUrl,
  renderPinterestSave,
} from "../../functions/_shared/blog-render";

// US-872: Pinterest rich pins + vertical pin pipeline. The blog SSR emits
// article:* OG tags (so a pinned post validates as an Article rich pin), builds
// a vertical 1000x1500 pin card via the US-871 card endpoint, and exposes an
// on-page "Save to Pinterest" affordance carrying the pin media + a keyword-rich
// description + the destination URL.

describe("renderArticleMetaTags (US-872)", () => {
  it("emits published_time, modified_time, author, section and tags", () => {
    const html = renderArticleMetaTags({
      publishedTime: "2026-05-01T00:00:00Z",
      modifiedTime: "2026-05-09T12:00:00Z",
      author: "Jane Doe",
      section: "grading",
      tags: ["denim", "patagonia"],
    });
    expect(html).toContain(
      '<meta property="article:published_time" content="2026-05-01T00:00:00Z">',
    );
    expect(html).toContain(
      '<meta property="article:modified_time" content="2026-05-09T12:00:00Z">',
    );
    expect(html).toContain('<meta property="article:author" content="Jane Doe">');
    expect(html).toContain('<meta property="article:section" content="grading">');
    expect(html).toContain('<meta property="article:tag" content="denim">');
    expect(html).toContain('<meta property="article:tag" content="patagonia">');
  });

  it("returns nothing when meta is absent and skips empty fields", () => {
    expect(renderArticleMetaTags(undefined)).toBe("");
    const html = renderArticleMetaTags({
      publishedTime: "2026-05-01",
      author: "   ",
      section: null,
      tags: ["", "  ", "real"],
    });
    expect(html).toContain("article:published_time");
    expect(html).not.toContain("article:author");
    expect(html).not.toContain("article:section");
    // Only the non-blank tag survives.
    expect(html.match(/article:tag/g)?.length).toBe(1);
    expect(html).toContain('content="real"');
  });

  it("escapes attacker-controlled author/section/tag values", () => {
    const html = renderArticleMetaTags({
      author: '"><script>x</script>',
      tags: ['"evil"'],
    });
    expect(html).not.toContain("<script>");
    expect(html).toContain("&quot;&gt;&lt;script&gt;");
    expect(html).toContain("&quot;evil&quot;");
  });
});

describe("buildPinImageUrl (US-872)", () => {
  it("builds a ratio=pin card URL at the US-871 endpoint", () => {
    const url = buildPinImageUrl("https://gradethread.com", {
      title: "How to grade used denim",
      product: "flipdesk",
      eyebrow: "grading guide",
    });
    const parsed = new URL(url);
    expect(parsed.pathname).toBe("/og/social/card");
    expect(parsed.searchParams.get("ratio")).toBe("pin"); // 1000x1500 vertical
    expect(parsed.searchParams.get("kind")).toBe("title");
    expect(parsed.searchParams.get("text")).toBe("How to grade used denim");
    expect(parsed.searchParams.get("product")).toBe("flipdesk");
    expect(parsed.searchParams.get("eyebrow")).toBe("grading guide");
  });

  it("defaults product to gradethread, trims a trailing slash, omits blank eyebrow", () => {
    const url = buildPinImageUrl("https://gradethread.com/", {
      title: "Title",
      eyebrow: "   ",
    });
    expect(url.startsWith("https://gradethread.com/og/social/card?")).toBe(true);
    const parsed = new URL(url);
    expect(parsed.searchParams.get("product")).toBe("gradethread");
    expect(parsed.searchParams.has("eyebrow")).toBe(false);
  });
});

describe("renderPinterestSave (US-872)", () => {
  it("builds a pin-create link with destination URL, media and description", () => {
    const html = renderPinterestSave({
      pinUrl:
        "https://gradethread.com/blog/denim?utm_source=pinterest&utm_medium=social&utm_campaign=denim",
      media: "https://gradethread.com/og/social/card?ratio=pin",
      description: "Keyword-rich pin description for resellers.",
    });
    // Dedicated pin link to Pinterest's create endpoint.
    expect(html).toContain("https://www.pinterest.com/pin/create/button/?");
    // data-pin-* attributes the Save button / extension read.
    expect(html).toContain(
      'data-pin-url="https://gradethread.com/blog/denim?utm_source=pinterest&amp;utm_medium=social&amp;utm_campaign=denim"',
    );
    expect(html).toContain(
      'data-pin-media="https://gradethread.com/og/social/card?ratio=pin"',
    );
    expect(html).toContain(
      'data-pin-description="Keyword-rich pin description for resellers."',
    );
    expect(html).toContain("Save to Pinterest");
    // The destination + media are also encoded into the pin-create href.
    const href = html.match(/href="([^"]+)"/)?.[1] ?? "";
    const parsed = new URL(href.replace(/&amp;/g, "&"));
    expect(parsed.searchParams.get("url")).toContain("/blog/denim");
    expect(parsed.searchParams.get("media")).toContain("ratio=pin");
  });

  it("caps the pin description at Pinterest's 500-char limit", () => {
    const html = renderPinterestSave({
      pinUrl: "https://gradethread.com/blog/x",
      media: "https://gradethread.com/og/social/card?ratio=pin",
      description: "a".repeat(600),
    });
    const desc = html.match(/data-pin-description="([^"]*)"/)?.[1] ?? "";
    expect(desc.length).toBe(500);
  });
});
