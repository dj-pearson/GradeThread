import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { loadArticles, markdownToHtml, parseArticle } from "../../scripts/seed-help-articles.mjs";
import { HELP_CATEGORIES } from "../types/help-center";
import { PRODUCT_HELP_SLUGS } from "../lib/help-slugs";

// US-2586: the drafted help articles.
//
// These files are the DRAFTING surface; the database is the live surface, and
// scripts/seed-help-articles.mjs is a deliberate one-way import that never
// overwrites. Which means a mistake here ships once and then has to be fixed in
// the editor instead, so the checks are worth having before the import runs.

const root = process.cwd();
const CONTENT_DIR = join(root, "content/help");
const articles = loadArticles(CONTENT_DIR);

const VALID_CATEGORIES = new Set<string>(HELP_CATEGORIES.map((c) => c.key));
const VALID_VISIBILITIES = new Set(["public", "members", "internal"]);

describe("every file parses", () => {
  it("found articles at all", () => {
    expect(articles.length).toBeGreaterThan(0);
  });

  it("every .md file in content/help parsed", () => {
    const files = readdirSync(CONTENT_DIR).filter((f) => f.endsWith(".md"));
    expect(articles).toHaveLength(files.length);
  });

  it("rejects a file with no frontmatter", () => {
    expect(() => parseArticle("just a body\n", "bad.md")).toThrow(/frontmatter/);
  });

  it("rejects a file missing a required field", () => {
    expect(() => parseArticle("---\nslug: x\n---\nbody\n", "bad.md")).toThrow(/missing/);
  });
});

