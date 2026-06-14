import { describe, it, expect } from "vitest";
import {
  buildTableOfContents,
  slugifyHeading,
  renderKeyTakeaways,
  renderTableOfContents,
  renderFaqSection,
  faqPageJsonLd,
  renderRelatedPosts,
  articleAuthorLd,
  authorPersonLd,
  postAuthorLd,
  profilePageLd,
  authorUrl,
  renderAuthorBio,
  renderAuthorCredentials,
  wasUpdatedAfterPublish,
  type PublicAuthor,
  type PublicPost,
  type PublicPostListItem,
} from "../../functions/_shared/blog-render";

// US-304: blog GEO enhancements. These pure helpers power the answer-first
// key-takeaways block, auto TOC, on-page FAQ + FAQPage JSON-LD, author byline,
// "Updated <date>", and the related-posts block in the blog SSR.

describe("buildTableOfContents (US-304)", () => {
  it("adds ids to h2s and returns matching toc entries", () => {
    const { html, toc } = buildTableOfContents(
      "<h2>First Section</h2><p>x</p><h2>Second Section</h2>",
    );
    expect(toc).toEqual([
      { id: "first-section", text: "First Section" },
      { id: "second-section", text: "Second Section" },
    ]);
    expect(html).toContain('<h2 id="first-section">First Section</h2>');
    expect(html).toContain('<h2 id="second-section">Second Section</h2>');
  });

  it("preserves an existing id", () => {
    const { html, toc } = buildTableOfContents(
      '<h2 id="custom" class="x">Title</h2>',
    );
    expect(toc[0]).toEqual({ id: "custom", text: "Title" });
    expect(html).toContain('id="custom"');
    expect(html).toContain('class="x"');
  });

  it("de-duplicates colliding ids", () => {
    const { toc } = buildTableOfContents("<h2>Tips</h2><h2>Tips</h2>");
    expect(toc.map((t) => t.id)).toEqual(["tips", "tips-2"]);
  });

  it("strips inline markup from heading text/id and ignores empty h2s", () => {
    const { toc } = buildTableOfContents(
      "<h2><strong>Bold</strong> Heading</h2><h2></h2>",
    );
    expect(toc).toEqual([{ id: "bold-heading", text: "Bold Heading" }]);
  });

  it("leaves body without h2s unchanged", () => {
    const body = "<p>No headings here</p>";
    const { html, toc } = buildTableOfContents(body);
    expect(html).toBe(body);
    expect(toc).toEqual([]);
  });
});

describe("slugifyHeading", () => {
  it("slugifies and falls back to 'section'", () => {
    expect(slugifyHeading("Hello, World!")).toBe("hello-world");
    expect(slugifyHeading("   ")).toBe("section");
    expect(slugifyHeading("!!!")).toBe("section");
  });
});

describe("renderKeyTakeaways", () => {
  it("renders nothing when empty (graceful fallback)", () => {
    expect(renderKeyTakeaways(undefined)).toBe("");
    expect(renderKeyTakeaways([])).toBe("");
    expect(renderKeyTakeaways(["  "])).toBe("");
  });
  it("renders an answer-first list and escapes", () => {
    const html = renderKeyTakeaways(["Point one", "A & B"]);
    expect(html).toContain("Key takeaways");
    expect(html).toContain("<li>Point one</li>");
    expect(html).toContain("A &amp; B");
  });
});

describe("renderTableOfContents", () => {
  it("omits the TOC for fewer than 2 headings", () => {
    expect(renderTableOfContents([])).toBe("");
    expect(renderTableOfContents([{ id: "a", text: "A" }])).toBe("");
  });
  it("renders anchor links for 2+ headings", () => {
    const html = renderTableOfContents([
      { id: "a", text: "A" },
      { id: "b", text: "B" },
    ]);
    expect(html).toContain('<a href="#a">A</a>');
    expect(html).toContain('<a href="#b">B</a>');
  });
});

describe("renderFaqSection + faqPageJsonLd", () => {
  it("renders nothing and null when there are no valid FAQs", () => {
    expect(renderFaqSection(undefined)).toBe("");
    expect(faqPageJsonLd(undefined)).toBeNull();
    expect(renderFaqSection([{ q: "", a: "x" }])).toBe("");
    expect(faqPageJsonLd([{ q: "x", a: "" }])).toBeNull();
  });
  it("renders visible Q&A", () => {
    const html = renderFaqSection([{ q: "What?", a: "This." }]);
    expect(html).toContain("Frequently asked questions");
    expect(html).toContain("<dt>What?</dt>");
    expect(html).toContain("<dd>This.</dd>");
  });
  it("builds FAQPage JSON-LD mirroring the visible Q&A", () => {
    const ld = faqPageJsonLd([{ q: "What?", a: "This." }]);
    expect(ld).toMatchObject({
      "@type": "FAQPage",
      mainEntity: [
        {
          "@type": "Question",
          name: "What?",
          acceptedAnswer: { "@type": "Answer", text: "This." },
        },
      ],
    });
  });
});

