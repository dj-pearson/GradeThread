import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { HELP_CATEGORIES, helpCategoryPath } from "../types/help-center";

// US-2582: the Help Center's place in the internal-link graph.
//
// 213 marketing routes already rank. A help center nothing links to is an
// orphan no matter how good the writing is, and every one of these links is the
// kind that gets removed in a refactor without anybody noticing, because
// nothing breaks when it goes.

const root = process.cwd();
const read = (p: string) => readFileSync(join(root, p), "utf8");

describe("HELP_CATEGORIES matches the migration seed", () => {
  // The constant exists so PRERENDERED surfaces (the human HTML sitemap) can
  // link every shelf in crawlable markup, which a client-side fetch cannot do.
  // That only works while it agrees with the database.
  const sql = read("supabase/migrations/00602_help_center_articles.sql");
  const seedBlock = sql.slice(
    sql.indexOf("insert into public.help_categories"),
    sql.indexOf("on conflict (key)"),
  );
  const seeded = [...seedBlock.matchAll(/^\s*\('([a-z-]+)',\s*'([^']+)',\s*'([a-z-]+)'/gm)].map(
    (m) => ({ key: m[1]!, title: m[2]!, slug: m[3]! }),
  );

  it("parsed the seed at all", () => {
    expect(seeded.length).toBeGreaterThan(0);
  });

  it("has exactly the same keys, in the same order", () => {
    expect(HELP_CATEGORIES.map((c) => c.key)).toEqual(seeded.map((c) => c.key));
  });

  it("has the same slugs, so no link points at a shelf that is not there", () => {
    expect(HELP_CATEGORIES.map((c) => c.slug)).toEqual(seeded.map((c) => c.slug));
  });

  it("has the same titles", () => {
    expect(HELP_CATEGORIES.map((c) => c.title)).toEqual(seeded.map((c) => c.title));
  });
});

describe("the footers link help", () => {
  it("the marketing footer, on every public page", () => {
    expect(read("src/components/marketing/marketing-layout.tsx")).toContain(
      '<FooterLink to="/help">',
    );
  });

  it("the SSR footer, which is the one a crawler sees on blog and cert pages", () => {
    expect(read("functions/_shared/blog-render.ts")).toContain('<a href="/help">Help</a>');
  });
});

describe("the in-app help menu", () => {
  it('"Help center" goes to /help, not /faq', () => {
    // It pointed at /faq since before one existed. That was fine then and is a
    // wrong door now: /faq is 20 short answers, /help is the manual.
    const src = read("src/components/dashboard/support-launcher.tsx");
    // The menu item whose LABEL is "Help center", not just some item nearby.
    const item = src
      .split("<DropdownMenuItem")
      .find((chunk) => chunk.includes("Help center") && chunk.includes("navigate("));
    expect(item, "no menu item labelled 'Help center'").toBeDefined();
    expect(item).toContain('navigate("/help")');
    expect(item).not.toContain('navigate("/faq")');
  });

  it("still offers the FAQ, under its own name", () => {
    expect(read("src/components/dashboard/support-launcher.tsx")).toContain(
      "Common questions",
    );
  });
});

describe("the human HTML sitemap", () => {
  const src = read("src/pages/marketing/sitemap.tsx");

  it("hand-links the hub, because /help is not in PUBLIC_ROUTES", () => {
    expect(src).toContain('{ path: "/help", title: "Help Center" }');
  });

  it("links every shelf, derived from HELP_CATEGORIES rather than hand-typed", () => {
    expect(src).toContain("HELP_CATEGORIES.map");
    expect(src).toContain("helpCategoryPath(c.slug)");
  });

  it("gives Help its own section in the render order", () => {
    expect(src).toContain('"Help", "Content"');
  });
});

describe("the marketing pages send readers to the right shelf", () => {
  const EXPECTED: Array<[string, string]> = [
    ["src/pages/marketing/how-it-works.tsx", "grading"],
    ["src/pages/marketing/pricing.tsx", "billing"],
    ["src/pages/marketing/developers.tsx", "integrations"],
    ["src/pages/marketing/flipdesk.tsx", "flipdesk"],
    ["src/pages/marketing/flipdesk-landing.tsx", "flipdesk"],
    ["src/pages/marketing/faq.tsx", "getting-started"],
  ];

  it.each(EXPECTED)("%s links to the %s shelf", (file, category) => {
    const src = read(file);
    expect(src).toContain("HelpCategoryLink");
    expect(src).toContain(`category="${category}"`);
  });

  it("every category named by a marketing page actually exists", () => {
    // A typo'd key would render nothing at all (the component guards), which is
    // a link silently missing rather than a link visibly broken.
    const keys = new Set(HELP_CATEGORIES.map((c) => c.key));
    for (const [file] of EXPECTED) {
      for (const m of read(file).matchAll(/category="([a-z-]+)"/g)) {
        expect(keys.has(m[1]!)).toBe(true);
      }
    }
  });
});

describe("the links run both ways", () => {
  it("an article renders its pillar uplink", () => {
    // The article names its pillar and the pillar names the shelf. One
    // direction only means half the graph benefits.
    expect(read("functions/help/[[path]].ts")).toContain(
      "renderPillarLink(article.pillar_path",
    );
  });

  it("glossary terms in a help body link to their /grading/ spoke", () => {
    const src = read("functions/help/[[path]].ts");
    expect(src).toContain("linkGlossaryTerms(article.body_html)");
    // Before the TOC pass, so an anchor id is never derived from inserted markup.
    expect(src.indexOf("linkGlossaryTerms(")).toBeLessThan(
      src.indexOf("buildTableOfContents(linkedBody)"),
    );
  });
});

describe("category paths", () => {
  it("every seeded shelf produces a well-formed path", () => {
    for (const c of HELP_CATEGORIES) {
      expect(helpCategoryPath(c.slug)).toBe(`/help/${c.slug}`);
      expect(c.slug).toMatch(/^[a-z0-9-]+$/);
    }
  });
});
