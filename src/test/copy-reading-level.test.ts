import { describe, it, expect } from "vitest";
import {
  audienceOf,
  collect,
  extractFromSwift,
  extractFromTs,
  readingGrade,
  syllables,
  untaggedJargon,
  JARGON,
  TARGET_GRADE,
} from "../../scripts/check-copy-reading-level.mjs";

// US-2868.
//
// TWO JOBS, AND THE FIRST ONE IS THE IMPORTANT ONE.
//
// 1. The scorer has to keep working. A copy audit that silently stops
//    extracting reports zero offenders, which reads exactly like a codebase
//    that has been cleaned up. Every assertion about the CODEBASE below is
//    therefore paired with one about the TOOL.
// 2. A ratchet on the hard tail. It may fall and never rise.
//
// WHY THE RATCHET IS ON THE TAIL AND NOT THE MEAN. Median customer copy in
// this repo already scores 5.9, under the sixth-grade target, and 793 strings
// sit above it -- almost all of them by a fraction, on sentences that are
// perfectly clear. Gating on "above target" would mean 793 failures nobody can
// act on. The strings that actually defeat a reader are the tail, and there
// are 52 of them.

describe("the scorer still reads what it claims to read", () => {
  it("counts syllables the usual way", () => {
    expect(syllables("cat")).toBe(1);
    expect(syllables("garment")).toBe(2);
    expect(syllables("condition")).toBe(3);
    // 5, not the 6 a person would say. The heuristic reads adjacent vowels
    // ("-ia-") as one group and undercounts every word like this. Pinned at
    // what the tool ACTUALLY does rather than at the right answer: the value
    // here is a stable ranking, and "correcting" the counter would silently
    // move every score and every ceiling below.
    expect(syllables("reconciliation")).toBe(5);
    // The silent-e correction, which is the whole reason this is not a plain
    // vowel-group count.
    expect(syllables("grade")).toBe(1);
    expect(syllables("")).toBe(0);
  });

  it("scores a plain sentence low and a dense one high", () => {
    const plain = readingGrade(
      "Take four photos of the shirt. We give it a score out of ten.",
    );
    const dense = readingGrade(
      "Intentional design elements assessed as styling, graded relative to the garment's original manufactured state.",
    );
    expect(plain).toBeLessThan(TARGET_GRADE);
    expect(dense).toBeGreaterThan(12);
    // Ordering is the property this tool actually has. Absolute accuracy is
    // not claimed anywhere and must not be asserted here.
    expect(dense).toBeGreaterThan(plain!);
  });

  it("returns null rather than a number for a string with no words", () => {
    expect(readingGrade("   ")).toBeNull();
    expect(readingGrade("123 456")).toBeNull();
  });

  it("pulls copy out of TSX and leaves code alone", () => {
    const src = `
      export function X() {
        const q = "flipdesk_search";
        return (
          <div className="flex h-4 w-4 items-center">
            <EmptyState
              title="No drafts yet"
              description={\`You have \${n} items.\`}
            />
            Every grade ends in a certificate.
            <Foo id="not-copy" to="/dashboard/x" />
          </div>
        );
      }`;
    const got = extractFromTs("x.tsx", src).map((r) => r.text);
    expect(got).toContain("No drafts yet");
    expect(got).toContain("Every grade ends in a certificate.");
    // The template's fixed prose survives; the hole does not become copy.
    expect(got.some((t) => t.includes("You have"))).toBe(true);
    // And none of the code-shaped strings are treated as something a user reads.
    for (const noise of [
      "flipdesk_search",
      "flex h-4 w-4 items-center",
      "not-copy",
      "/dashboard/x",
    ]) {
      expect(got, `${noise} was extracted as copy`).not.toContain(noise);
    }
  });

  it("keeps SEO metadata out of the interface-copy score", () => {
    // A meta description is written for a search result and is allowed to be
    // denser than a button. Scoring the two together put four of them in the
    // worst-fifty list.
    const src = `
      export function P() {
        return (<><SEO title="A" description="Live operational status of the web app, grading API, database and authentication." />
        <PageHeader title="Status" /></>);
      }`;
    const got = extractFromTs("p.tsx", src);
    const meta = got.find((r) => r.text.startsWith("Live operational"));
    expect(meta, "the meta description was not extracted at all").toBeDefined();
    expect(meta!.meta, "an <SEO> prop was scored as interface copy").toBe(true);
    const header = got.find((r) => r.text === "Status");
    expect(header!.meta).toBeFalsy();
  });

  it("pulls copy out of Swift and skips its comments", () => {
    const src = [
      '// Text("this is a comment about Text and must not be extracted")',
      '    Text("Your listing is live on eBay.")',
      '    .navigationTitle("Drafts")',
      '    subtitle: "Rules that act on their own"',
    ].join("\n");
    const got = extractFromSwift(src).map((r) => r.text);
    expect(got).toContain("Your listing is live on eBay.");
    expect(got).toContain("Drafts");
    expect(got).toContain("Rules that act on their own");
    expect(
      got.some((t) => t.includes("comment about Text")),
      "the Swift scan fired on the prose written about it -- the fourth time " +
        "this epic. Strip comments before checking for a pattern.",
    ).toBe(false);
  });

  it("knows who is reading a file", () => {
    expect(audienceOf("src/pages/legal/terms.tsx")).toBe("legal");
    expect(audienceOf("src/pages/admin/seo.tsx")).toBe("operator");
    expect(audienceOf("src/components/admin/billing-actions-card.tsx")).toBe(
      "operator",
    );
    expect(audienceOf("src/pages/marketing/pricing.tsx")).toBe("marketing");
    expect(audienceOf("src/pages/flipdesk/offers.tsx")).toBe("customer");
  });

  it("spots jargon, and lets an explained use through", () => {
    expect(untaggedJargon("Apply the eBay aspects now.").map((j) => j.term)).toContain(
      "aspects",
    );
    // A parenthetical right after the word IS the plain tag, and copy that has
    // one must not be reported. An audit that fires on correct copy is an
    // audit that gets switched off.
    expect(
      untaggedJargon("Fill in the item specifics (eBay's word for item details)."),
    ).toHaveLength(0);
    expect(untaggedJargon("A comp is what similar items sold for.")).toHaveLength(0);
    expect(untaggedJargon("Take four photos of the jacket.")).toHaveLength(0);
  });

  it("every jargon entry carries a plain tag of its own", () => {
    for (const j of JARGON) {
      expect(j.hint.length, `${j.term} has no suggested tag`).toBeGreaterThan(10);
      // The tag may not use the word it is tagging -- the US-2864 rule.
      expect(
        new RegExp(`\\b${j.term}\\b`, "i").test(j.hint),
        `${j.term}: the tag repeats the word it is explaining`,
      ).toBe(false);
    }
  });
});

