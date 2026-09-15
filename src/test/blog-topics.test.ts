// US-9037: guards over the curated blog topic registry.
//
// The registry is the single source for three decisions that must agree: the
// robots directive in renderTag, the sitemap listing in blogUrls, and the
// "Browse by topic" links on the blog hub. A topic that is indexed but not
// listed wastes the page; one that is listed but not indexed tells Google two
// contradictory things. These tests hold the shape of the registry itself so
// the lockstep has something to stand on.

import { describe, expect, it } from "vitest";
import {
  BLOG_TOPICS,
  BLOG_TOPIC_SLUGS,
  MIN_INDEXABLE_TOPIC_POSTS,
  blogTopic,
  isIndexableTopic,
} from "../../functions/_shared/blog-topics";

describe("blog topic registry", () => {
  it("every slug is a lowercase URL segment", () => {
    for (const slug of BLOG_TOPIC_SLUGS) {
      expect(slug, slug).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
      expect(encodeURIComponent(slug), slug).toBe(slug);
    }
  });

  it("every topic carries real copy, not a restated slug", () => {
    for (const slug of BLOG_TOPIC_SLUGS) {
      const t = BLOG_TOPICS[slug]!;
      expect(t.name.length, `${slug} name`).toBeGreaterThan(2);
      // A meta description Google will not truncate to nothing, and an intro
      // long enough to be the thing that makes the archive worth indexing. The
      // whole registry exists because a title plus cards is not enough page.
      expect(t.description.length, `${slug} description`).toBeGreaterThanOrEqual(80);
      expect(t.description.length, `${slug} description`).toBeLessThanOrEqual(200);
      expect(t.intro.length, `${slug} intro`).toBeGreaterThanOrEqual(120);
      expect(t.title.length, `${slug} title`).toBeGreaterThan(5);
      // " | GradeThread Blog" is 19 chars; keep the whole <title> under ~65.
      expect(t.title.length, `${slug} title`).toBeLessThanOrEqual(46);
    }
  });

  it("no two topics share a description or an intro", () => {
    const descriptions = BLOG_TOPIC_SLUGS.map((s) => BLOG_TOPICS[s]!.description);
    const intros = BLOG_TOPIC_SLUGS.map((s) => BLOG_TOPICS[s]!.intro);
    expect(new Set(descriptions).size).toBe(descriptions.length);
    expect(new Set(intros).size).toBe(intros.length);
  });

  it("copy is plain ASCII punctuation", () => {
    // CLAUDE.md: curly quotes, en/em dashes and U+2026 are banned in anything a
    // machine parses, and this copy lands in <meta> content and JSON-LD.
    // Built from char codes, not a literal: writing the no-break space into
    // this file would itself be the irregular whitespace eslint refuses, and
    // writing it as a regex escape hides which character is under test.
    const banned = new RegExp(
      `[${[0x2018, 0x2019, 0x201c, 0x201d, 0x2013, 0x2014, 0x2026, 0x2212, 0xa0]
        .map((c) => String.fromCharCode(c))
        .join("")}]`,
    );
    for (const slug of BLOG_TOPIC_SLUGS) {
      const t = BLOG_TOPICS[slug]!;
      for (const [field, value] of Object.entries(t)) {
        expect(banned.test(value), `${slug}.${field}`).toBe(false);
      }
    }
  });

  it("blogTopic is case-insensitive and returns null for uncurated tags", () => {
    expect(blogTopic("denim-grading")).not.toBeNull();
    expect(blogTopic("DENIM-GRADING")).not.toBeNull();
    // Real tags on prod that are deliberately out of the registry.
    expect(blogTopic("gradethread")).toBeNull();
    expect(blogTopic("ebay")).toBeNull();
    expect(blogTopic("velvet")).toBeNull();
  });

  it("indexing needs BOTH gates: curated and above the post floor", () => {
    expect(isIndexableTopic("denim-grading", MIN_INDEXABLE_TOPIC_POSTS)).toBe(true);
    // Curated but the posts went away. Reverts to noindex on its own rather
    // than staying in the index as a two-card page.
    expect(isIndexableTopic("denim-grading", MIN_INDEXABLE_TOPIC_POSTS - 1)).toBe(
      false,
    );
    // Uncurated, however many posts it has. This is the arithmetic-only
    // approach the registry exists to refuse.
    expect(isIndexableTopic("velvet", 500)).toBe(false);
  });

  it("the floor is above one so a two-post archive can never be indexed", () => {
    expect(MIN_INDEXABLE_TOPIC_POSTS).toBeGreaterThanOrEqual(3);
  });
});
