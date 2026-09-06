import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { resolve, join } from "node:path";
import { COMPARISONS } from "../comparison-guides";
import { BUYING_GUIDES } from "../buying-guides";
import { RESELLING_GUIDES } from "../reselling-guides";
import { PLATFORM_STANDARDS } from "../platform-standards";
import { MARKETPLACE_SPECS } from "@/lib/marketplace-specs";

// US-3091. One fee, one set of condition names, five surfaces.
//
// Vinted's numbers now appear on /compare/vinted-*, /reselling/how-to-sell-on-
// vinted, /reselling/vinted-scams-and-disputes, /buying/is-vinted-legit and
// /grading/platform-standards/vinted, plus the composer's own dropdown in
// marketplace-specs.ts. Every one of those was written on a different day from
// a different reading, and two of them were WRONG in the same way.
//
// ⚠ THE CONDITION NAMES WERE WRONG IN FOUR PLACES. "New with tags" and "New
// without tags" are eBay's and Poshmark's vocabulary. Vinted's own options are
// New / Like new / Very good / Good / Satisfactory, and its two unworn options
// split on PACKAGING rather than tags. Three were corrected on 2026-09-05 and
// the fourth was found afterwards, in comparison-guides.ts, by looking for it
// on purpose. That is the failure this file exists to stop: a plausible string
// copied from the platform next door reads exactly like one somebody checked.
//
// ⚠ AND THE FEE WAS STATED AT TWO DIFFERENT CONFIDENCE LEVELS. The comparison
// pages said "usually 5% + $0.70", carrying a help page's hedge, while the three
// guides said "$0.70 plus 5%" flatly from vinted.com/pricelist — the US fee
// schedule. Same site, same fee, two answers.

const ROOT = resolve(process.cwd(), "src");

/** Every .ts/.tsx under src/, so a NEW surface is covered the day it lands. */
function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === "node_modules" || entry === "__tests__" || entry === "test") continue;
      sourceFiles(full, out);
    } else if (/\.tsx?$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

/** Source with comments stripped, so a guard cannot fire on its own rationale. */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .split("\n")
    .map((l) => {
      const i = l.search(/(^|[^:])\/\//);
      return i === -1 ? l : l.slice(0, i);
    })
    .join("\n");
}

describe("Vinted's condition options are Vinted's, everywhere (US-3091)", () => {
  it("no surface describes them with eBay's tag vocabulary", () => {
    // Scoped to text that is ABOUT Vinted: eBay genuinely does offer "New with
    // tags", and /sell-used-clothes-ebay says so correctly. A blanket ban on the
    // phrase would be a guard that fires on the truth.
    const offenders: string[] = [];
    for (const file of sourceFiles(ROOT)) {
      const src = stripComments(readFileSync(file, "utf8"));
      for (const line of src.split("\n")) {
        if (!/vinted/i.test(line)) continue;
        if (/new with(out)? tags/i.test(line)) {
          offenders.push(`${file.replace(process.cwd(), "")}: ${line.trim().slice(0, 100)}`);
        }
      }
    }
    expect(offenders, offenders.join("\n")).toEqual([]);
  });

  it("the composer's dropdown offers exactly what Vinted offers", () => {
    // This is the one a seller acts on: they pick from it and then look for the
    // same words on Vinted's own form.
    expect(MARKETPLACE_SPECS.vinted.conditions.map((c) => c.value)).toEqual([
      "New",
      "Like new",
      "Very good",
      "Good",
      "Satisfactory",
    ]);
  });

  it("the prose surfaces name the same five", () => {
    const standards = PLATFORM_STANDARDS.find((p) => p.slug === "vinted");
    expect(standards).toBeTruthy();
    expect(standards!.definition).toContain("Like new");
    expect(standards!.definition).not.toMatch(/new with(out)? tags/i);

    // The condition wording reaches the page through the comparison sections,
    // so it is checked there rather than in the private facts map.
    const vintedPages = COMPARISONS.filter((c) => /vinted/.test(c.slug));
    expect(vintedPages.length).toBeGreaterThan(0);
    for (const cmp of vintedPages) {
      const prose = [
        ...cmp.rows.map((r) => `${r.a} ${r.b}`),
        ...cmp.sections.map((x) => x.body),
      ].join(" ");
      expect(prose, `compare/${cmp.slug}`).not.toMatch(/new with(out)? tags/i);
    }
  });
});

describe("Vinted's buyer-protection fee is one number, stated once (US-3091)", () => {
  // The figure from vinted.com/pricelist, read 2026-09-05: a fixed $0.70 plus
  // 5% of the item price, shipping excluded.
  const FEE_SURFACES = () => {
    const out: Array<{ where: string; text: string }> = [];
    // Read off the BUILT comparison rows rather than the private facts map, so
    // the assertion is on what the page renders. PLATFORM_FACTS is not exported
    // and does not need to be for this.
    for (const cmp of COMPARISONS) {
      if (!/vinted/.test(cmp.slug)) continue;
      const feeRow = cmp.rows.find((r) => r.dimension === "Selling fees");
      if (!feeRow) continue;
      const side = cmp.slug.startsWith("vinted-") ? feeRow.a : feeRow.b;
      out.push({ where: `compare/${cmp.slug} fee row`, text: side });
    }
    for (const g of RESELLING_GUIDES) {
      if (!/vinted/i.test(g.slug)) continue;
      out.push({
        where: `reselling/${g.slug}`,
        text: [g.intro, ...g.sections.map((s) => s.body), ...g.faqs.map((f) => f.a)].join(" "),
      });
    }
    for (const g of BUYING_GUIDES) {
      if (!/vinted/i.test(g.slug)) continue;
      out.push({
        where: `buying/${g.slug}`,
        text: [g.answer, ...g.sections.map((s) => s.body), ...g.faqs.map((f) => f.a)].join(" "),
      });
    }
    return out;
  };

  it("every surface that states the fee states the same two numbers", () => {
    for (const { where, text } of FEE_SURFACES()) {
      if (!/buyer protection fee/i.test(text)) continue;
      expect(text, `${where} states the fee without the $0.70`).toMatch(/\$0\.70/);
      expect(text, `${where} states the fee without the 5%`).toMatch(/5%/);
    }
  });

  it("⚠ and none of them hedges it, because the price list does not", () => {
    // "usually 5% + $0.70" carried a support article's hedge onto pages that
    // compare it against Poshmark's flat 20%. The US price list — the fee
    // schedule, not a help answer — states it without one, and a hedge on one
    // side of a comparison reads as the uncertain option.
    for (const { where, text } of FEE_SURFACES()) {
      if (!/buyer protection fee/i.test(text)) continue;
      const hedged = /(usually|around|about|roughly|approximately)\s+[^.]{0,24}(5%|\$0\.70)/i;
      expect(hedged.test(text), `${where} hedges a figure the price list states flatly`).toBe(false);
    }
  });

  it("the fee is never described as something the SELLER pays", () => {
    // The whole comparative point of Vinted is that this one sits on the buyer's
    // side. Getting it backwards would invert the conclusion of four pages.
    for (const { where, text } of FEE_SURFACES()) {
      if (!/buyer protection fee/i.test(text)) continue;
      expect(
        /seller pays a buyer protection|buyer protection fee[^.]{0,40}(from|charged to) the seller/i.test(text),
        `${where} puts the buyer protection fee on the seller`,
      ).toBe(false);
    }
  });
});
