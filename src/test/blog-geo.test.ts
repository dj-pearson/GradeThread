import { describe, it, expect } from "vitest";
import {
  buildTableOfContents,
  slugifyHeading,
  renderKeyTakeaways,
  renderTableOfContents,
  renderFaqSection,
  faqPageJsonLd,
  renderRelatedPosts,
  renderHeroImage,
  heroImageObjectLd,
  rewriteContentImages,
  linkGlossaryTerms,
  glossaryAboutLd,
  isHowToPost,
  deriveHowToSteps,
  buildPostHowToLd,
  speakableSpec,
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

// US-876: image SEO — hero alt/caption, ImageObject JSON-LD, inline-image meta.
describe("renderHeroImage (US-876)", () => {
  it("renders the hero img with alt + eager/high-priority hints", () => {
    const html = renderHeroImage("https://x/h.jpg", "Vintage denim jacket flat-lay", false);
    expect(html).toContain('src="https://x/h.jpg"');
    expect(html).toContain('alt="Vintage denim jacket flat-lay"');
    expect(html).toContain('loading="eager"');
    expect(html).toContain('fetchpriority="high"');
    expect(html).not.toContain("<figure");
  });

  it("never ships an empty alt even when given a blank one", () => {
    const html = renderHeroImage("https://x/h.jpg", "   ", false);
    expect(html).not.toContain('alt=""');
    expect(html).toMatch(/alt="[^"]+"/);
  });

  it("wraps in <figure>/<figcaption> when a caption is supplied", () => {
    const html = renderHeroImage("https://x/h.jpg", "Alt text", false, "Photo: studio");
    expect(html).toContain('<figure class="hero-figure">');
    expect(html).toContain("<figcaption>Photo: studio</figcaption>");
  });

  it("emits a responsive srcset only when resize is enabled", () => {
    expect(renderHeroImage("https://x/h.jpg", "a", true)).toContain("srcset=");
    expect(renderHeroImage("https://x/h.jpg", "a", false)).not.toContain("srcset=");
  });

  it("returns empty string when there is no hero src", () => {
    expect(renderHeroImage(null, "a", true)).toBe("");
    expect(renderHeroImage(undefined, "a", false)).toBe("");
  });
});

describe("heroImageObjectLd (US-876)", () => {
  it("builds an ImageObject with contentUrl, dimensions, and caption", () => {
    const ld = heroImageObjectLd({
      url: "https://x/h.jpg",
      alt: "Vintage jacket",
      caption: "On a mannequin",
      width: 1536,
      height: 1024,
    });
    expect(ld).toMatchObject({
      "@type": "ImageObject",
      url: "https://x/h.jpg",
      contentUrl: "https://x/h.jpg",
      caption: "On a mannequin",
      description: "Vintage jacket",
      width: 1536,
      height: 1024,
    });
  });

  it("falls back to alt for caption and omits unknown dimensions", () => {
    const ld = heroImageObjectLd({ url: "https://x/h.jpg", alt: "Only alt" }) as Record<string, unknown>;
    expect(ld.caption).toBe("Only alt");
    expect(ld.width).toBeUndefined();
    expect(ld.height).toBeUndefined();
  });

  it("returns null when there is no url", () => {
    expect(heroImageObjectLd({ url: null })).toBeNull();
    expect(heroImageObjectLd({ url: "   " })).toBeNull();
  });
});

describe("rewriteContentImages alt coverage (US-876)", () => {
  it("backfills alt from stored metadata, then filename, then fallback — never empty", () => {
    const html =
      '<img src="https://x/stored.jpg">' +
      '<img src="https://x/vintage-levis-jacket.jpg">' +
      '<img src="https://x/9f8a7b6c5d4e3f2a1b.jpg">';
    const out = rewriteContentImages(html, false, {
      fallbackAlt: "Post Title",
      imageMeta: [{ src: "https://x/stored.jpg", alt: "Stored alt text" }],
    });
    expect(out).toContain('alt="Stored alt text"');
    expect(out).toContain('alt="vintage levis jacket"');
    expect(out).toContain('alt="Post Title"'); // hash filename → title fallback
    // Critical: no <img> in the rendered article ships without an alt attribute.
    for (const tag of out.match(/<img\b[^>]*>/gi) ?? []) {
      expect(tag).toMatch(/\salt="[^"]*"/);
      expect(tag).not.toMatch(/\salt=""/);
    }
  });

  it("wraps an image in <figure> when stored metadata carries a caption", () => {
    const out = rewriteContentImages('<img src="https://x/a.jpg">', false, {
      imageMeta: [{ src: "https://x/a.jpg", alt: "Alt", caption: "A caption" }],
    });
    expect(out).toContain('<figure class="content-figure">');
    expect(out).toContain("<figcaption>A caption</figcaption>");
  });
});

// ─── US-878: GEO depth (entity consistency, HowTo, Speakable) ───────────────

describe("linkGlossaryTerms (US-878)", () => {
  it("links the first mention of an unambiguous term to its glossary spoke", () => {
    const { html, terms } = linkGlossaryTerms(
      "<p>An NWT shirt and another NWT item.</p>",
    );
    expect(html).toContain('<a href="/grading/nwt">NWT</a>');
    // First occurrence only — the second NWT stays plain text.
    expect(html.match(/<a href="\/grading\/nwt">/g)?.length).toBe(1);
    expect(terms).toEqual([{ term: "NWT", path: "/grading/nwt" }]);
  });

  it("requires 'condition' for common-adjective tiers and prefers the longest", () => {
    const { html } = linkGlossaryTerms(
      "<p>It is in Very Good condition, not just Good condition.</p>",
    );
    expect(html).toContain('<a href="/grading/very-good">Very Good condition</a>');
    expect(html).toContain('<a href="/grading/good">Good condition</a>');
    // No nested anchors from the "Good condition" inside "Very Good condition".
    expect(html).not.toMatch(/<a[^>]*><a/);
  });

  it("does not link a bare adjective with no 'condition'", () => {
    const { html, terms } = linkGlossaryTerms("<p>This is a good day for fair weather.</p>");
    expect(html).not.toContain("/grading/");
    expect(terms).toHaveLength(0);
  });

  it("never links inside an existing anchor, heading, or code block", () => {
    const { html } = linkGlossaryTerms(
      '<h2>NWT explained</h2><p><a href="/x">NWT</a> and <code>NWT</code></p><p>An NWT tag.</p>',
    );
    // Only the plain-prose NWT gets linked.
    expect(html).toContain("<h2>NWT explained</h2>");
    expect(html).toContain('<a href="/x">NWT</a>');
    expect(html).toContain("<code>NWT</code>");
    expect(html).toContain('<a href="/grading/nwt">NWT</a>');
    expect(html.match(/\/grading\/nwt/g)?.length).toBe(1);
  });

  it("links a multi-word factor and decodes the &amp; factor", () => {
    const { html, terms } = linkGlossaryTerms(
      "<p>We weight Fabric Condition and Odor &amp; Cleanliness.</p>",
    );
    expect(html).toContain('<a href="/grading/fabric-condition">Fabric Condition</a>');
    expect(html).toContain('<a href="/grading/odor-cleanliness">Odor &amp; Cleanliness</a>');
    expect(terms.map((t) => t.path)).toContain("/grading/odor-cleanliness");
  });
});

describe("glossaryAboutLd (US-878)", () => {
  it("builds DefinedTerm nodes pointing at spokes + the hub term set", () => {
    const nodes = glossaryAboutLd(
      [{ term: "NWT", path: "/grading/nwt" }],
      "https://gradethread.com",
    );
    expect(nodes).toEqual([
      {
        "@type": "DefinedTerm",
        name: "NWT",
        url: "https://gradethread.com/grading/nwt",
        inDefinedTermSet: "https://gradethread.com/condition-grading",
      },
    ]);
  });
});

describe("isHowToPost / deriveHowToSteps / buildPostHowToLd (US-878)", () => {
  it("detects procedural posts from the title/keyword", () => {
    expect(isHowToPost({ title: "How to grade a jacket" })).toBe(true);
    expect(isHowToPost({ title: "A step-by-step guide" })).toBe(true);
    expect(isHowToPost({ title: "What NWOT means", primary_keyword: "nwot meaning" })).toBe(false);
  });

  it("derives ordered steps from the first <ol>", () => {
    const steps = deriveHowToSteps(
      "<p>intro</p><ol><li>Photograph the front: get good light.</li><li>Check the seams.</li></ol>",
    );
    expect(steps).toHaveLength(2);
    expect(steps[0]!.name).toBe("Photograph the front");
    expect(steps[0]!.text).toContain("get good light");
  });

  it("falls back to the H2 outline with anchor urls", () => {
    const steps = deriveHowToSteps(
      "<h2>Inspect the fabric</h2><p>Look for pilling.</p><h2>Test the zipper</h2><p>Run it fully.</p>",
      "https://gradethread.com/blog/x",
    );
    expect(steps).toHaveLength(2);
    expect(steps[0]!.name).toBe("Inspect the fabric");
    expect(steps[0]!.url).toBe("https://gradethread.com/blog/x#inspect-the-fabric");
  });

  it("returns [] when fewer than two steps can be derived", () => {
    expect(deriveHowToSteps("<p>no steps here</p>")).toEqual([]);
    expect(deriveHowToSteps("<ol><li>only one</li></ol>")).toEqual([]);
  });

  it("builds a HowTo node only for procedural posts with derivable steps", () => {
    const base = {
      title: "How to grade a jacket",
      excerpt: "A quick guide.",
      body_html: "<ol><li>Step one done.</li><li>Step two done.</li></ol>",
    };
    const ld = buildPostHowToLd(base, "https://gradethread.com/blog/x") as Record<
      string,
      unknown
    >;
    expect(ld).not.toBeNull();
    expect(ld["@type"]).toBe("HowTo");
    expect((ld.step as unknown[]).length).toBe(2);
    expect(ld.description).toBe("A quick guide.");

    // Non-procedural title → null even when an <ol> exists.
    expect(
      buildPostHowToLd(
        { title: "NWOT explained", body_html: base.body_html },
        "https://gradethread.com/blog/y",
      ),
    ).toBeNull();
  });
});

describe("speakableSpec (US-878)", () => {
  it("emits a SpeakableSpecification when key takeaways exist", () => {
    const spec = speakableSpec({ key_takeaways: ["A point."] }) as Record<string, unknown>;
    expect(spec["@type"]).toBe("SpeakableSpecification");
    expect(spec.cssSelector).toEqual([".key-takeaways", "h1"]);
  });

  it("returns null when there are no key takeaways", () => {
    expect(speakableSpec({ key_takeaways: [] })).toBeNull();
    expect(speakableSpec({ key_takeaways: ["  "] })).toBeNull();
    expect(speakableSpec({})).toBeNull();
  });
});
