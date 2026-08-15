import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  articlesInCategory,
  buildHelpIndexMarkdown,
  buildHelpMarkdown,
  canonicalArticleUrl,
  helpArticlePath,
  helpCategoryPath,
  nonEmptyCategories,
  pillarLabel,
  renderArticleList,
  renderCategoryGrid,
  renderRelatedHelp,
  renderReviewedLine,
  toBlogFaqs,
  type HelpArticlePayload,
  type HelpCategoryPayload,
  type HelpIndexPayload,
  type HelpListItemPayload,
} from "../../functions/_shared/help-render";

// US-2575: the public Help Center SSR.
//
// The helpers are pure so they can be pinned here rather than only in a
// deployed environment. The two guards at the bottom cover the failure modes
// that are invisible in code review: a Pages Function that never runs because
// _routes.json does not list its path, and a public renderer that reaches for a
// non-public upstream.

const root = process.cwd();

function cat(over: Partial<HelpCategoryPayload> = {}): HelpCategoryPayload {
  return {
    key: "getting-started",
    title: "Getting started",
    slug: "getting-started",
    summary: "Create an account and run your first grade.",
    sort_order: 10,
    icon: null,
    ...over,
  };
}

function item(over: Partial<HelpListItemPayload> = {}): HelpListItemPayload {
  return {
    slug: "your-first-grade",
    title: "Your first grade",
    summary: "Upload four photos and read the report.",
    category_key: "getting-started",
    audience: "all",
    visibility: "public",
    sort_order: 10,
    updated_at: "2026-08-01T00:00:00.000Z",
    reviewed_at: null,
    ...over,
  };
}

function article(over: Partial<HelpArticlePayload> = {}): HelpArticlePayload {
  return {
    ...item(),
    body_html: "<h2>Step one</h2><p>Shoot the front.</p>",
    body_markdown: "## Step one\n\nShoot the front.",
    hero_image_url: null,
    faq: [],
    related_slugs: [],
    video_url: null,
    pillar_path: null,
    published_at: "2026-08-01T00:00:00.000Z",
    ...over,
  };
}

function index(over: Partial<HelpIndexPayload> = {}): HelpIndexPayload {
  return { categories: [cat()], articles: [item()], ...over };
}

describe("help URLs", () => {
  it("builds hub, category and article paths", () => {
    expect(helpCategoryPath("grading")).toBe("/help/grading");
    expect(helpArticlePath("grading", "the-scale")).toBe("/help/grading/the-scale");
  });

  it("canonicalises an article to its CURRENT category, not the requested one", () => {
    // An article re-filed into another shelf keeps its slug, so the old path
    // still resolves. The canonical must follow the article, or the same body
    // ranks at two addresses and splits its own authority.
    const url = canonicalArticleUrl(
      "https://gradethread.com/",
      cat({ slug: "grading" }),
      { slug: "the-scale", category_key: "grading" },
    );
    expect(url).toBe("https://gradethread.com/help/grading/the-scale");
  });

  it("falls back to the category KEY when the category row is missing", () => {
    const url = canonicalArticleUrl("https://gradethread.com", null, {
      slug: "the-scale",
      category_key: "grading",
    });
    expect(url).toBe("https://gradethread.com/help/grading/the-scale");
  });
});

describe("shelves", () => {
  it("orders articles by sort_order then title", () => {
    const idx = index({
      articles: [
        item({ slug: "c", title: "C", sort_order: 20 }),
        item({ slug: "b", title: "B", sort_order: 10 }),
        item({ slug: "a", title: "A", sort_order: 10 }),
      ],
    });
    expect(articlesInCategory(idx, "getting-started").map((a) => a.slug)).toEqual([
      "a",
      "b",
      "c",
    ]);
  });

  it("hides empty categories from the hub", () => {
    // A shelf with nothing on it is a thin page, and a thin page in the sitemap
    // is a page Google decides the whole section is like.
    const idx = index({
      categories: [cat(), cat({ key: "billing", title: "Billing", slug: "billing", sort_order: 20 })],
    });
    expect(nonEmptyCategories(idx).map((c) => c.key)).toEqual(["getting-started"]);
  });

  it("trusts an explicit article_count over counting the index", () => {
    const idx = index({
      categories: [cat({ key: "billing", slug: "billing", article_count: 3 })],
      articles: [],
    });
    expect(nonEmptyCategories(idx)).toHaveLength(1);
  });
});

