import { describe, expect, it } from "vitest";
import { buildHelpToc } from "@/lib/help/toc";
import { buildTableOfContents } from "../../functions/_shared/blog-render";

describe("buildHelpToc", () => {
  const BODY =
    "<h2>Before you start</h2><p>x</p><h2>Fees &amp; taxes</h2><h3>Not me</h3>" +
    "<h2>Before you start</h2><h2><strong>Bold</strong> heading</h2>";

  it("adds unique ids to every h2 and lists them in order", () => {
    const { html, toc } = buildHelpToc(BODY);
    expect(toc.map((t) => t.id)).toEqual([
      "before-you-start",
      "fees-taxes",
      "before-you-start-2",
      "bold-heading",
    ]);
    expect(toc[1]!.label).toBe("Fees & taxes");
    for (const { id } of toc) expect(html).toContain(`id="${id}"`);
    expect(html).not.toMatch(/<h3[^>]*id=/);
  });

  it("is idempotent", () => {
    const once = buildHelpToc(BODY).html;
    expect(buildHelpToc(once).html).toBe(once);
  });

  it("produces the same ids and html as the public SSR", () => {
    const client = buildHelpToc(BODY);
    const ssr = buildTableOfContents(BODY);
    expect(client.html).toBe(ssr.html);
    expect(client.toc.map(({ id, text }) => ({ id, text }))).toEqual(ssr.toc);
  });
});
