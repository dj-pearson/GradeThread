import { describe, it, expect } from "vitest";
import {
  htmlToMarkdown,
  buildPostMarkdown,
  decodeEntities,
} from "../../functions/_shared/html-to-markdown";
import {
  buildLlmsSections,
  buildLlmsTxt,
  LLMS_SUMMARY,
} from "../../functions/_shared/seo-config";
import type { PublicPost } from "../../functions/_shared/blog-render";

// US-877: clean per-post Markdown for AI answer engines + a Recent Articles
// section in llms.txt. These pure helpers power the /blog/:slug.md endpoint and
// the llms.txt articles list.

describe("decodeEntities (US-877)", () => {
  it("decodes named, numeric, and hex references", () => {
    expect(decodeEntities("Tom &amp; Jerry")).toBe("Tom & Jerry");
    expect(decodeEntities("&lt;tag&gt;")).toBe("<tag>");
    expect(decodeEntities("&#39;quote&#39;")).toBe("'quote'");
    expect(decodeEntities("&#x2014;")).toBe("—");
    expect(decodeEntities("a&nbsp;b")).toBe("a b");
  });
  it("leaves unknown entities intact", () => {
    expect(decodeEntities("&notathing;")).toBe("&notathing;");
  });
});

describe("htmlToMarkdown (US-877)", () => {
  it("converts headings and paragraphs", () => {
    const md = htmlToMarkdown("<h2>Title</h2><p>Hello world.</p>");
    expect(md).toBe("## Title\n\nHello world.");
  });

  it("converts bold, italic, code and links inline", () => {
    const md = htmlToMarkdown(
      '<p>A <strong>bold</strong> and <em>italic</em> and <code>x=1</code> and <a href="/foo">link</a>.</p>',
    );
    expect(md).toBe("A **bold** and *italic* and `x=1` and [link](/foo).");
  });

  it("converts unordered and ordered lists with nesting", () => {
    const md = htmlToMarkdown(
      "<ul><li>one</li><li>two<ul><li>nested</li></ul></li></ul>",
    );
    expect(md).toContain("- one");
    expect(md).toContain("- two");
    expect(md).toContain("  - nested");

    const ol = htmlToMarkdown("<ol><li>first</li><li>second</li></ol>");
    expect(ol).toBe("1. first\n2. second");
  });

  it("converts blockquotes and horizontal rules", () => {
    expect(htmlToMarkdown("<blockquote><p>quoted</p></blockquote>")).toBe("> quoted");
    expect(htmlToMarkdown("<p>a</p><hr><p>b</p>")).toBe("a\n\n---\n\nb");
  });

  it("converts a table to GFM with a header separator", () => {
    const md = htmlToMarkdown(
      "<table><thead><tr><th>Grade</th><th>Tier</th></tr></thead><tbody><tr><td>10</td><td>NWT</td></tr></tbody></table>",
    );
    expect(md).toBe(
      ["| Grade | Tier |", "| --- | --- |", "| 10 | NWT |"].join("\n"),
    );
  });

  it("converts images and figure captions", () => {
    const md = htmlToMarkdown(
      '<figure><img src="/a.jpg" alt="A jacket"><figcaption>Vintage denim</figcaption></figure>',
    );
    expect(md).toContain("![A jacket](/a.jpg)");
    expect(md).toContain("*Vintage denim*");
  });

  it("strips unknown/inline-only tags but keeps their text", () => {
    expect(htmlToMarkdown("<p>plain <u>under</u> <span>span</span></p>")).toBe(
      "plain under span",
    );
  });

  it("returns empty for empty input", () => {
    expect(htmlToMarkdown("")).toBe("");
    expect(htmlToMarkdown("   ")).toBe("");
  });
});

const BASE_POST: PublicPost = {
  id: "1",
  slug: "grading-denim",
  title: "How to Grade Denim",
  excerpt: "A practical walkthrough.",
  product_focus: "gradethread",
  hero_image_url: null,
  primary_keyword: "denim grading",
  reading_time_min: 5,
  published_at: "2026-05-01T00:00:00Z",
  updated_at: "2026-05-10T00:00:00Z",
  body_html: "<h2>Step one</h2><p>Inspect the <strong>seams</strong>.</p>",
  seo_title: null,
  seo_description: null,
  secondary_keywords: [],
  jsonld: null,
  tags: [],
  author: "Jane Expert",
  key_takeaways: ["Check seams", "Look for fading"],
  faqs: [{ q: "Does washing affect grade?", a: "Yes, fading lowers it." }],
};

describe("buildPostMarkdown (US-877)", () => {
  const md = buildPostMarkdown(BASE_POST, "https://gradethread.com");

  it("starts with an H1 title and a byline", () => {
    expect(md.startsWith("# How to Grade Denim")).toBe(true);
    expect(md).toContain("By Jane Expert");
  });

  it("shows published and (differing) updated dates", () => {
    expect(md).toContain("Published May 1, 2026");
    expect(md).toContain("Updated May 10, 2026");
  });

  it("includes key takeaways, body, and FAQs", () => {
    expect(md).toContain("## Key takeaways");
    expect(md).toContain("- Check seams");
    expect(md).toContain("## Step one");
    expect(md).toContain("Inspect the **seams**.");
    expect(md).toContain("## Frequently asked questions");
    expect(md).toContain("### Does washing affect grade?");
  });

  it("ends with a canonical link back to the HTML article", () => {
    expect(md).toContain(
      "Canonical: [https://gradethread.com/blog/grading-denim](https://gradethread.com/blog/grading-denim)",
    );
  });

  it("prefers the author entity name when present", () => {
    const withEntity = buildPostMarkdown(
      {
        ...BASE_POST,
        author_entity: { slug: "amir", name: "Amir Vance", title: null, avatar_url: null },
      },
      "https://gradethread.com",
    );
    expect(withEntity).toContain("By Amir Vance");
  });

  it("omits the Updated line when the post was not changed after publish", () => {
    const sameDay = buildPostMarkdown(
      { ...BASE_POST, updated_at: BASE_POST.published_at },
      "https://gradethread.com",
    );
    expect(sameDay).not.toContain("Updated ");
  });
});

describe("llms.txt Recent Articles section (US-877)", () => {
  it("renders recent articles with a summary and a Markdown hint", () => {
    const sections = buildLlmsSections({
      routes: [],
      articleUrls: [
        { title: "How to Grade Denim", url: "/blog/grading-denim", note: "A practical walkthrough." },
      ],
    });
    const body = buildLlmsTxt({
      siteUrl: "https://gradethread.com",
      summary: LLMS_SUMMARY,
      sections,
    });
    expect(body).toContain("## Recent Articles");
    expect(body).toContain("https://gradethread.com/blog/grading-denim)");
    expect(body).toContain("A practical walkthrough.");
    expect(body).toContain("Markdown: /blog/grading-denim.md");
  });

  it("omits the section entirely when there are no articles", () => {
    const sections = buildLlmsSections({ routes: [] });
    const body = buildLlmsTxt({
      siteUrl: "https://gradethread.com",
      summary: LLMS_SUMMARY,
      sections,
    });
    expect(body).not.toContain("## Recent Articles");
  });
});
