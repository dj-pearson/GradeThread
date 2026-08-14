import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { safeEmbedCompany, EMBED_COMPANY_MAX } from "@/lib/return-to";

// US-2549. /embed/grade/:id is a public URL that duplicates certificate content
// and carries partner branding straight from the query string. Three things had
// to be true and only one of them was written down anywhere.

const PAGE = "src/pages/embed-grade.tsx";
const FUNCTION = "functions/embed/grade/[id].ts";
const WIDGET = "functions/embed/grade/widget.ts";
const SHELL = "functions/_shared/spa-shell.ts";

/**
 * safeEmbedCompany as the machine sees it: the function body with comments
 * and layout removed, so the two copies can be compared for what they DO.
 */
function body(src: string): string {
  const i = src.indexOf("export function safeEmbedCompany");
  const j = src.indexOf("\n}", i);
  expect(i, "safeEmbedCompany not found").toBeGreaterThan(-1);
  expect(j, "unterminated safeEmbedCompany").toBeGreaterThan(i);
  return src
    .slice(i, j)
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("//"))
    .join(" ");
}

function read(rel: string): string {
  return readFileSync(resolve(process.cwd(), rel), "utf8");
}

describe("the embed is noindex (US-2549 AC1, AC2)", () => {
  it("the HEADER is what actually does it, and it is still there", () => {
    // This is the mechanism that matters: a header outranks a meta tag and
    // survives a template change. The page is served by the SPA shell, so the
    // assertion has to hold in BOTH files or the chain is broken.
    const fn = read(FUNCTION);
    expect(fn).toContain("serveSpaShell");
    expect(fn, "the .js widget branch must still delegate everything else").toMatch(
      /if \(!\/\\\.js\$\/i\.test\(rawId\)\) \{[\s\S]{0,120}serveSpaShell/,
    );
    const shell = read(SHELL);
    expect(shell).toContain('"x-robots-tag": "noindex, nofollow"');
  });

  it("the page states the decision too", () => {
    const src = read(PAGE);
    expect(src).toContain('from "@/components/seo"');
    expect(src).toMatch(/<SEO[^>]*noindex/);
    // Rendered on every branch, not just the happy one: an error or a slow
    // load is still a public URL.
    expect((src.match(/<EmbedSEO \/>/g) ?? []).length).toBe(3);
  });

  it("the other two public pages named by the review already have one", () => {
    // Recorded so this is not re-filed. /waitlist-pending is served by the same
    // shell (and disallowed in robots.txt); /leaderboard gets its SEO through
    // MarketingLayout, which is why a grep for "<SEO" in the page missed it.
    expect(read("functions/waitlist-pending.ts")).toContain("serveSpaShell");
    expect(read("functions/_shared/seo-config.ts")).toContain('"/waitlist-pending"');
    const leaderboard = read("src/pages/referral-leaderboard.tsx");
    expect(leaderboard).toContain("MarketingLayout");
    expect(read("src/components/marketing/marketing-layout.tsx")).toContain("<SEO");
  });
});

describe("the partner name cannot borrow the domain (US-2549 AC3)", () => {
  it("caps the length so the header cannot run away", () => {
    const long = "A".repeat(500);
    expect(safeEmbedCompany(long)).toHaveLength(EMBED_COMPANY_MAX);
  });

  it("drops bidi and invisible characters", () => {
    // Written as escapes on purpose. These are fixtures, and a fixture nobody
    // can see is a fixture nobody can review — with the characters inline, git
    // classified this whole file as binary and stopped showing its diff.
    const RLO = "\u202E"; // right-to-left override
    const ZWSP = "\u200B"; // zero-width space
    const SHY = "\u00AD"; // soft hyphen
    const CGJ = "\u034F"; // combining grapheme joiner
    const BOM = "\uFEFF"; // byte-order mark (also \s to JS)
    const NBSP = "\u00A0"; // no-break space

    // An RTL override renders text the source does not say — the whole reason
    // to put one in a brand name.
    expect(safeEmbedCompany(`Nike${RLO}gnihtemos`)).toBe("Nikegnihtemos");
    expect(safeEmbedCompany(`Ni${ZWSP}ke`)).toBe("Nike");
    expect(safeEmbedCompany(`Ni${SHY}ke`)).toBe("Nike");
    expect(safeEmbedCompany(`Ni${CGJ}ke`)).toBe("Nike");
    expect(safeEmbedCompany(`Ni${BOM}ke`)).toBe("Nike");
    expect(safeEmbedCompany(`Nike${NBSP}`)).toBe("Nike");
  });

  it("collapses whitespace, so the attribution cannot be pushed off the card", () => {
    expect(safeEmbedCompany("  Acme   Vintage  ")).toBe("Acme Vintage");
    expect(safeEmbedCompany("Acme\n\n\tVintage")).toBe("Acme Vintage");
  });

  it("is null when there is nothing to show", () => {
    expect(safeEmbedCompany(null)).toBeNull();
    expect(safeEmbedCompany(undefined)).toBeNull();
    expect(safeEmbedCompany("   ")).toBeNull();
    expect(safeEmbedCompany("\u200B\u200B")).toBeNull();
  });

  it("keeps a real partner name intact, accents and all", () => {
    expect(safeEmbedCompany("Hervé Léger Resale")).toBe("Hervé Léger Resale");
    expect(safeEmbedCompany("O'Neill & Co.")).toBe("O'Neill & Co.");
  });

  it("the page renders the sanitized value, not the raw param", () => {
    const src = read(PAGE);
    expect(src).toContain('safeEmbedCompany(params.get("company"))');
    expect(src).not.toMatch(/const company = params\.get\("company"\)/);
  });
});

describe("the widget and the page agree on the same URL", () => {
  it("both apply the same rule, with the same cap", () => {
    // The two trees share no module graph (Pages Functions bundle separately),
    // so the rule is duplicated on purpose. Duplicated and DIVERGENT is the
    // failure mode: the same ?company= would render two different headers.
    const widget = read(WIDGET);
    const lib = read("src/lib/return-to.ts");
    expect(widget).toContain("export const EMBED_COMPANY_MAX = 80;");
    expect(lib).toContain("export const EMBED_COMPANY_MAX = 80;");
    expect(EMBED_COMPANY_MAX).toBe(80);
    // Compared, not restated: a literal copy of the rule in the test is a
    // THIRD place to keep in step, and it would pass while both files drifted
    // together away from what the test meant.
    expect(body(widget)).toBe(body(lib));
    expect(body(lib)).toContain("EMBED_COMPANY_MAX");
    // And the widget actually calls it rather than keeping its old inline slice.
    expect(widget).toContain('company: safeEmbedCompany(url.searchParams.get("company"))');
    expect(widget).not.toContain('company.trim().slice(0, 80)');
  });
});

describe("loading and failure say something useful (US-2549 AC4)", () => {
  const src = read(PAGE);

  it("loading draws the card, not a sentence", () => {
    expect(src).not.toContain("Loading grade");
    expect(src).toContain('role="status"');
    expect(src).toContain("animate-pulse");
    // Hand-rolled on purpose: the shared Skeleton is themed and this card is on
    // a fixed light palette, so the shared one would invert or vanish here.
    expect(src).not.toContain('from "@/components/ui/skeleton"');
  });

  it("failure offers a retry and a way back to GradeThread", () => {
    expect(src).toContain("Try again");
    expect(src).toContain("setReloadKey");
    expect(src).toContain("https://gradethread.com");
    // The retry has to re-run the fetch, which means the effect depends on it.
    expect(src).toContain("}, [id, reloadKey]);");
    // And it must clear the previous failure, or the retry renders the error
    // state again no matter what the network said.
    expect(src).toMatch(/setLoading\(true\);\s*\n\s*setError\(false\);/);
  });
});
