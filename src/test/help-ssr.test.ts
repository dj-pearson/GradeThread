import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
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
  renderHelpSearchForm,
  renderHelpSearchResults,
  renderRelatedHelp,
  renderReviewedLine,
  toBlogFaqs,
  type HelpArticlePayload,
  type HelpCategoryPayload,
  type HelpIndexPayload,
  type HelpListItemPayload,
  HELP_STATIC_OG_PATH,
} from "../../functions/_shared/help-render";
import { buildHelpOgHtml } from "../../functions/_shared/og-template";

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

describe("search (US-2577)", () => {
  it("the box is a plain GET form with no JavaScript in it", () => {
    // The SSR search page has to answer a visitor with scripts off and a
    // crawler that runs none. A box that only works after hydration does not
    // work on the first paint people actually see.
    const html = renderHelpSearchForm();
    expect(html).toContain('action="/help/search"');
    expect(html).toContain('method="get"');
    expect(html).toContain('name="q"');
    expect(html).not.toMatch(/onclick|onsubmit|<script/i);
  });

  it("keeps the current query in the box so a refine starts from it", () => {
    expect(renderHelpSearchForm("ebay fees")).toContain('value="ebay fees"');
  });

  it("escapes the query back into the box", () => {
    expect(renderHelpSearchForm('"><script>x</script>')).not.toContain("<script>x");
  });

  it("results link to the article's real URL via the index", () => {
    const idx = index({
      categories: [cat({ key: "grading", title: "Grading", slug: "grading" })],
      articles: [item({ slug: "the-scale", category_key: "grading" })],
    });
    const html = renderHelpSearchResults(idx, {
      query: "scale",
      hits: [
        {
          slug: "the-scale",
          title: "The scale",
          summary: "1.0 to 10.0",
          category_key: "grading",
          visibility: "public",
          rank: 0.9,
        },
      ],
    });
    expect(html).toContain('href="/help/grading/the-scale"');
    expect(html).toContain("1 result");
  });

  it("an empty result set offers the next two things to try, not a dead end", () => {
    const html = renderHelpSearchResults(index(), { query: "zzz", hits: [] });
    expect(html).toContain("/help");
    expect(html).toContain("/dashboard/support");
  });

  it("escapes the query into the no-results message", () => {
    const html = renderHelpSearchResults(index(), {
      query: "<img src=x onerror=1>",
      hits: [],
    });
    expect(html).not.toContain("<img src=x");
  });

  it("the search page is noindex, FOLLOW, not a bare noindex", () => {
    // Thin, infinite and duplicative, so not something to rank — but its links
    // must still pass equity to the articles it found.
    const src = readFileSync(join(root, "functions/help/[[path]].ts"), "utf8");
    const block = src.slice(src.indexOf("async function renderSearch"));
    expect(block).toContain('robots: "noindex, follow"');
  });

  it("the search page skips the edge cache entirely", () => {
    // withEdgeCache keys on origin + pathname and IGNORES the query string.
    // For every other page that is what stops utm-tagged links fragmenting the
    // cache; for search it would serve one visitor's results to the next
    // visitor's question. Cache-Control alone does not save it — withEdgeCache
    // does not read Cache-Control.
    const src = readFileSync(join(root, "functions/help/[[path]].ts"), "utf8");
    const entry = src.slice(src.indexOf("export const onRequestGet"), src.indexOf("async function routeHelp"));
    expect(entry).toContain('/help/search');
    expect(entry).toMatch(/if\s*\(path === "\/help\/search"\)\s*return routeHelp\(context\)/);
  });
});

describe("the SSR and SPA renderers agree (US-2576)", () => {
  it("the hub title and description are byte-identical on both sides", async () => {
    // Both surfaces answer at /help — the Function for a cold visitor, the SPA
    // after hydration. A title that differs between them is a title Google
    // watches change on every render.
    const spa = await import("../types/help-center");
    const ssr = await import("../../functions/_shared/help-render");
    expect(spa.HELP_HUB_TITLE).toBe(ssr.HELP_HUB_TITLE);
    expect(spa.HELP_HUB_DESCRIPTION).toBe(ssr.HELP_HUB_DESCRIPTION);
  });

  it("both sides mint the same URLs", async () => {
    const spa = await import("../types/help-center");
    const ssr = await import("../../functions/_shared/help-render");
    expect(spa.helpHubPath()).toBe(ssr.helpHubPath());
    expect(spa.helpCategoryPath("grading")).toBe(ssr.helpCategoryPath("grading"));
    expect(spa.helpArticlePath("grading", "the-scale")).toBe(
      ssr.helpArticlePath("grading", "the-scale"),
    );
  });

  it("/help is NOT in PUBLIC_ROUTES, on purpose", async () => {
    // Registering it would prerender a snapshot of the shelf into dist/ that
    // _routes.json never serves (the Function wins) and list /help in the
    // sitemap twice. Same call already made for /finds and /leaderboards.
    const { PUBLIC_ROUTES } = await import("../lib/seo/public-routes");
    expect(PUBLIC_ROUTES.some((r) => r.path === "/help")).toBe(false);
    expect(PUBLIC_ROUTES.some((r) => r.path.startsWith("/help/"))).toBe(false);
  });

  it("the SPA renderer reads the same anonymous endpoint as the Function", () => {
    const src = readFileSync(join(root, "src/hooks/use-help-center.ts"), "utf8");
    const publicBlock = src.slice(src.indexOf("PUBLIC READS"));
    expect(publicBlock).toContain("/api/content/public/help");
    // No auth on the public reads: an access token here would render a
    // members-only article on a page whose URL anyone can open.
    expect(publicBlock).not.toContain("edgeFetch(");
  });
});

