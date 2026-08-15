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

describe("the internal set (US-2590)", () => {
  const internal = articles.filter((a) => a.visibility === "internal");

  it("exists", () => {
    expect(internal.length).toBeGreaterThan(0);
  });

  it("every internal article is marked 'internal', never 'members'", () => {
    // members = any signed-in CUSTOMER. Operator runbooks are not
    // customer-readable just because somebody signed up.
    for (const a of internal) {
      expect(a.visibility, a.slug).toBe("internal");
      expect(a.audience, a.slug).toBe("operator");
    }
  });

  it("no internal article contains a secret VALUE", () => {
    // The rule is: name where the secret lives, never the value. A runbook
    // holding a value puts it in every backup and search index it touches.
    const SECRET_SHAPES = [
      /\bsk[-_][A-Za-z0-9]{16,}/, // stripe-style
      /\bey[A-Za-z0-9_-]{20,}\./, // JWT
      /\bAKIA[0-9A-Z]{16}\b/, // aws
      /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
      /\b[A-Za-z0-9+/]{40,}={0,2}\b/, // long base64 run
      /\b[0-9a-f]{32,}\b/i, // long hex run
    ];
    for (const a of internal) {
      for (const re of SECRET_SHAPES) {
        expect(a.body_markdown, `${a.slug} matches ${re}`).not.toMatch(re);
      }
    }
  });

  it("every internal article links a vault note or a skill rather than restating it", () => {
    // One source of truth. A runbook copied into an article is a runbook that
    // will disagree with itself.
    for (const a of internal) {
      const linksVault = /\[\[[a-z0-9-]+\]\]/.test(a.body_markdown);
      const linksSkill = /`[a-z-]+` skill/.test(a.body_markdown);
      expect(linksVault || linksSkill, `${a.slug} links no vault note or skill`).toBe(true);
    }
  });

  it("no PUBLIC article links a vault note", () => {
    // Wikilinks are an internal navigation device. One in a public article
    // renders as literal double brackets on a page a customer is reading.
    for (const a of articles.filter((x) => x.visibility === "public")) {
      expect(a.body_markdown, `${a.slug} contains a wikilink`).not.toMatch(/\[\[[a-z0-9-]+\]\]/);
    }
  });

  it("the vault notes they link actually exist", () => {
    const names = new Set(
      readdirSync(join(root, "vault"), { recursive: true, withFileTypes: true })
        .filter((d) => d.isFile() && d.name.endsWith(".md"))
        .map((d) => d.name.replace(/\.md$/, "")),
    );
    for (const a of internal) {
      for (const m of a.body_markdown.matchAll(/\[\[([a-z0-9-]+)\]\]/g)) {
        expect(names.has(m[1]!), `${a.slug} links [[${m[1]}]] which does not exist`).toBe(true);
      }
    }
  });
});

describe("US-2618: written articles have a path to the database", () => {
  // 83 articles were written, parsed correctly by every test above, and were
  // invisible on the live site for weeks — because nothing ran the loader. The
  // whole suite was green the entire time, which is the point: parsing content
  // and PUBLISHING it are different claims, and only one of them was checked.
  it("the loader is reachable by name, not just by remembering a path", () => {
    // The script existed and was wired to nothing — no npm script, no workflow,
    // no deploy step. A tool you have to remember the path to is a tool that
    // gets forgotten.
    const pkg = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8"));
    expect(pkg.scripts?.["help:seed"]).toBe("node scripts/seed-help-articles.mjs");
  });

  it("the production probe would notice an empty Help Center", () => {
    // The check that closes the loop. A hub serving 200 with no links is
    // invisible to a status-code check, and that is exactly what happened.
    const probe = readFileSync(join(process.cwd(), "scripts/probe-public-routes.mjs"), "utf8");
    expect(probe).toContain("mustLink");
    expect(probe).toContain("KNOWN_EMPTY_INDEXES");
  });

  it("the known-empty exception names the article count it is waiting on", () => {
    // Shrink-only, and the entry has to say what removes it. An exception that
    // just names a path is a permanent excuse.
    const probe = readFileSync(join(process.cwd(), "scripts/probe-public-routes.mjs"), "utf8");
    const entry = /\/help[\s\S]{0,400}?help:seed/.exec(probe);
    expect(entry, "the /help exception must name the fix").toBeTruthy();
    // And the count in it should be the real number of files, so a stale
    // exception is visibly stale rather than vaguely true.
    const count = loadArticles().length;
    expect(probe).toContain(`${count} articles exist in content/help/`);
  });
});
