import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { resolve, join, sep } from "node:path";

// US-2509. Five buyer pages hand-rolled the entitlement-locked state that
// BuyerPlaceholderPage already renders, and the copies had drifted: three used
// a <Button asChild><Link>, one used a raw <Link> styled to look like a button,
// and the descriptions each restated "part of a higher buyer plan" in their own
// words. One locked state, five implementations.
//
// Also guarded here: the /buyer/* catch-all must not render the coming-soon
// component as its 404. BuyerPlaceholderPage's UNLOCKED branch draws a Sparkles
// icon over "…is coming soon to your buyer dashboard", so pointing a
// not-found route at it told anyone who mistyped a URL that the feature was
// merely unshipped. The seller side has used InShellNotFound since US-443.

const BUYER_PAGES = "src/pages/buyer";
const ROUTES = "src/routes/index.tsx";

function buyerPageFiles(): string[] {
  const dir = resolve(process.cwd(), BUYER_PAGES);
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isFile() && e.name.endsWith(".tsx")) {
      out.push(join(dir, e.name).split(sep).join("/"));
    }
  }
  return out.map((p) => p.slice(p.indexOf("src/")));
}

describe("the buyer locked state has one implementation (US-2509)", () => {
  const pages = buyerPageFiles().filter((p) => !p.endsWith("placeholder.tsx"));

  it("found the buyer pages to check", () => {
    expect(pages.length).toBeGreaterThan(5);
    expect(pages.some((p) => p.endsWith("buyer/alerts.tsx"))).toBe(true);
  });

  it("no buyer page hand-rolls a locked/upgrade card", () => {
    // The tell: a page that gates on an entitlement and then links to
    // /buyer/billing?upgrade= itself, instead of handing the flag to
    // BuyerPlaceholderPage and letting it own that link.
    const offenders = pages.filter((rel) => {
      const src = readFileSync(resolve(process.cwd(), rel), "utf8");
      const gates = /!\s*ent\.has\(/.test(src);
      const ownsUpgradeLink = /\/buyer\/billing\?upgrade=/.test(src);
      const usesShared = /<BuyerPlaceholderPage\b/.test(src);
      return gates && ownsUpgradeLink && !usesShared;
    });
    expect(
      offenders,
      "these build their own upgrade card. Render " +
        "<BuyerPlaceholderPage requiresFlag='…'> and let it own the billing " +
        "link:\n  " + offenders.join("\n  "),
    ).toEqual([]);
  });

  it("the /buyer/* catch-all renders a not-found, not the coming-soon card", () => {
    const src = readFileSync(resolve(process.cwd(), ROUTES), "utf8");
    const line = src
      .split("\n")
      .find((l) => l.includes('path: "/buyer/*"'));
    expect(line, "the /buyer/* catch-all route went missing").toBeDefined();
    expect(
      line!.includes("InShellNotFound"),
      "the buyer 404 must render InShellNotFound. BuyerPlaceholderPage's " +
        "unlocked branch says 'coming soon', which describes an unshipped " +
        "feature rather than a wrong URL.",
    ).toBe(true);
    expect(line!.includes("BuyerPlaceholderPage")).toBe(false);
  });
});