describe("the metadata is usable", () => {
  it("slugs are unique", () => {
    const slugs = articles.map((a) => a.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  it("slugs are URL-shaped", () => {
    for (const a of articles) expect(a.slug, a.slug).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
  });

  it("every category exists in the seeded shelf", () => {
    for (const a of articles) {
      expect(VALID_CATEGORIES.has(a.category_key), `${a.slug} -> ${a.category_key}`).toBe(true);
    }
  });

  it("every visibility is one of the three", () => {
    for (const a of articles) {
      expect(VALID_VISIBILITIES.has(a.visibility), `${a.slug} -> ${a.visibility}`).toBe(true);
    }
  });

  it("every article names a pillar page, so none is an orphan", () => {
    for (const a of articles) {
      expect(a.pillar_path, a.slug).toBeTruthy();
      expect(a.pillar_path, a.slug).toMatch(/^\//);
    }
  });
});

describe("the content rules the map sets", () => {
  it("every article is at least 600 words", () => {
    // Below that it is an FAQ answer, and /faq already exists.
    for (const a of articles) {
      const words = a.body_markdown.split(/\s+/).filter(Boolean).length;
      expect(words, `${a.slug} is ${words} words`).toBeGreaterThanOrEqual(600);
    }
  });

  it("every article has at least one complete FAQ pair", () => {
    // FAQ markup is what Google renders as a drop-down under the result.
    for (const a of articles) {
      expect(a.faq.length, a.slug).toBeGreaterThanOrEqual(1);
      for (const f of a.faq) {
        expect(f.question.length, a.slug).toBeGreaterThan(5);
        expect(f.answer.length, a.slug).toBeGreaterThan(20);
      }
    }
  });

  it("every summary is a real sentence, not a placeholder", () => {
    for (const a of articles) {
      expect(a.summary.length, a.slug).toBeGreaterThan(40);
    }
  });

  it("bodies are ASCII only", () => {
    // The plain-characters rule. A curly quote that reaches a code block or a
    // shell string downstream is a runtime failure that looks correct.
    for (const a of articles) {
      const bad = [...a.body_markdown].filter((ch) => ch.codePointAt(0)! > 126);
      expect(bad, `${a.slug}: ${[...new Set(bad)].join(" ")}`).toEqual([]);
    }
  });

  it("frontmatter is ASCII only too", () => {
    for (const f of readdirSync(CONTENT_DIR).filter((n) => n.endsWith(".md"))) {
      const head = readFileSync(join(CONTENT_DIR, f), "utf8").split("---")[1] ?? "";
      const bad = [...head].filter((ch) => ch.codePointAt(0)! > 126);
      expect(bad, `${f}: ${[...new Set(bad)].join(" ")}`).toEqual([]);
    }
  });
});

describe("screenshots are marked, not faked", () => {
  it("no article embeds an image that does not exist", () => {
    // Nothing in this repo can take a screenshot, so an article claiming one is
    // an article with a broken image on a public page.
    for (const a of articles) {
      expect(a.body_markdown, a.slug).not.toMatch(/!\[[^\]]*\]\(/);
    }
  });

  it("the markers say what to capture", () => {
    const markers = articles.flatMap((a) =>
      [...a.body_markdown.matchAll(/<!--\s*SCREENSHOT:\s*(.+?)\s*-->/g)].map((m) => m[1]!),
    );
    expect(markers.length).toBeGreaterThan(0);
    for (const m of markers) expect(m.length).toBeGreaterThan(15);
  });
});

describe("the markdown converter", () => {
  it("handles the shapes these articles actually use", () => {
    const html = markdownToHtml(
      "## Heading\n\nA **bold** word and `code`.\n\n- one\n- two\n\n1. first\n2. second\n\n[link](/x)",
    );
    expect(html).toContain("<h2>Heading</h2>");
    expect(html).toContain("<strong>bold</strong>");
    expect(html).toContain("<code>code</code>");
    expect(html).toContain("<ul>");
    expect(html).toContain("<ol>");
    expect(html).toContain('<a href="/x">link</a>');
  });

  it("escapes HTML in the source before formatting it", () => {
    expect(markdownToHtml("a <script>alert(1)</script> b")).not.toContain("<script>");
  });

  it("passes screenshot markers through untouched", () => {
    // So the admin sees exactly what to capture, in place.
    expect(markdownToHtml("<!-- SCREENSHOT: the thing -->")).toContain(
      "<!-- SCREENSHOT: the thing -->",
    );
  });

  it("produces h2 headings, which is what the TOC builder reads", () => {
    // functions/_shared/blog-render.ts buildTableOfContents only sees <h2>.
    for (const a of articles) {
      expect(a.body_html, a.slug).toContain("<h2>");
    }
  });
});

describe("the import never overwrites", () => {
  const src = readFileSync(join(root, "scripts/seed-help-articles.mjs"), "utf8");

  it("skips a slug that already exists unless forced", () => {
    // Once an article is live the admin editor owns it, and re-running the
    // import must not silently undo an edit somebody made in the UI.
    expect(src).toContain("if (existing.has(a.slug) && !force)");
  });

  it("says so loudly when --force is used", () => {
    expect(src).toContain("have been overwritten");
  });

  it("has a dry run", () => {
    expect(src).toContain("--dry-run");
  });
});

describe("the map and the files agree", () => {
  const map = readFileSync(join(root, "vault/40-growth/help-center-map.md"), "utf8");

  it("every written article appears in the map", () => {
    for (const a of articles) {
      expect(map, `${a.slug} is not in help-center-map.md`).toContain(a.slug);
    }
  });

  it("every article the map marks written exists as a file", () => {
    const written = [...map.matchAll(/^\|\s*([a-z0-9-]+)\s*(?:\*\*\(button\)\*\*)?\s*\|.*\|\s*written\s*\|/gm)]
      .map((m) => m[1]!);
    const have = new Set(articles.map((a) => a.slug));
    const missing = written.filter((s) => !have.has(s));
    expect(missing, `marked written but no file: ${missing.join(", ")}`).toEqual([]);
  });
});

describe("the in-product buttons line up", () => {
  it("an article exists for every slug this story was meant to cover", () => {
    // The other eight land with US-2587..US-2590. This asserts the two that
    // belong to Getting Started and Grading are actually here, so the buttons
    // on New Submission and Submission detail are no longer dead.
    const have = new Set(articles.map((a) => a.slug));
    for (const slug of ["your-first-grade", "reading-your-grade-report", "inviting-your-team"]) {
      expect(have.has(slug), `${slug} is referenced by a HelpLink but not written`).toBe(true);
    }
  });

  it("those articles sit in the category the registry says they do", () => {
    for (const a of articles) {
      const registered = PRODUCT_HELP_SLUGS.find((s) => s.slug === a.slug);
      if (!registered) continue;
      expect(a.category_key, a.slug).toBe(registered.category);
    }
  });
});
