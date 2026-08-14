import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { marketplaceDisclosureFor } from "@/lib/marketplace-disclosure";

// US-2528, the follow-up the brief's own note promised: a guard so the Terms'
// extension language and the in-product disclosure cannot drift apart.
//
// The story itself is BLOCKED ON COUNSEL by its own AC5 ("it ships when counsel
// signs off on the copy"), and nothing here writes legal copy. What this does is
// make the drift impossible to introduce silently once counsel's copy lands,
// and pin the things that are already true today.
//
// Written to be honest in BOTH states: while the Terms carry no extension
// section it asserts that absence is still tracked as open work; the moment one
// appears it starts enforcing fact parity.

const TERMS = "src/pages/legal/terms.tsx";
const AUP = "src/pages/legal/acceptable-use.tsx";
const BRIEF = "docs/legal/terms-update-brief-2026-08.md";

function read(rel: string): string {
  return readFileSync(resolve(process.cwd(), rel), "utf8");
}

/**
 * The four MECHANISM facts every extension channel discloses.
 *
 * A platform may APPEND its own note (Poshmark's share caps, Grailed's manual
 * delist), which is why this reads the shortest channel's set rather than any
 * one channel's: the additions never replace the four, so the intersection IS
 * the four.
 */
function extensionFacts(): readonly string[] {
  const mercari = marketplaceDisclosureFor("mercari").facts;
  const poshmark = marketplaceDisclosureFor("poshmark").facts;
  // Everything Mercari says that Poshmark also says, with the marketplace name
  // normalised out so the two are comparable.
  const strip = (f: string) => f.replace(/Mercari|Poshmark/g, "{label}");
  const posh = new Set(poshmark.map(strip));
  return mercari.filter((f) => posh.has(strip(f)));
}

describe("the extension facts have one source (US-2528 AC3)", () => {
  it("there are exactly four, and they come from the disclosure module", () => {
    // US-2475 fixed the count and the order (risk first, then who owns it).
    // A Terms section that carried three of them would be the drift this guard
    // exists to catch.
    const facts = extensionFacts();
    expect(facts).toHaveLength(4);
    for (const f of facts) expect(typeof f).toBe("string");
  });

  it("the in-product page renders them from that module, not from copy", () => {
    const page = read("src/pages/flipdesk/marketplaces.tsx");
    expect(page).toContain("marketplaceDisclosureFor");
  });

  it("each fact names the marketplace rather than being generic", () => {
    // {label} substitution is what stops these becoming five per-channel
    // strings that drift independently.
    for (const f of marketplaceDisclosureFor("poshmark").facts) {
      expect(f).toContain("Poshmark");
    }
  });

  it("a per-platform note is APPENDED, never a replacement", () => {
    // The additions are what makes the count vary; the four must survive them.
    const poshmark = marketplaceDisclosureFor("poshmark").facts;
    const four = extensionFacts();
    expect(poshmark.length).toBeGreaterThan(four.length);
    // The four come FIRST and survive intact — a platform note cannot displace
    // one of them, only follow them.
    expect(
      poshmark.slice(0, four.length).map((f) => f.replace(/Poshmark/g, "{label}")),
      "a per-platform note displaced one of the four mechanism facts",
    ).toEqual(four.map((f) => f.replace(/Mercari|Poshmark/g, "{label}")));
  });
});

describe("the Terms' extension section, once it exists (US-2528 AC3)", () => {
  const termsMentionsExtension = () =>
    /\bextension\b/i.test(read(TERMS));

  it("is tracked as open work while it is absent", () => {
    // The absence is the gap counsel is being asked to close. Asserting it is
    // RECORDED keeps this guard truthful today instead of passing vacuously.
    if (termsMentionsExtension()) return;
    const brief = read(BRIEF);
    expect(brief).toMatch(/extension/i);
    const prd = JSON.parse(read("prd.json")) as {
      userStories: Array<{ id: string; passes: boolean }>;
    };
    const story = prd.userStories.find((s) => s.id === "US-2528");
    expect(story, "US-2528 is no longer open, but the Terms still say nothing")
      .toBeDefined();
    expect(story!.passes).toBe(false);
  });

  it("carries the same four facts as the product, once it does exist", () => {
    // This is the whole point of the guard. It starts enforcing the moment
    // counsel's copy lands, with no further work.
    if (!termsMentionsExtension()) return;
    const terms = read(TERMS);
    const missing = extensionFacts().filter((fact) => {
      // Match on the fact's distinctive claim rather than its exact wording —
      // counsel will rephrase, and they should be able to.
      const claim = fact
        .replace(/Mercari|Poshmark|{label}/g, "")
        .split(/[.!]/)[0]!
        .trim()
        .toLowerCase();
      const words = claim.split(/\s+/).filter((w) => w.length > 5).slice(0, 3);
      return !words.every((w) => terms.toLowerCase().includes(w));
    });
    expect(
      missing,
      "the Terms' extension section is missing facts the product already " +
        "discloses in marketplace-disclosure.ts:\n  " + missing.join("\n  "),
    ).toEqual([]);
  });
});

describe("the AUP is reviewed in the same pass (US-2528 AC4)", () => {
  it("both documents carry the same effective date", () => {
    const date = /effectiveDate="([^"]+)"/;
    const terms = date.exec(read(TERMS))?.[1];
    const aup = date.exec(read(AUP))?.[1];
    expect(terms, "terms has no effective date").toBeTruthy();
    expect(aup, `the AUP date (${aup}) has drifted from the Terms (${terms})`)
      .toBe(terms);
  });

  it("the automation clause is scoped to the Service, not to marketplaces", () => {
    // CORRECTION to the earlier brief note, which flagged the AUP's blanket
    // "scraping" prohibition as readable against our own Lister extension.
    // Re-reading it, both clauses are scoped to "the Service" — GradeThread —
    // while the extension automates the seller's own eBay/Poshmark session and
    // reads marketplace pages, not ours. So it is NOT a self-contradiction, and
    // counsel should not be billed for resolving one that does not exist.
    //
    // The scoping is the whole reason, so it is asserted rather than trusted.
    const aup = read(AUP);
    expect(aup).toMatch(
      /Do not access the Service through automated means except through\s*\n?\s*documented APIs/,
    );
    expect(aup).toMatch(
      /Do not scrape, harvest, or systematically copy content from the\s*\n?\s*Service/,
    );
  });
});

describe("the brief covers all four gaps (US-2528)", () => {
  it("each of the four shipped products counsel must cover is named", () => {
    const brief = read(BRIEF).toLowerCase();
    for (const gap of [
      "buyer",
      "app store",
      "google play",
      "extension",
      "consignment",
    ]) {
      expect(brief, `the brief never mentions ${gap}`).toContain(gap);
    }
  });

  it("nothing in it is wired to the live page yet", () => {
    // AC5: this ships when counsel signs off. Draft language reaching terms.tsx
    // before then would be the failure mode.
    const terms = read(TERMS);
    for (const phrase of ["buyer plan", "in-app purchase", "consignment"]) {
      expect(
        terms.toLowerCase(),
        `"${phrase}" is in the live Terms — did draft copy ship without sign-off?`,
      ).not.toContain(phrase);
    }
  });
});
