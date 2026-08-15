// US-2594: the support-KB → help_articles mapping, and the two refusals.
//
// This migration moves customer-facing answers between corpora, so the failure
// modes are content failures rather than crashes: an article filed under a
// heading nobody chose, a members-only answer published to the world, or a
// hand-written help page silently overwritten by an older wording of itself.
// Each of those looks like success at the console.
//
// So the cases below are mostly about what the script REFUSES. The mapping
// itself is nine lines and self-evident; the refusals are the engineering.
import { describe, expect, it } from "vitest";
import {
  CATEGORY_MAP,
  findCollisions,
  HELP_CATEGORY_KEYS,
  mapCategory,
  mapStatus,
  mapVisibility,
  summarise,
  toHelpArticle,
} from "../../scripts/migrate-support-kb-to-help.mjs";

const SOURCE_CATEGORIES = [
  "grading",
  "pricing",
  "plans",
  "photos",
  "disputes",
  "flipdesk",
  "billing",
  "account",
  "getting_started",
];

describe("category map", () => {
  it("covers every category the source CHECK constraint allows", () => {
    // 00183 allows exactly these nine. A source row this map cannot place would
    // stop the run, which is right, but finding that out mid-migration is not.
    for (const c of SOURCE_CATEGORIES) {
      expect(() => mapCategory(c), `unmapped: ${c}`).not.toThrow();
    }
    expect(Object.keys(CATEGORY_MAP).sort()).toEqual([...SOURCE_CATEGORIES].sort());
  });

  it("only ever emits a category_key that exists in help_categories", () => {
    // category_key is a foreign key onto help_categories (00602). A typo here
    // fails at insert time against prod, after the dry run has said it is fine.
    for (const c of SOURCE_CATEGORIES) {
      expect(HELP_CATEGORY_KEYS, `bad target for ${c}`).toContain(mapCategory(c));
    }
  });

  it("refuses an unknown category rather than guessing a destination", () => {
    expect(() => mapCategory("shipping")).toThrow(/unmapped/i);
    expect(() => mapCategory("")).toThrow(/unmapped/i);
  });
});

describe("visibility", () => {
  it("maps subscriber to members, never to internal", () => {
    // internal did not exist in the two-value model and holds operator
    // runbooks. Landing a customer answer there hides it from customers; the
    // opposite error would publish a runbook. Neither is recoverable by a
    // reader noticing.
    expect(mapVisibility("public")).toBe("public");
    expect(mapVisibility("subscriber")).toBe("members");
    expect(Object.values({ a: mapVisibility("public"), b: mapVisibility("subscriber") }))
      .not.toContain("internal");
  });

  it("refuses an unknown audience", () => {
    expect(() => mapVisibility("internal")).toThrow(/unmapped/i);
  });
});

describe("status", () => {
  it("an unpublished source row does not become a published help article", () => {
    expect(mapStatus(true)).toBe("published");
    expect(mapStatus(false)).toBe("draft");
  });
});

describe("row payload", () => {
  const row = {
    slug: "how-grading-works",
    title: "How grading works",
    body_md: "# Heading\n\nSome **bold** text.",
    category: "grading",
    audience: "subscriber",
    is_published: true,
    updated_at: "2026-01-02T03:04:05Z",
  };

  it("renders body_html, because the public reader reads that column", () => {
    const out = toHelpArticle(row);
    expect(out.body_html).toContain("<strong>bold</strong>");
    expect(out.body_html).not.toBe("");
  });

  it("demotes a top-level # so it does not render as literal hash marks", () => {
    // markdownToHtml handles ## and ### and NOT #, because the seeded corpus
    // puts the title in the page's h1 and starts bodies at h2 (all 83 files do).
    // Nothing held the support KB to that, and an undemoted # migrates into a
    // visible "# Heading" on a customer-facing page. This case is why the
    // renderer is exercised for real here rather than stubbed.
    const out = toHelpArticle(row);
    expect(out.body_html).toContain("<h2>Heading</h2>");
    expect(out.body_html).not.toContain("<p># Heading</p>");
  });

  it("demotes it in the MARKDOWN too, so the /.md mirror agrees with the page", () => {
    const out = toHelpArticle(row);
    expect(out.body_markdown).toContain("## Heading");
    // Anchored, because "## Heading" trivially contains "# Heading".
    expect(out.body_markdown).not.toMatch(/^# /m);
  });

  it("leaves ## and ### alone", () => {
    const out = toHelpArticle({ ...row, body_md: "## Two\n\n### Three" });
    expect(out.body_markdown).toBe("## Two\n\n### Three");
  });

  it("carries the source timestamp instead of stamping now()", () => {
    // published_at feeds the freshness clock and the sitemap. now() would make
    // an article that has been stable for a year look brand new the day it
    // moves, and the staleness review would then be a year late.
    const out = toHelpArticle(row);
    expect(out.published_at).toBe(row.updated_at);
    expect(out.reviewed_at).toBe(row.updated_at);
  });

  it("leaves published_at null for a draft", () => {
    const out = toHelpArticle({ ...row, is_published: false });
    expect(out.status).toBe("draft");
    expect(out.published_at).toBeNull();
  });

  it("uses the injected renderer, so the test does not depend on markdown output", () => {
    const out = toHelpArticle(row, () => "<p>stub</p>");
    expect(out.body_html).toBe("<p>stub</p>");
  });
});

describe("slug collisions", () => {
  it("detects a collision case-insensitively, the way the unique index does", () => {
    // idx_help_articles_slug is on lower(slug). A check that compared exactly
    // would pass here and then fail at insert, after the dry run said it was
    // safe.
    expect(findCollisions([{ slug: "Billing-FAQ" }], ["billing-faq"])).toEqual(["Billing-FAQ"]);
    expect(findCollisions([{ slug: "billing-faq" }], ["BILLING-FAQ"])).toEqual(["billing-faq"]);
  });

  it("reports nothing when the corpora do not overlap", () => {
    expect(findCollisions([{ slug: "a" }, { slug: "b" }], ["c"])).toEqual([]);
  });

  it("returns every collision, not just the first", () => {
    // The operator resolves these by hand, so a list that stops at one turns a
    // single review into a loop of re-runs.
    expect(findCollisions([{ slug: "a" }, { slug: "b" }], ["a", "b"])).toEqual(["a", "b"]);
  });
});

describe("summary", () => {
  it("counts per category, which is how the judgement calls get checked", () => {
    // photos → grading and disputes → troubleshooting are assumptions. The
    // counts are the only thing that surfaces them BEFORE the rows move.
    const rows = [
      { slug: "a", title: "A", body_md: "", category: "photos", audience: "public", is_published: true },
      { slug: "b", title: "B", body_md: "", category: "disputes", audience: "public", is_published: false },
      { slug: "c", title: "C", body_md: "", category: "grading", audience: "subscriber", is_published: true },
    ];
    const s = summarise(rows.map((r) => toHelpArticle(r, () => "")));
    expect(s.total).toBe(3);
    expect(s.byCategory).toEqual({ grading: 2, troubleshooting: 1 });
    expect(s.byVisibility).toEqual({ public: 2, members: 1 });
    expect(s.byStatus).toEqual({ published: 2, draft: 1 });
  });
});
