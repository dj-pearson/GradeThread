import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  countHelpArticleView,
  HELP_CONTENT_GROUP,
  helpArticleSlugForCount,
  isCountableView,
} from "../../functions/_shared/help-analytics";
import { ANALYTICS_EVENTS } from "@/lib/analytics-events";

// US-2592. Two numbers decide whether the Help Center epic paid for itself: the
// organic traffic it earns and the tickets it prevents. These tests hold the
// instrumentation that produces them, and in particular the three ways it would
// silently produce the WRONG number instead of no number:
//
//   1. Counting the public page from React, where React never runs.
//   2. Counting crawlers as readers.
//   3. Counting the same read twice, once at the edge and once in the SPA.

const ROOT = join(__dirname, "..", "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

/**
 * Strip comments before scanning, so prose describing a rule is not the rule.
 *
 * LINE comments first, then block comments, and that order is load-bearing. The
 * help Function's header contains the literal `/help/*` inside a `//` comment;
 * running the block-comment pattern first treats that as an opening delimiter
 * and eats the next hundred lines of real code, which made this very test pass
 * an empty string to `toContain`.
 */
function stripComments(src: string): string {
  return src.replace(/^\s*\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
}

describe("what counts as a view", () => {
  it("counts an ordinary browser", () => {
    expect(
      isCountableView(
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
          "(KHTML, like Gecko) Chrome/120.0 Safari/537.36",
      ),
    ).toBe(true);
    expect(isCountableView("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)")).toBe(true);
  });

  it("does not count crawlers, previewers or scripts", () => {
    for (
      const ua of [
        "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
        "Mozilla/5.0 (compatible; bingbot/2.0)",
        "GPTBot/1.0",
        "ClaudeBot/1.0",
        "PerplexityBot/1.0",
        "facebookexternalhit/1.1",
        "Slackbot-LinkExpanding 1.0",
        "curl/8.4.0",
        "python-requests/2.31.0",
        "Mozilla/5.0 HeadlessChrome/120.0",
        "Chrome-Lighthouse",
      ]
    ) {
      expect(isCountableView(ua), ua).toBe(false);
    }
  });

  it("treats a missing user agent as a script, not as a person", () => {
    // Every real browser sends one. Counting the unknown as human is how a
    // views table becomes a table of whatever ran that week.
    expect(isCountableView(null)).toBe(false);
    expect(isCountableView("")).toBe(false);
    expect(isCountableView("   ")).toBe(false);
  });

  it("refuses to count anything that is not a plain slug", () => {
    const env = { EDGE_API_URL: "https://example.invalid" } as never;
    const ua = "Mozilla/5.0 (Windows NT 10.0; Win64; x64)";
    expect(countHelpArticleView(env, "../admin", ua)).toBeNull();
    expect(countHelpArticleView(env, "a".repeat(200), ua)).toBeNull();
    expect(countHelpArticleView(env, "", ua)).toBeNull();
    // And a bot is refused even with a valid slug.
    expect(countHelpArticleView(env, "the-photos-we-need", "Googlebot/2.1")).toBeNull();
  });
});

describe("which URLs are article reads", () => {
  it("counts an article page", () => {
    expect(helpArticleSlugForCount("/help/grading/the-photos-we-need"))
      .toBe("the-photos-we-need");
    expect(helpArticleSlugForCount("/help/grading/the-photos-we-need/"))
      .toBe("the-photos-we-need");
  });

  it("does not count the hub, a category, or search", () => {
    expect(helpArticleSlugForCount("/help")).toBeNull();
    expect(helpArticleSlugForCount("/help/grading")).toBeNull();
    expect(helpArticleSlugForCount("/help/search")).toBeNull();
  });

  it("does not count the Markdown mirror", () => {
    // It exists for answer engines to ingest whole. Counting it would put the
    // articles a crawler happened to fetch at the top of a list of what people
    // read.
    expect(helpArticleSlugForCount("/help/grading/the-photos-we-need.md")).toBeNull();
  });
});

describe("the count happens where the page is actually rendered", () => {
  const fn = read("functions/help/[[path]].ts");

  it("counts in onRequestGet, not inside the renderer", () => {
    // withEdgeCache can return a stored response without the renderer running.
    // A counter inside renderArticle would miss every cache hit, which means
    // under-reporting exactly the articles popular enough to stay cached.
    const body = stripComments(fn);
    const onRequestGet = body.slice(body.indexOf("export const onRequestGet"));
    const head = onRequestGet.slice(0, onRequestGet.indexOf("async function routeHelp"));
    expect(head).toContain("countHelpView(context)");
  });

  it("sends it through waitUntil so it cannot delay the response", () => {
    expect(stripComments(fn)).toContain("context.waitUntil(pending)");
  });

  it("tags every help page with its own GA4 content group", () => {
    // AC4: help URLs separable from the blog and the marketing pages. The
    // Search Console half is sitemap-help.xml, which is already its own file.
    const configured = stripComments(fn).match(/contentGroup: HELP_CONTENT_GROUP/g) ?? [];
    const gaCalls = stripComments(fn).match(/gaMeasurementId: ga4MeasurementId\(env\)/g) ?? [];
    expect(gaCalls.length).toBeGreaterThan(0);
    expect(configured.length).toBe(gaCalls.length);
    expect(HELP_CONTENT_GROUP).toBe("help");
  });
});

describe("the SPA does not double-count what the edge already counted", () => {
  it("the public SPA article page fires PostHog and no server counter", () => {
    const src = stripComments(read("src/pages/help/article.tsx"));
    expect(src).toContain('track("help_article_view"');
    // A full page load of this URL is answered by the Pages Function, which
    // counts it there. Counting again on hydration would double every visit.
    expect(src).not.toContain("recordHelpArticleRead");
  });

  it("the in-app reader records under its own surface", () => {
    const src = stripComments(read("src/pages/help-reader.tsx"));
    expect(src).toContain("recordHelpArticleRead(article.slug)");
    expect(src).toContain('surface: "app"');
  });

  it("the reader guards against a cached result counting twice", () => {
    // TanStack serves a cached article instantly on a back-navigation. Without
    // the ref guard the number measures navigation, not reading.
    const src = stripComments(read("src/pages/help-reader.tsx"));
    expect(src).toContain("countedRef");
  });
});

describe("the event registry", () => {
  const NAMES = [
    "help_article_view",
    "help_search",
    "help_search_zero_results",
    "help_feedback_vote",
    "help_deflection",
    "help_contextual_open",
  ] as const;

  it("declares every help event", () => {
    for (const name of NAMES) {
      expect(Object.keys(ANALYTICS_EVENTS)).toContain(name);
    }
  });

  it("says out loud that these events cannot see the public pages", () => {
    // The single most misreadable thing about this data. A "top articles" chart
    // built from help_article_view is a chart of in-app reading.
    const src = read("src/lib/analytics-events.ts");
    expect(src).toMatch(/server-rendered|posthog-js is not there/i);
  });

  it("fires each one from a real call site", () => {
    const sources = [
      "src/pages/help/article.tsx",
      "src/pages/help/search.tsx",
      "src/pages/help-reader.tsx",
      "src/components/help/help-link.tsx",
      "src/components/help/ticket-deflector.tsx",
    ].map((p) => stripComments(read(p))).join("\n");
    for (const name of NAMES) {
      expect(sources, name).toContain(`"${name}"`);
    }
  });
});

describe("the report endpoint", () => {
  const route = read("services/edge-functions/src/routes/help-center.ts");

  it("is registered before the /:id catch-all", () => {
    const body = stripComments(route);
    expect(body.indexOf('helpAdminRoutes.get("/report"'))
      .toBeLessThan(body.indexOf('helpAdminRoutes.get("/:id"'));
  });

  it("is on the admin mount only", () => {
    const body = stripComments(route);
    expect(body).not.toContain('helpPublicRoutes.get("/report"');
    expect(body).not.toContain('helpReaderRoutes.get("/report"');
  });
});

describe("the migration", () => {
  const sql = read("supabase/migrations/00606_help_analytics.sql");

  it("records no identity of any kind", () => {
    // The grain is (article, surface, day). Nothing here is joinable to a
    // person, which is what lets it be written from an anonymous public page
    // with no consent prompt.
    const createBlock = sql.slice(
      sql.indexOf("create table if not exists public.help_article_views"),
      sql.indexOf("create index if not exists idx_help_article_views_day"),
    );
    expect(createBlock).not.toMatch(/user_id|session|ip_address|referrer/);
  });

  it("enables RLS on the counter table", () => {
    expect(sql).toContain("alter table public.help_article_views enable row level security");
  });

  it("requires the article to exist before it counts a view", () => {
    // Otherwise the public counter endpoint is a way to fill the table with
    // invented slugs and the top-articles list stops being a list of articles.
    expect(sql).toContain("where exists (");
    expect(sql).toMatch(/from public\.help_articles a\s+where a\.slug = v_slug/);
  });

  it("self-records under US-1108", () => {
    expect(sql.trimEnd().endsWith(
      "insert into public.applied_migrations (version) values ('00606') on conflict do nothing;",
    )).toBe(true);
  });
});