describe("answer engines (US-2580)", () => {
  it("the llms.txt Help Center section names each article's Markdown mirror", async () => {
    const { buildLlmsSections } = await import("../../functions/_shared/seo-config");
    const sections = buildLlmsSections({
      routes: [],
      helpUrls: [
        {
          title: "Your first grade",
          url: "/help/getting-started/your-first-grade",
          note: "Upload four photos — Markdown: /help/getting-started/your-first-grade.md",
        },
      ],
    });
    const help = sections.find((s) => s.heading === "Help Center");
    expect(help).toBeDefined();
    // The section itself points at the full-territory document.
    expect(JSON.stringify(help)).toContain("/help.md");
    expect(JSON.stringify(help)).toContain(
      "/help/getting-started/your-first-grade.md",
    );
  });

  it("no Help Center section appears when there are no public articles", async () => {
    const { buildLlmsSections } = await import("../../functions/_shared/seo-config");
    const sections = buildLlmsSections({ routes: [] });
    expect(sections.find((s) => s.heading === "Help Center")).toBeUndefined();
  });

  it("llms.txt reads the ANONYMOUS help endpoint, which is what keeps it public-only", () => {
    const src = readFileSync(join(root, "functions/llms.txt.ts"), "utf8");
    const calls = [...src.matchAll(/["'`]([^"'`]*\/api\/content\/public\/help[^"'`]*)["'`]/g)];
    expect(calls.length).toBeGreaterThan(0);
    expect(src).not.toContain("/api/help");
    expect(src).not.toMatch(/\/api\/content\/help\b/);
  });

  it("llms-full.txt stays a BUILD artifact and pulls in no live help content", () => {
    // Its one guarantee is that it cannot drift from the build. A live fetch
    // that can fail halfway would trade that for convenience, and a half-served
    // standard is a document an engine quotes as though it were complete.
    const src = readFileSync(join(root, "functions/llms-full.txt.ts"), "utf8");
    expect(src).not.toContain("/api/content/public/help");
    expect(src).toContain("/help.md");
  });

  it("/help.md carries full bodies when the payload has them", () => {
    const withBodies: HelpIndexPayload = {
      categories: [cat()],
      articles: [
        { ...item(), body_markdown: "## Step one\n\nShoot the front." } as HelpListItemPayload,
      ],
    };
    const md = buildHelpIndexMarkdown(withBodies, "https://gradethread.com");
    expect(md).toContain("### Your first grade");
    expect(md).toContain("## Step one");
    expect(md).toContain("Source: https://gradethread.com/help/getting-started/your-first-grade");
  });

  it("/help.md degrades to a link list when the payload has no bodies", () => {
    const md = buildHelpIndexMarkdown(index(), "https://gradethread.com");
    expect(md).toContain("- [Your first grade](https://gradethread.com/help/getting-started/your-first-grade)");
    expect(md).not.toContain("### Your first grade");
  });

  it("/help.md announces what it left out instead of truncating silently", () => {
    // A truncated corpus that reads as complete is a corpus an engine will
    // quote as though it were complete.
    const big = "x".repeat(12_000);
    const many = Array.from({ length: 80 }, (_, i) => ({
      ...item({ slug: `a${i}`, title: `Article ${i}`, sort_order: i }),
      body_markdown: big,
    })) as HelpListItemPayload[];
    const md = buildHelpIndexMarkdown(
      { categories: [cat()], articles: many },
      "https://gradethread.com",
    );
    expect(md).toContain("Not included here");
    expect(md).toMatch(/\d+ articles? exceeded this document's size budget/);
  });

  it("/help.md truncates an over-long article with a pointer to the full text", () => {
    const md = buildHelpIndexMarkdown(
      {
        categories: [cat()],
        articles: [
          { ...item(), body_markdown: "y".repeat(20_000) } as HelpListItemPayload,
        ],
      },
      "https://gradethread.com",
    );
    expect(md).toContain("[Article truncated. Full text: https://gradethread.com/help/getting-started/your-first-grade]");
  });

  it("the ?full=1 payload is opt-in, so the hub's own fetch stays small", () => {
    const src = readFileSync(
      join(root, "services/edge-functions/src/routes/help-center.ts"),
      "utf8",
    );
    expect(src).toContain('c.req.query("full") === "1"');
    // help.md is the only caller that asks for it.
    expect(readFileSync(join(root, "functions/help.md.ts"), "utf8")).toContain("?full=1");
    expect(readFileSync(join(root, "functions/help/[[path]].ts"), "utf8")).not.toContain(
      "?full=1",
    );
  });

  it("no AI-provenance disclosure is attached to a help article", () => {
    // ai-disclosure.ts is about how a GRADE was produced (cert page + embed
    // widget). Stamping it on a hand-written help article would be a false
    // claim, in either direction. The blog does not use it either.
    const src = readFileSync(join(root, "functions/help/[[path]].ts"), "utf8");
    expect(src).not.toContain("aiDisclosure");
  });
});

describe("social cards (US-2581)", () => {
  it("the card names the article and its category, never an author", () => {
    // Help articles are not bylined. Inventing a name to fill the slot would be
    // a claim about who wrote it.
    const html = buildHelpOgHtml({
      title: "How to photograph a jacket",
      category: "Grading",
      reviewedAt: "August 10, 2026",
    });
    expect(html).toContain("How to photograph a jacket");
    expect(html).toContain("Grading");
    expect(html).toContain("Last reviewed August 10, 2026");
    expect(html).toContain("1200px");
    expect(html).toContain("630px");
  });

  it("falls back to sane copy when the category or date is missing", () => {
    const html = buildHelpOgHtml({ title: "Untitled", category: null, reviewedAt: null });
    expect(html).toContain("Help");
    expect(html).toContain("GradeThread Help Center");
  });

  it("escapes the title into the card", () => {
    const html = buildHelpOgHtml({
      title: '<script>alert(1)</script>',
      category: null,
      reviewedAt: null,
    });
    expect(html).not.toContain("<script>alert(1)");
  });

  it("the article head points at the DYNAMIC card, not the hero image", () => {
    // A hero is chosen to sit inside an article at whatever ratio suits it.
    // Cropped to 1200x630 it is usually a detail with no title on it, which is
    // a worse preview than a card that states what the page answers.
    const src = readFileSync(join(root, "functions/help/[[path]].ts"), "utf8");
    const block = src.slice(src.indexOf("async function renderArticle("));
    expect(block).toContain("helpArticleOgPath(article.slug)");
    expect(block).not.toContain("ogImage: article.hero_image_url");
  });

  it("hub and category fall back to the static card, at declared dimensions", () => {
    const src = readFileSync(join(root, "functions/help/[[path]].ts"), "utf8");
    const hub = src.slice(src.indexOf("async function renderHub("), src.indexOf("async function renderSearch("));
    expect(hub).toContain("HELP_STATIC_OG_PATH");
    expect(hub).toContain("OG_CARD_WIDTH");
    expect(hub).toContain("OG_CARD_HEIGHT");
  });

  it("the static card actually exists, so the og:image cannot 404", () => {
    expect(existsSync(join(root, "public", HELP_STATIC_OG_PATH))).toBe(true);
  });

  it("the generator knows how to rebuild it", () => {
    const src = readFileSync(join(root, "scripts/generate-og-image.mjs"), "utf8");
    expect(src).toContain("public/social/help.png");
  });

  it("the card renderer reads the ANONYMOUS endpoint", () => {
    // So a members-only or internal article has no card here to leak its title.
    const src = readFileSync(join(root, "functions/og/help/[slug].ts"), "utf8");
    const calls = [...src.matchAll(/["'`](\/api\/[^"'`]*)["'`]/g)].map((m) => m[1]!);
    expect(calls.length).toBeGreaterThan(0);
    for (const p of calls) expect(p.startsWith("/api/content/public/help")).toBe(true);
  });

  it("an unreachable upstream returns 503, never a card claiming the page is gone", () => {
    const src = readFileSync(join(root, "functions/og/help/[slug].ts"), "utf8");
    expect(src).toContain("upstreamUnavailableResponse()");
    expect(src).toContain("brandedFallbackResponse");
  });

  it("/og/* is routed to the Functions, so the card is reachable", () => {
    const routes = JSON.parse(
      readFileSync(join(root, "public/_routes.json"), "utf8"),
    ) as { include: string[] };
    expect(routes.include).toContain("/og/*");
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
