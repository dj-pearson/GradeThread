import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as spa from "../lib/seo/help-json-ld";
import * as ssr from "../../functions/_shared/help-json-ld";

// US-2579: the Help Center's structured data exists in two copies — one for the
// SPA, one for the edge-SSR Function — because functions/ is a separate
// tsconfig project bundled for the Workers runtime and the repo already works
// this way (src/lib/seo/json-ld.ts vs functions/_shared/blog-render.ts).
//
// This file is what makes that safe. It asserts the two are the same twice
// over: byte-identical source from the first export onward, AND deeply equal
// output for the same inputs. The second check would survive a refactor that
// broke the first; the first catches a divergence the examples happen to miss.

const root = process.cwd();
const MARKER = "export interface HelpJsonLdArticle";

function bodyOf(path: string): string {
  const src = readFileSync(join(root, path), "utf8");
  const i = src.indexOf(MARKER);
  if (i < 0) throw new Error(`${path}: marker not found`);
  return src.slice(i).replace(/\r\n/g, "\n");
}

const CANONICAL = "https://gradethread.com/help/grading/how-to-photograph-a-jacket";

const HOW_TO = {
  slug: "how-to-photograph-a-jacket",
  title: "How to photograph a jacket for grading",
  summary: "Four shots, flat, in daylight.",
  body_html:
    "<ol><li>Lay the jacket flat on a neutral surface.</li>" +
    "<li>Shoot the front, filling the frame.</li>" +
    "<li>Turn it over and shoot the back.</li>" +
    "<li>Close in on the care label.</li></ol>",
  faq: [{ question: "Do I need a lightbox?", answer: "No. A window works." }],
  published_at: "2026-08-01T00:00:00.000Z",
  reviewed_at: "2026-08-10T00:00:00.000Z",
  updated_at: "2026-08-12T00:00:00.000Z",
};

const PLAIN = {
  ...HOW_TO,
  slug: "what-a-grade-means",
  title: "What a grade means",
  body_html: "<h2>The scale</h2><p>One to ten.</p>",
  faq: [],
};

describe("the two copies are literally the same file", () => {
  it("byte-identical from the first export onward", () => {
    expect(bodyOf("functions/_shared/help-json-ld.ts")).toBe(
      bodyOf("src/lib/seo/help-json-ld.ts"),
    );
  });

  it("each header names its twin, so the next reader finds it", () => {
    const a = readFileSync(join(root, "src/lib/seo/help-json-ld.ts"), "utf8");
    const b = readFileSync(join(root, "functions/_shared/help-json-ld.ts"), "utf8");
    expect(a).toContain("THIS FILE HAS A TWIN");
    expect(b).toContain("THIS FILE HAS A TWIN");
    expect(b).toContain("src/lib/seo/help-json-ld.ts");
  });

  it("neither grows a third breadcrumb builder", () => {
    // The SSR page uses breadcrumbListLd() from blog-render and the SPA gets
    // one from MarketingLayout. A third would be a third thing to keep in step.
    for (const p of ["src/lib/seo/help-json-ld.ts", "functions/_shared/help-json-ld.ts"]) {
      expect(readFileSync(join(root, p), "utf8")).not.toContain("BreadcrumbList");
    }
  });

  it("neither copy imports anything, so they can stay identical", () => {
    for (const p of ["src/lib/seo/help-json-ld.ts", "functions/_shared/help-json-ld.ts"]) {
      const src = readFileSync(join(root, p), "utf8");
      expect(src).not.toMatch(/^import\s/m);
    }
  });
});

describe("the two copies behave the same", () => {
  it("a how-to article produces the same node on both sides", () => {
    expect(ssr.helpArticleLd(HOW_TO, CANONICAL)).toEqual(
      spa.helpArticleLd(HOW_TO, CANONICAL),
    );
  });

  it("a plain article produces the same node on both sides", () => {
    expect(ssr.helpArticleLd(PLAIN, CANONICAL)).toEqual(
      spa.helpArticleLd(PLAIN, CANONICAL),
    );
  });

  it("FAQ and collection agree", () => {
    expect(ssr.helpFaqLd(HOW_TO.faq)).toEqual(spa.helpFaqLd(HOW_TO.faq));
    const collection = {
      name: "Grading",
      description: "The scale.",
      canonical: "https://gradethread.com/help/grading",
      items: [{ title: "The scale", url: "https://gradethread.com/help/grading/the-scale" }],
    };
    expect(ssr.helpCollectionLd(collection)).toEqual(spa.helpCollectionLd(collection));
  });
});

