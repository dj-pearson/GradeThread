// "On this page" for the in-app help reader.
//
// The same algorithm as buildTableOfContents in functions/_shared/blog-render.ts,
// which the public /help SSR uses, so an article's section anchors are the same
// ids on both surfaces and a #section link written against one works on the
// other. src/test/help-toc.test.ts holds the two together.

export interface HelpTocEntry {
  id: string;
  /** Heading text as the SSR sees it (tags stripped, entities left as-is). */
  text: string;
  /** The same text with the common entities decoded, for display. */
  label: string;
}

function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
}

function slugifyHeading(text: string): string {
  return (
    stripTags(text)
      .toLowerCase()
      .replace(/&[a-z]+;/g, " ")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "section"
  );
}

function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");
}

/**
 * Give every h2 a unique id and list them. Pure: string in, string out.
 * Existing ids are kept (and de-duplicated), so running it twice is a no-op.
 */
export function buildHelpToc(html: string): { html: string; toc: HelpTocEntry[] } {
  const toc: HelpTocEntry[] = [];
  const used = new Set<string>();
  const out = html.replace(/<h2\b([^>]*)>([\s\S]*?)<\/h2>/gi, (match, attrs: string, inner: string) => {
    const text = stripTags(inner);
    if (!text) return match;
    const existing = attrs.match(/\bid="([^"]+)"/i)?.[1];
    const base = existing ?? slugifyHeading(text);
    let id = base;
    let n = 2;
    while (used.has(id)) id = `${base}-${n++}`;
    used.add(id);
    toc.push({ id, text, label: decodeEntities(text) });
    const newAttrs = existing ? attrs.replace(/\bid="[^"]*"/i, `id="${id}"`) : `${attrs} id="${id}"`;
    return `<h2${newAttrs}>${inner}</h2>`;
  });
  return { html: out, toc };
}
