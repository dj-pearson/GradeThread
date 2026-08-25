import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { PRODUCT_TERMS, lookupTerm, termsAlphabetical } from "@/lib/product-terms";
import type { ProductTerm } from "@/lib/product-terms";

// `PRODUCT_TERMS` is `as const satisfies`, so each entry narrows to its own
// literal type and an optional field is absent from the ones that omit it.
// Read it through the declared shape.
const TERMS: readonly ProductTerm[] = PRODUCT_TERMS;

// US-2864. GradeThread invented about twenty nouns and defined none of them in
// the product. FlipDesk, AutoLister, Snap to Value, MeasureCard, Scout,
// Prospect, Reconcile, Comp, Passport, Verified, Finds, Rewards, Trust Score,
// Thrift Radar, Consignment, Drop. Every one was taught by being clicked.
//
// The public glossary at /grading/glossary covers GRADING words (pilling,
// crocking, hand) and none of these.

const ROOT = process.cwd();
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");

describe("the term registry (US-2864)", () => {
  it("covers the invented vocabulary", () => {
    // The list this story was filed against. Missing one means a word the
    // product uses in anger and defines nowhere.
    const REQUIRED = [
      "FlipDesk",
      "AutoLister",
      "Snap to Value",
      "MeasureCard",
      "Scout",
      "Prospect",
      "Sourcing",
      "Reconcile",
      "Comp",
      "Passport",
      "Verified",
      "Finds",
      "Rewards",
      "Trust Score",
      "Thrift Radar",
      "Consignment",
    ];
    for (const term of REQUIRED) {
      expect(lookupTerm(term), `${term} has no definition`).toBeDefined();
    }
  });

  it("no term is defined twice", () => {
    const names = TERMS.map((t) => t.term);
    expect(new Set(names).size).toBe(names.length);
  });

  it("every definition is ONE plain sentence", () => {
    for (const t of TERMS) {
      expect(t.definition.endsWith("."), `${t.term}: not a sentence`).toBe(true);
      expect(
        t.definition.length,
        `${t.term}: too short to define anything`,
      ).toBeGreaterThan(30);
      expect(
        t.definition.length,
        `${t.term}: a popover is not a paragraph`,
      ).toBeLessThanOrEqual(160);
    }
  });

  it("no definition uses the word it is defining", () => {
    // "A Comp is a comp for your item" teaches nothing, and it is the easiest
    // definition to write by accident.
    for (const t of TERMS) {
      const head = t.term.split(" ")[0]!.toLowerCase();
      // Only the FIRST word, and only as a whole word: "Sourcing" may say
      // "source", and "Reconcile" may not say "reconcile".
      const re = new RegExp(`\\b${head}\\b`, "i");
      expect(
        re.test(t.definition),
        `"${t.term}" is defined using its own name: "${t.definition}"`,
      ).toBe(false);
    }
  });

  it("no definition leans on another invented word without defining it", () => {
    // A definition that needs a second invented noun to make sense has moved
    // the problem rather than solved it. Naming one is fine when it is a
    // pointer, so this only bans the case where the OTHER word carries the
    // whole meaning: a definition of five words or fewer around it.
    for (const t of TERMS) {
      const others = TERMS.filter((o) => o.term !== t.term);
      const leaned = others.filter(
        (o) =>
          t.definition.includes(o.term) && t.definition.split(/\s+/).length < 12,
      );
      expect(
        leaned.map((o) => o.term),
        `"${t.term}" is defined almost entirely in terms of another made-up word`,
      ).toEqual([]);
    }
  });

  it("every `to` is an in-app path, not an external link", () => {
    for (const t of TERMS) {
      if (!t.to) continue;
      expect(t.to.startsWith("/"), `${t.term} -> ${t.to}`).toBe(true);
    }
  });

  it("the alphabetical list is complete and sorted", () => {
    const sorted = termsAlphabetical();
    expect(sorted.length).toBe(TERMS.length);
    const names = sorted.map((t) => t.term);
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));
  });
});

describe("the definitions are reachable (US-2864)", () => {
  it("the glossary page renders the whole registry", () => {
    const page = read("src/pages/glossary.tsx");
    expect(page).toContain("termsAlphabetical()");
    // Rendered from the registry, not retyped — a second copy would go stale.
    expect(page).toContain("{t.definition}");
    expect(
      /PRODUCT_TERMS\s*=/.test(page),
      "the glossary must read the registry, not declare its own list",
    ).toBe(false);
  });

  it("the glossary route is registered BEFORE the article slug route", () => {
    // /dashboard/help/:slug would otherwise swallow "glossary" and render the
    // reader's not-found for it.
    const routes = read("src/routes/index.tsx");
    const glossary = routes.indexOf('path: "/dashboard/help/glossary"');
    const slug = routes.indexOf('path: "/dashboard/help/:slug"');
    expect(glossary, "the glossary route is missing").toBeGreaterThan(-1);
    expect(slug).toBeGreaterThan(-1);
    expect(
      glossary < slug,
      "put the glossary route above /dashboard/help/:slug",
    ).toBe(true);
  });

  it("the help index links to it", () => {
    expect(read("src/pages/help-reader.tsx")).toContain(
      '/dashboard/help/glossary',
    );
  });

  it("the popover offers the full list too", () => {
    expect(read("src/components/help/term.tsx")).toContain(
      "/dashboard/help/glossary",
    );
  });
});

describe("<Term> is used, and is keyboard-reachable (US-2864)", () => {
  function walk(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir)) {
      const p = join(dir, entry);
      if (statSync(p).isDirectory()) {
        walk(p, out);
        continue;
      }
      if (/\.tsx$/.test(entry) && !/\.test\.tsx$/.test(entry)) {
        out.push(relative(ROOT, p).replace(/\\/g, "/"));
      }
    }
    return out;
  }

  const uses = walk(resolve(ROOT, "src")).flatMap((f) =>
    [...read(f).matchAll(/<Term\s+name="([^"]+)"/g)].map((m) => ({
      file: f,
      name: m[1]!,
    })),
  );

  it("is actually wired somewhere", () => {
    // A registry and a component nobody renders is a glossary with no way in
    // from the product, which is the state this story started from.
    expect(uses.length, "no <Term> in the app").toBeGreaterThanOrEqual(4);
  });

  it("every use names a registered term", () => {
    const unknown = uses.filter((u) => !lookupTerm(u.name));
    expect(
      unknown.map((u) => `${u.name} (${u.file})`),
      "these <Term> names are not in PRODUCT_TERMS, so they render as plain text",
    ).toEqual([]);
  });

  it("the trigger is a button, not a span", () => {
    // A hover card on a <span> is invisible to anyone not using a mouse — which
    // is most of the people who do not already know the word.
    const src = read("src/components/help/term.tsx");
    expect(src).toContain("<button");
    expect(src).toContain("aria-label=");
    expect(
      src.includes("if (!entry) return"),
      "an unregistered term must degrade to plain text, not to a dead control",
    ).toBe(true);
  });
});