describe("what the markup says", () => {
  it("a how-to with real steps is a HowTo, with the steps in order", () => {
    const ld = spa.helpArticleLd(HOW_TO, CANONICAL) as Record<string, unknown>;
    expect(ld["@type"]).toBe("HowTo");
    const steps = ld.step as Array<Record<string, unknown>>;
    expect(steps).toHaveLength(4);
    expect(steps[0]!.position).toBe(1);
    expect(steps[0]!.text).toContain("Lay the jacket flat");
    expect(steps[3]!.position).toBe(4);
  });

  it("a how-to TITLE with too few steps falls back to TechArticle", () => {
    // A one-step HowTo claims a procedure the page does not contain, which is
    // the kind of markup a manual action gets issued for.
    const ld = spa.helpArticleLd(
      { ...HOW_TO, body_html: "<ol><li>Just do it.</li></ol>" },
      CANONICAL,
    ) as Record<string, unknown>;
    expect(ld["@type"]).toBe("TechArticle");
    expect(ld.step).toBeUndefined();
  });

  it("an article that is not a procedure is a TechArticle", () => {
    expect((spa.helpArticleLd(PLAIN, CANONICAL) as Record<string, unknown>)["@type"]).toBe(
      "TechArticle",
    );
  });

  it("dateModified is reviewed_at, not updated_at", () => {
    // reviewed_at is the date a human re-read the article. Using updated_at
    // would move the date every time a typo was fixed.
    const ld = spa.helpArticleLd(HOW_TO, CANONICAL) as Record<string, unknown>;
    expect(ld.dateModified).toBe("2026-08-10T00:00:00.000Z");
  });

  it("falls back to updated_at only when never reviewed", () => {
    const ld = spa.helpArticleLd(
      { ...PLAIN, reviewed_at: null },
      CANONICAL,
    ) as Record<string, unknown>;
    expect(ld.dateModified).toBe("2026-08-12T00:00:00.000Z");
  });

  it("invents nothing: no rating, no author, no review count", () => {
    const ld = JSON.stringify(spa.helpArticleLd(PLAIN, CANONICAL));
    expect(ld).not.toContain("aggregateRating");
    expect(ld).not.toContain("reviewCount");
    expect(ld).not.toContain("ratingValue");
    expect(ld).not.toContain('"author"');
  });

  it("an article with no FAQ pairs emits no FAQPage at all", () => {
    // An empty FAQPage is markup for data that does not exist.
    expect(spa.helpFaqLd([])).toBeNull();
    expect(spa.helpFaqLd(null)).toBeNull();
    expect(spa.helpFaqLd([{ question: " ", answer: "orphan" }])).toBeNull();
  });

  it("a collection lists its items in order with positions", () => {
    const ld = spa.helpCollectionLd({
      name: "Grading",
      description: "",
      canonical: "https://gradethread.com/help/grading",
      items: [
        { title: "A", url: "https://gradethread.com/help/grading/a" },
        { title: "B", url: "https://gradethread.com/help/grading/b" },
      ],
    }) as Record<string, unknown>;
    const list = ld.mainEntity as Record<string, unknown>;
    expect(list.numberOfItems).toBe(2);
    expect((list.itemListElement as Array<Record<string, unknown>>)[1]!.position).toBe(2);
    // An empty description must not become an empty string in the output.
    expect(ld.description).toBeUndefined();
  });
});

describe("the pages actually emit it", () => {
  it("the SSR Function emits article, FAQ and breadcrumb nodes", () => {
    const src = readFileSync(join(root, "functions/help/[[path]].ts"), "utf8");
    expect(src).toContain("helpArticleLd(article, canonical)");
    expect(src).toContain("helpFaqLd(article.faq)");
    expect(src).toContain("helpCollectionLd(");
  });

  it("the SPA pages emit the same nodes through MarketingLayout", () => {
    const article = readFileSync(join(root, "src/pages/help/article.tsx"), "utf8");
    expect(article).toContain("helpArticleLd(");
    expect(article).toContain("helpFaqLd(");
    for (const p of ["src/pages/help/hub.tsx", "src/pages/help/category.tsx"]) {
      expect(readFileSync(join(root, p), "utf8")).toContain("helpCollectionLd(");
    }
  });
});