describe("the hard tail only shrinks (US-2868)", () => {
  const rows = collect();
  const customer = rows.filter((r) => r.audience === "customer");
  const scored = customer.filter((r) => r.grade !== null);

  // THE SELF-CHECK. Everything below counts offenders, and every count goes to
  // zero if extraction breaks. A scorer that has stopped working looks exactly
  // like a codebase that has been cleaned up, so the floor is asserted first.
  it("the scan found the codebase", () => {
    expect(rows.length, "extraction collapsed").toBeGreaterThan(10_000);
    expect(customer.length).toBeGreaterThan(5_000);
    expect(scored.length).toBeGreaterThan(1_000);
    expect(
      rows.some((r) => r.platform === "ios"),
      "no iOS strings at all -- the Swift scan is broken or ios/ is missing",
    ).toBe(true);
  });

  it("median customer copy stays at or under the target", () => {
    const sorted = [...scored].sort((a, b) => a.grade! - b.grade!);
    const median = sorted[Math.floor(sorted.length / 2)]!.grade!;
    expect(median, `median customer copy is grade ${median}`).toBeLessThanOrEqual(
      TARGET_GRADE,
    );
  });

  /**
   * Measured 2026-08-25, after US-2868's pass. A change may LOWER these and
   * never raise them. If a number drops well below its ceiling, lower the
   * ceiling in the same commit -- a ratchet nobody tightens stops working.
   *
   * Before the pass: 77 above grade 12, 22 above grade 15.
   */
  const CEILINGS: Array<[grade: number, max: number]> = [
    [12, 52],
    [15, 6],
  ];

  for (const [grade, max] of CEILINGS) {
    it(`no more than ${max} customer strings read above grade ${grade}`, () => {
      const over = scored.filter((r) => r.grade! > grade);
      const worst = over
        .sort((a, b) => b.grade! - a.grade!)
        .slice(0, 5)
        .map((r) => `\n    ${r.grade} ${r.file}:${r.line} ${r.text.slice(0, 80)}`)
        .join("");
      expect(
        over.length,
        `${over.length} customer strings read above grade ${grade} (ceiling ` +
          `${max}). Run: node scripts/check-copy-reading-level.mjs --all` +
          `${worst}`,
      ).toBeLessThanOrEqual(max);
    });
  }

  it("the ceilings are not quietly slack", () => {
    for (const [grade, max] of CEILINGS) {
      const over = scored.filter((r) => r.grade! > grade).length;
      expect(
        max - over,
        `the grade-${grade} ceiling is ${max - over} above the real count ` +
          `(${over}) -- lower it`,
      ).toBeLessThan(15);
    }
  });
});

describe("borrowed words are defined too (US-2868 AC2)", () => {
  it("eBay's and the trade's vocabulary is in the same glossary", async () => {
    // US-2864 defined what GradeThread INVENTED. A word it BORROWED is no more
    // knowable to a new seller, and a second glossary is how the two disagree.
    const { lookupTerm } = await import("@/lib/product-terms");
    for (const term of ["Item specifics", "SKU", "Provenance", "Taxonomy"]) {
      expect(lookupTerm(term), `${term} has no definition`).toBeDefined();
    }
  });

  it("'aspects' resolves to the item-specifics entry", async () => {
    // eBay's API says "aspects" and eBay's own UI says "item specifics". A
    // seller arriving with either word has to land somewhere.
    const { PRODUCT_TERMS } = await import("@/lib/product-terms");
    const entry = PRODUCT_TERMS.find((t) => t.term === "Item specifics");
    expect(entry).toBeDefined();
    const aliases = (entry as { aliases?: readonly string[] }).aliases ?? [];
    expect(aliases.map((a) => a.toLowerCase())).toContain("aspects");
  });
});
