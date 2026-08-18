import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { ComparisonPage } from "@/pages/marketing/compare";
import { COMPARISONS, comparePath } from "@/lib/seo/comparison-guides";

// US-9018. Thirteen queries shaped "mercari to grailed" earn 202 impressions and
// zero clicks, because Google lands them on the /compare/ page, which answers
// "which is better" rather than "how do I move". The migration sections answer
// the question; this CTA is the next step after the answer, and it has to be on
// EVERY pair — a handoff that exists on some of sixteen pages is a handoff whose
// conversion rate means nothing.

function renderCompare(slug: string): string {
  return renderToStaticMarkup(
    <MemoryRouter initialEntries={[comparePath(slug)]}>
      <ComparisonPage slug={slug} />
    </MemoryRouter>,
  );
}

describe("the crosslisting handoff on comparison pages (US-9018)", () => {
  it.each(COMPARISONS.map((c) => [c.slug] as const))(
    "%s links to FlipDesk crosslisting",
    (slug) => {
      const html = renderCompare(slug);
      expect(html).toContain('href="/flipdesk/crosslisting"');
    },
  );

  it("names the delisting problem, which is the job the tool does", () => {
    const html = renderCompare("vinted-vs-mercari");
    expect(html).toContain("cancelled order");
    expect(html).toContain("Vinted");
    expect(html).toContain("Mercari");
  });

  it("places the handoff after the migration sections, not before them", () => {
    const html = renderCompare("vinted-vs-mercari");
    const migration = html.indexOf("Moving your listings from");
    const cta = html.indexOf('href="/flipdesk/crosslisting"');
    expect(migration).toBeGreaterThan(-1);
    expect(cta).toBeGreaterThan(migration);
  });
});