describe("renderRelatedPosts", () => {
  const post: PublicPostListItem = {
    id: "1",
    slug: "denim-care",
    title: "Denim care",
    excerpt: "How to keep denim crisp",
    product_focus: "gradethread",
    hero_image_url: null,
    primary_keyword: null,
    reading_time_min: 4,
    published_at: "2026-05-01",
    updated_at: "2026-05-01",
  };
  it("renders nothing when there are no related posts", () => {
    expect(renderRelatedPosts(undefined)).toBe("");
    expect(renderRelatedPosts([])).toBe("");
  });
  it("renders internal links to related posts", () => {
    const html = renderRelatedPosts([post]);
    expect(html).toContain("Keep reading");
    expect(html).toContain('href="/blog/denim-care"');
    expect(html).toContain("Denim care");
  });
});

describe("articleAuthorLd", () => {
  it("returns a Person for a named author (E-E-A-T)", () => {
    expect(articleAuthorLd("Jane Doe", "https://gradethread.com")).toEqual({
      "@type": "Person",
      name: "Jane Doe",
    });
  });
  it("falls back to the GradeThread Team organization", () => {
    expect(articleAuthorLd(null, "https://gradethread.com")).toEqual({
      "@type": "Organization",
      name: "GradeThread Team",
      url: "https://gradethread.com",
    });
    expect(articleAuthorLd("   ", "https://gradethread.com")).toMatchObject({
      "@type": "Organization",
    });
  });
});

// US-874: author entities — Person/ProfilePage JSON-LD + author-page render.
describe("author entities (US-874)", () => {
  const author: PublicAuthor = {
    slug: "jane-doe",
    name: "Jane Doe",
    title: "Lead Condition Analyst",
    bio_md: "First paragraph.\n\nSecond paragraph.",
    avatar_url: "https://gradethread.com/a.jpg",
    credentials: ["10 years grading", "  "],
    same_as: ["https://x.com/jane", "not-a-url", " "],
  };
  const site = "https://gradethread.com";

  it("authorUrl builds the profile URL", () => {
    expect(authorUrl(site, "jane-doe")).toBe("https://gradethread.com/authors/jane-doe");
  });

  it("authorPersonLd emits a full Person node, dropping blanks/non-urls", () => {
    expect(authorPersonLd(author, site)).toEqual({
      "@type": "Person",
      name: "Jane Doe",
      url: "https://gradethread.com/authors/jane-doe",
      jobTitle: "Lead Condition Analyst",
      image: "https://gradethread.com/a.jpg",
      sameAs: ["https://x.com/jane"],
      knowsAbout: ["10 years grading"],
    });
  });

  it("authorPersonLd omits optional fields when empty", () => {
    expect(authorPersonLd({ slug: "x", name: "X", title: null, avatar_url: null }, site)).toEqual({
      "@type": "Person",
      name: "X",
      url: "https://gradethread.com/authors/x",
    });
  });

  it("postAuthorLd prefers the entity, else falls back to the byline string", () => {
    const base = { author_entity: undefined, author: "Legacy Name" } as Partial<PublicPost>;
    expect(postAuthorLd({ ...base, author_entity: author } as PublicPost, site)).toMatchObject({
      "@type": "Person",
      url: "https://gradethread.com/authors/jane-doe",
    });
    expect(postAuthorLd(base as PublicPost, site)).toEqual({
      "@type": "Person",
      name: "Legacy Name",
    });
    expect(postAuthorLd({ author: null } as PublicPost, site)).toMatchObject({
      "@type": "Organization",
      name: "GradeThread Team",
    });
  });

  it("profilePageLd wraps the Person as the mainEntity", () => {
    const ld = profilePageLd(author, site);
    expect(ld).toMatchObject({
      "@type": "ProfilePage",
      url: "https://gradethread.com/authors/jane-doe",
      mainEntity: { "@type": "Person", name: "Jane Doe" },
    });
  });

  it("renderAuthorBio splits paragraphs + escapes; empty → ''", () => {
    expect(renderAuthorBio("")).toBe("");
    expect(renderAuthorBio(null)).toBe("");
    const html = renderAuthorBio("A & B\n\nNext <x>");
    expect(html).toBe("<p>A &amp; B</p><p>Next &lt;x&gt;</p>");
  });

  it("renderAuthorCredentials renders a list, empty → ''", () => {
    expect(renderAuthorCredentials([])).toBe("");
    expect(renderAuthorCredentials(["  "])).toBe("");
    const html = renderAuthorCredentials(["Cert A", "Cert B"]);
    expect(html).toContain("Credentials");
    expect(html).toContain("<li>Cert A</li>");
    expect(html).toContain("<li>Cert B</li>");
  });
});

describe("wasUpdatedAfterPublish", () => {
  it("is true only when the update date is after the publish date", () => {
    expect(
      wasUpdatedAfterPublish("2026-05-01T00:00:00Z", "2026-05-09T12:00:00Z"),
    ).toBe(true);
    // Same day → not surfaced (autosave bumps updated_at on publish day).
    expect(
      wasUpdatedAfterPublish("2026-05-01T00:00:00Z", "2026-05-01T18:00:00Z"),
    ).toBe(false);
    expect(wasUpdatedAfterPublish(null, "2026-05-09")).toBe(false);
    expect(wasUpdatedAfterPublish("2026-05-09", null)).toBe(false);
  });
});
