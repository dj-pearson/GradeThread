import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { PRODUCT_HELP_SLUGS } from "../lib/help-slugs";
import { HELP_CATEGORIES } from "../types/help-center";

// US-2584: the contextual help buttons.
//
// The failure this guards is quiet by construction: a question-mark button
// whose slug does not match any article renders nothing, so a typo does not
// crash, does not warn, and does not show up in a screenshot. It just means
// that surface silently has no help.

const root = process.cwd();
const read = (p: string) => readFileSync(join(root, p), "utf8");

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(join(root, dir))) {
    const rel = `${dir}/${name}`;
    if (statSync(join(root, rel)).isDirectory()) walk(rel, out);
    else if (/\.tsx?$/.test(name)) out.push(rel);
  }
  return out;
}

const SOURCE_FILES = walk("src").filter((f) => !f.includes("/test") && !f.includes("__tests__"));

/**
 * Every slug a help button actually names, with the file it came from.
 *
 * TWO spellings, and both must be matched. US-2862 introduced <PageHelp> — the
 * wrapper the page-header surfaces use, so that "the help button sits in the
 * page header's action row" is one decision rather than fifteen. An extractor
 * that knew only <HelpLink> would report every one of those buttons as missing,
 * which is a false alarm on the side that looks like diligence.
 */
const USED: Array<{ file: string; slug: string }> = SOURCE_FILES.flatMap((file) =>
  [...read(file).matchAll(/<(?:HelpLink|PageHelp)[^>]*\bslug="([^"]+)"/g)].map(
    (m) => ({ file, slug: m[1]! }),
  ),
);

