// US-2594: the support-KB → help_articles migration, and the summary it derives.
//
// The script was run for the first time on 2026-08-16 against a local stack
// carrying all 609 migrations and the 83-article help corpus. It behaved
// correctly — dry run, refused on a slug collision, wrote nothing — and every
// category and audience mapping landed where vault/20-domain/help-corpus-convergence.md
// says. What it also did was write `summary: ""` for all eight rows, because
// support_kb_articles has no summary column and help_articles.summary is NOT
// NULL.
//
// That degrades correctly rather than breaking: the SSR uses
// `article.summary || HELP_HUB_DESCRIPTION` and the article list omits the
// paragraph on a falsy value, so there is no empty description tag and no stray
// empty `<p>`. What it produces is eight public pages sharing one generic meta
// description — a duplicate-description signal to a crawler, and a blank row in
// the category listing beside hand-written neighbours that have one.
//
// So the script derives one. These pin the shape, because a summary is
// customer-facing text on a public page and "the first 200 characters of the
// file" is not good enough: a summary reading "```bash" or "- Step one" is
// worse than the empty string it replaces.
import { describe, expect, it } from "vitest";
import { deriveSummary, mapCategory, mapVisibility, toHelpArticle } from "./migrate-support-kb-to-help.mjs";

describe("deriveSummary picks prose, not markup", () => {
  it("skips a leading heading", () => {
    expect(deriveSummary("# Title\n\nThe real first paragraph."))
      .toBe("The real first paragraph.");
  });

  it("skips list items, quotes and code fences", () => {
    expect(deriveSummary("- one\n- two\n\nProse after the list.")).toBe("Prose after the list.");
    expect(deriveSummary("> quoted\n\nProse after the quote.")).toBe("Prose after the quote.");
    expect(deriveSummary("```bash\nnpm run x\n```\n\nProse after a fence."))
      .toBe("Prose after a fence.");
  });

  it("returns empty rather than markup when there is no prose", () => {
    // The empty string is the honest answer here, and the SSR already handles
    // it. Emitting "- Step one" as a page description would not be.
    expect(deriveSummary("")).toBe("");
    expect(deriveSummary("> a quote and nothing else\n")).toBe("");
    expect(deriveSummary("# Heading\n## Another\n")).toBe("");
  });

  it("strips link and emphasis markup from the text it keeps", () => {
    expect(deriveSummary("See [the docs](https://x.test) and **bold** text."))
      .toBe("See the docs and bold text.");
  });

  it("never cuts a word in half, and prefers a sentence boundary", () => {
    const long = "First sentence is short. " +
      "Then a much longer second sentence that keeps going and going well past " +
      "the two hundred character cap so the truncation logic has to choose a " +
      "boundary rather than cutting a word in half somewhere in the middle.";
    const out = deriveSummary(long);
    expect(out.length).toBeLessThanOrEqual(201);
    // Either it ends at a sentence, or at a word with an ellipsis — never
    // mid-word.
    expect(out).toMatch(/(\.|…)$/);
    expect(long.startsWith(out.replace(/…$/, ""))).toBe(true);
  });

  it("keeps a short body whole", () => {
    const short = "A complete short summary sentence.";
    expect(deriveSummary(short)).toBe(short);
  });
});

describe("the mappings the convergence note specifies", () => {
  it("maps the two judgement calls the script warns about", () => {
    // Both are named in vault/20-domain/help-corpus-convergence.md, and the
    // dry-run counts exist so they are checked BEFORE rows move.
    expect(mapCategory("disputes")).toBe("troubleshooting");
    expect(mapCategory("photos")).toBe("grading");
  });

  it("maps audience onto visibility, not onto itself", () => {
    expect(mapVisibility("subscriber")).toBe("members");
    expect(mapVisibility("public")).toBe("public");
  });

  it("a migrated row carries a summary and rendered html", () => {
    const row = {
      slug: "x",
      title: "X",
      body_md: "# X\n\nThe body of the article, in prose.",
      category: "grading",
      audience: "public",
      is_published: true,
    };
    const out = toHelpArticle(row);
    expect(out.summary).toBe("The body of the article, in prose.");
    expect(out.body_html).toMatch(/</);
    // The top heading is demoted rather than left to render as a hash.
    expect(out.body_markdown.startsWith("## ")).toBe(true);
  });
});
