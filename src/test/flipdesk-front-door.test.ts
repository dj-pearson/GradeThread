import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PUBLIC_ROUTES } from "@/lib/seo/public-routes";

// US-9211: GradeThread stays the identity; the reseller workflow is the
// capture leg. The decision is Path 7 in
// vault/40-growth/seo-strategy-options-2026-08.md, and it is only real if the
// site keeps saying it — so the four places the audit found leading with
// grading are pinned here rather than left to the next edit.

const ROOT = join(__dirname, "..", "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

describe("FlipDesk is one click from the front door (US-9211)", () => {
  it("the marketing nav links the product, not the grading pillar", () => {
    const layout = read("src/components/marketing/marketing-layout.tsx");
    const nav = layout.slice(layout.indexOf("<nav"), layout.indexOf("</nav>"));
    expect(nav).toMatch(/to="\/flipdesk"/);
    expect(nav, "grading is a pillar, not a nav destination competing with the product")
      .not.toMatch(/to="\/condition-grading"/);
  });

  it("the footer leads Product with FlipDesk and still links the grading pillar", () => {
    const layout = read("src/components/marketing/marketing-layout.tsx");
    const product = layout.slice(
      layout.indexOf('<FooterColumn title="Product">'),
      layout.indexOf('<FooterColumn title="Guides & Tools">'),
    );
    expect(product).toMatch(/to="\/flipdesk"/);
    expect(product.indexOf('/flipdesk')).toBeLessThan(product.indexOf('/pricing'));
    // Never orphaned: the pillar keeps a crawlable link somewhere in the footer.
    expect(layout).toMatch(/to="\/condition-grading"/);
  });

  it("the home page links the product too", () => {
    expect(read("src/pages/landing.tsx")).toMatch(/to="\/flipdesk"/);
  });

  it("the sitemap does not rank the grading pillar above the product", () => {
    const priority = (path: string) =>
      PUBLIC_ROUTES.find((r) => r.path === path)?.priority ?? 0;
    expect(priority("/flipdesk")).toBeGreaterThanOrEqual(priority("/condition-grading"));
    expect(priority("/flipdesk")).toBeGreaterThanOrEqual(priority("/grading-standard"));
  });

  it("pricing leads with the subscription, and the grade is the differentiator on it", () => {
    const pricing = read("src/pages/marketing/pricing.tsx");
    expect(pricing.indexOf("FlipDesk subscriptions")).toBeLessThan(
      pricing.indexOf(">Pay-per-grade<"),
    );
    expect(pricing).toMatch(/a crosslisting tool cannot do for you/);
  });
});