describe("the slug registry", () => {
  it("has no duplicates", () => {
    const slugs = PRODUCT_HELP_SLUGS.map((s) => s.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  it("every slug is URL-shaped", () => {
    for (const s of PRODUCT_HELP_SLUGS) {
      expect(s.slug, s.slug).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
    }
  });

  it("every entry names a category that exists", () => {
    const keys = new Set(HELP_CATEGORIES.map((c) => c.key));
    for (const s of PRODUCT_HELP_SLUGS) {
      expect(keys.has(s.category), `${s.slug} -> ${s.category}`).toBe(true);
    }
  });

  it("every entry says what the article must answer", () => {
    // The registry is also the brief the content stories write to. An entry
    // with a vague mustAnswer is an article somebody will guess at.
    for (const s of PRODUCT_HELP_SLUGS) {
      expect(s.mustAnswer.length, s.slug).toBeGreaterThan(40);
      expect(s.surface.length, s.slug).toBeGreaterThan(0);
    }
  });
});

describe("every wired button points at a registered slug", () => {
  it("found the buttons at all", () => {
    expect(USED.length).toBeGreaterThan(0);
  });

  it("both spellings are actually in use, so the extractor is not half-blind", () => {
    // If either form disappears the regex above still passes, and the guard
    // quietly stops covering the other half of the app.
    const raw = SOURCE_FILES.map(read).join("\n");
    expect((raw.match(/<HelpLink\b/g) ?? []).length).toBeGreaterThan(5);
    expect((raw.match(/<PageHelp\b/g) ?? []).length).toBeGreaterThan(5);
  });

  it("<HelpLink> is only spelled where PageHelp cannot be used", () => {
    // US-2862: PageHelp is the one spelling for a page-header surface, and it
    // is what makes the placement rule a decision rather than a coincidence.
    // The exceptions are the component itself, the wrapper, and the handful of
    // surfaces that predate PageHeader and build their own header — those are
    // listed so a new one is a decision, not a drift.
    const ALLOWED = new Set([
      "src/components/help/help-link.tsx",
      "src/components/help/page-help.tsx",
      "src/pages/new-submission.tsx",
      "src/pages/submission-detail.tsx",
      "src/pages/billing.tsx",
      "src/pages/api-keys.tsx",
      "src/pages/team.tsx",
      "src/pages/connect-extension.tsx",
      "src/pages/flipdesk/composer.tsx",
      "src/pages/flipdesk/marketplaces.tsx",
      "src/pages/flipdesk/pipeline.tsx",
      "src/pages/flipdesk/reconcile.tsx",
    ]);
    // Comments stripped: help-slugs.ts and page-help.tsx both explain, in
    // prose, when a <HelpLink> renders nothing. A guard that fires on the
    // documentation written about it is a guard that punishes writing any.
    const offenders = SOURCE_FILES.filter((f) => {
      if (ALLOWED.has(f)) return false;
      const code = read(f)
        .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/\/\/[^\n]*/g, "");
      return /<HelpLink\b/.test(code);
    });
    expect(
      offenders,
      "use <PageHelp slug=…/> in the page header's action row. <HelpLink> " +
        "directly is for the surfaces that build their own header, and that " +
        "list is in this test.",
    ).toEqual([]);
  });

  it("no HelpLink names a slug the registry does not know", () => {
    const known = new Set<string>(PRODUCT_HELP_SLUGS.map((s) => s.slug));
    const unknown = USED.filter((u) => !known.has(u.slug));
    expect(
      unknown,
      `these <HelpLink> slugs are not in PRODUCT_HELP_SLUGS, so the button will ` +
        `silently render nothing: ${unknown.map((u) => `${u.slug} (${u.file})`).join(", ")}`,
    ).toEqual([]);
  });
});

describe("the surfaces the story named all have a button", () => {
  const REQUIRED: Array<[string, string]> = [
    ["src/pages/new-submission.tsx", "your-first-grade"],
    ["src/pages/submission-detail.tsx", "reading-your-grade-report"],
    ["src/pages/flipdesk/pipeline.tsx", "the-flipdesk-pipeline"],
    ["src/pages/flipdesk/composer.tsx", "writing-a-listing-in-the-composer"],
    ["src/pages/flipdesk/marketplaces.tsx", "connecting-a-marketplace"],
    ["src/pages/flipdesk/reconcile.tsx", "reconciling-payouts"],
    ["src/pages/billing.tsx", "plans-credits-and-billing"],
    ["src/pages/api-keys.tsx", "api-keys-and-the-sandbox"],
    ["src/pages/team.tsx", "inviting-your-team"],
    ["src/pages/connect-extension.tsx", "installing-the-browser-extension"],
    // US-2862. The first ten were all surfaces a user reaches once they
    // already know what they are doing. These are the ones somebody gets stuck
    // on in their first week, and none of them had an entry in the registry at
    // all — so HelpLink had nothing to render there even after US-2618 loads
    // the articles.
    ["src/pages/flipdesk/intake.tsx", "adding-your-first-item"],
    ["src/pages/flipdesk/listings.tsx", "the-four-inventory-views"],
    ["src/pages/flipdesk/autolister-host.tsx", "batch-listing-with-autolister"],
    ["src/pages/flipdesk/sourcing.tsx", "deciding-what-to-buy"],
    ["src/pages/flipdesk/pricing.tsx", "pricing-your-listings"],
    ["src/pages/flipdesk/money.tsx", "reading-your-money"],
    ["src/pages/flipdesk/offers.tsx", "offers-and-buyer-messages"],
    ["src/pages/flipdesk/post-sale.tsx", "returns-and-disputes"],
    ["src/pages/flipdesk/scheduled-drops.tsx", "scheduling-a-drop"],
    ["src/pages/flipdesk/verified.tsx", "becoming-a-verified-seller"],
    ["src/pages/flipdesk/consignment.tsx", "taking-in-consignment"],
    ["src/pages/flipdesk/import.tsx", "importing-your-inventory"],
    ["src/pages/snap.tsx", "snap-to-value"],
    ["src/pages/flipdesk/measure-card.tsx", "using-the-measurecard"],
    ["src/pages/rewards.tsx", "rewards-and-credit"],
  ];

  it.each(REQUIRED)("%s has a help button for %s", (file, slug) => {
    expect(read(file)).toContain(`slug="${slug}"`);
  });

  it("covers every registry entry, so nothing in the backlog is orphaned", () => {
    const used = new Set<string>(USED.map((u) => u.slug));
    const unused = PRODUCT_HELP_SLUGS.filter((s) => !used.has(s.slug)).map((s) => s.slug);
    expect(unused, `registered but never rendered: ${unused.join(", ")}`).toEqual([]);
  });
});

describe("a missing article degrades to nothing, not to a dead end", () => {
  const src = read("src/components/help/help-link.tsx");

  it("renders null while loading, on error, and when there is no article", () => {
    // A question mark that opens an apology is worse than no question mark, and
    // this is what lets the slug registry ship ahead of the writing.
    expect(src).toContain("if (isLoading || isError || !article) return null;");
  });

  it("opens a side sheet rather than navigating away", () => {
    // A new tab loses the half-filled form they were stuck in, which is the
    // exact moment they went looking for help.
    expect(src).toContain("<Sheet");
    expect(src).not.toContain("window.open");
  });

  it("carries an accessible name, since the button is icon-only", () => {
    expect(src).toContain("aria-label=");
  });

  it("offers the full article and a ticket as the next steps", () => {
    expect(src).toContain("/dashboard/help/");
    expect(src).toContain("/dashboard/support");
  });
});