describe("rendered blocks", () => {
  it("the hub grid links every non-empty category", () => {
    const html = renderCategoryGrid(index());
    expect(html).toContain('href="/help/getting-started"');
    expect(html).toContain("Getting started");
    expect(html).toContain("1 article");
  });

  it("pluralises the article count", () => {
    const idx = index({ articles: [item({ slug: "a" }), item({ slug: "b" })] });
    expect(renderCategoryGrid(idx)).toContain("2 articles");
  });

  it("an empty shelf says so rather than rendering nothing", () => {
    expect(renderArticleList("grading", [])).toContain("Nothing on this shelf yet");
  });

  it("escapes titles and summaries into the list", () => {
    const html = renderArticleList("grading", [
      item({ title: "<script>x</script>", summary: "a & b" }),
    ]);
    expect(html).not.toContain("<script>x</script>");
    expect(html).toContain("&amp;");
  });

  it("related links resolve through the index to real URLs", () => {
    const idx = index({
      categories: [cat(), cat({ key: "grading", title: "Grading", slug: "grading" })],
      articles: [item(), item({ slug: "the-scale", title: "The scale", category_key: "grading" })],
    });
    const html = renderRelatedHelp(idx, ["the-scale"]);
    expect(html).toContain('href="/help/grading/the-scale"');
  });

  it("a related slug that does not exist is dropped, not rendered broken", () => {
    expect(renderRelatedHelp(index(), ["ghost"])).toBe("");
  });

  it("shows Last reviewed when reviewed, Published when never reviewed", () => {
    expect(
      renderReviewedLine({
        reviewed_at: "2026-08-10T00:00:00.000Z",
        published_at: "2026-01-01T00:00:00.000Z",
        updated_at: "2026-08-10T00:00:00.000Z",
      }),
    ).toContain("Last reviewed");
    expect(
      renderReviewedLine({
        reviewed_at: null,
        published_at: "2026-01-01T00:00:00.000Z",
        updated_at: "2026-08-10T00:00:00.000Z",
      }),
    ).toContain("Published");
  });

  it("maps the help FAQ shape onto the blog renderer's, dropping half-pairs", () => {
    expect(
      toBlogFaqs([
        { question: "Why?", answer: "Because." },
        { question: " ", answer: "orphan" },
        { question: "orphan", answer: "" },
      ]),
    ).toEqual([{ q: "Why?", a: "Because." }]);
  });

  it("derives a readable pillar label from the path", () => {
    expect(pillarLabel("/condition-grading")).toBe("Condition Grading");
    expect(pillarLabel("/grading/platform-standards/ebay")).toBe("Ebay");
    expect(pillarLabel(null)).toBe("");
  });
});

describe("the Markdown mirrors", () => {
  it("carries the title, the canonical link and the body", () => {
    const md = buildHelpMarkdown(
      article({ reviewed_at: "2026-08-10T00:00:00.000Z" }),
      cat(),
      "https://gradethread.com",
    );
    expect(md).toContain("# Your first grade");
    expect(md).toContain("Source: https://gradethread.com/help/getting-started/your-first-grade");
    expect(md).toContain("## Step one");
    expect(md).toContain("Last reviewed 2026-08-10");
  });

  it("appends the FAQ so an answer engine gets the same pairs the page shows", () => {
    const md = buildHelpMarkdown(
      article({ faq: [{ question: "Why?", answer: "Because." }] }),
      cat(),
      "https://gradethread.com",
    );
    expect(md).toContain("### Why?");
    expect(md).toContain("Because.");
  });

  it("the index lists every public article under its shelf with a URL", () => {
    const md = buildHelpIndexMarkdown(index(), "https://gradethread.com");
    expect(md).toContain("# Help Center");
    expect(md).toContain("## Getting started");
    expect(md).toContain("https://gradethread.com/help/getting-started/your-first-grade");
  });
});

describe("the two failures that are invisible in review", () => {
  it("_routes.json lists /help, /help/* and /help.md", () => {
    // Without these, Cloudflare Pages serves the SPA shell (or a static 404)
    // and the Function never runs at all. Nothing in the code would look wrong.
    const routes = JSON.parse(
      readFileSync(join(root, "public/_routes.json"), "utf8"),
    ) as { include: string[] };
    expect(routes.include).toContain("/help");
    expect(routes.include).toContain("/help/*");
    expect(routes.include).toContain("/help.md");
  });

  it("the public renderer only ever calls the ANONYMOUS help endpoint", () => {
    // /api/help returns members-only articles and /api/content/help returns
    // internal ones and drafts. Either, reached from here, would publish them.
    for (const file of ["functions/help/[[path]].ts", "functions/help.md.ts"]) {
      const src = readFileSync(join(root, file), "utf8");
      // Every /api/... literal in the file, whatever quoting style it uses.
      const calls = [...src.matchAll(/["'`](\/api\/[^"'`]*)["'`]/g)].map((m) => m[1]!);
      expect(calls.length).toBeGreaterThan(0);
      for (const path of calls) {
        expect(path.startsWith("/api/content/public/help")).toBe(true);
      }
    }
  });
});
