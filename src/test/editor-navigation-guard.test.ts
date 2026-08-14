import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { dirtyFieldLabels, unsavedSummary } from "@/lib/editor-dirty";

// US-2536. Both content editors autosave the BODY on a debounce and leave every
// other field to an explicit Save. That split is deliberate — a write per
// keystroke on a title is a storm — but it meant the title, slug, SEO fields,
// hashtags and CTA link lived only in React state, and a sidebar click threw
// them away with no warning at all.

const BLOG = "src/pages/content/blog-editor.tsx";
const SOCIAL = "src/pages/content/social-editor.tsx";

function read(rel: string): string {
  return readFileSync(resolve(process.cwd(), rel), "utf8");
}

describe("both editors guard navigation while dirty (US-2536)", () => {
  it("each uses the shared guard hook", () => {
    for (const rel of [BLOG, SOCIAL]) {
      const src = read(rel);
      expect(src, `${rel} has no guard`).toMatch(/useNavigationGuard\(/);
      expect(src).toMatch(/<AlertDialog\b/);
      expect(src).toMatch(/open=\{guard\.blocked\}/);
    }
  });

  it("the guard is off while a save is in flight", () => {
    // A dialog about work that is on its way to the server is exactly how a
    // guard trains people to click through it.
    for (const rel of [BLOG, SOCIAL]) {
      expect(read(rel), rel).toMatch(
        /dirtyLabels\.length > 0 && !saving && !update\.isPending/,
      );
    }
  });

  it("saving clears the dirty state, so the guard stops firing", () => {
    for (const rel of [BLOG, SOCIAL]) {
      expect(read(rel), rel).toMatch(/setSavedMeta\(currentMeta\)/);
    }
  });

  it("the dialog names the fields rather than saying 'unsaved changes'", () => {
    for (const rel of [BLOG, SOCIAL]) {
      const src = read(rel);
      expect(src).toMatch(/unsavedSummary\(dirtyLabels\)/);
    }
    // And the blog editor tracks every field its Save writes.
    const blog = read(BLOG);
    for (const label of [
      '"Title"',
      '"Slug"',
      '"SEO title"',
      '"SEO description"',
      '"Tags"',
      '"FAQs"',
    ]) {
      expect(blog, `blog editor does not track ${label}`).toContain(label);
    }
  });
});

describe("the dirty comparison itself (US-2536)", () => {
  it("reports only the fields that changed, by label", () => {
    const labels = { title: "Title", slug: "Slug" };
    expect(
      dirtyFieldLabels({ title: "a", slug: "b" }, { title: "a", slug: "b" }, labels),
    ).toEqual([]);
    expect(
      dirtyFieldLabels({ title: "a2", slug: "b" }, { title: "a", slug: "b" }, labels),
    ).toEqual(["Title"]);
  });

  it("does not call trailing whitespace a change", () => {
    // Otherwise a stray space raises a dialog about work that does not exist.
    expect(
      dirtyFieldLabels({ title: "a " }, { title: "a" }, { title: "Title" }),
    ).toEqual([]);
  });

  it("treats null, undefined and empty as the same absence", () => {
    expect(
      dirtyFieldLabels({ excerpt: null }, { excerpt: "" }, { excerpt: "Excerpt" }),
    ).toEqual([]);
    expect(
      dirtyFieldLabels(
        { excerpt: undefined },
        { excerpt: null },
        { excerpt: "Excerpt" },
      ),
    ).toEqual([]);
  });

  it("reads as a sentence at one, two and many", () => {
    expect(unsavedSummary([])).toBeNull();
    expect(unsavedSummary(["Title"])).toBe("Title");
    expect(unsavedSummary(["Title", "Slug"])).toBe("Title and Slug");
    expect(unsavedSummary(["Title", "Slug", "Tags"])).toBe(
      "Title, Slug and Tags",
    );
  });
});
