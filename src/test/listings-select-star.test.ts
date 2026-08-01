// US-2177 AC3: `select("*")` on the 91-column `listings` table is declared, not
// assumed.
//
// The cost of this table is the WIDTH of its reads. A `select("*")` multiplied
// by a page of rows is exactly what US-2167 spent a story removing; a
// `select("*")` for ONE row is one row. So the rule is not "never" — it is
// "bounded, and say why", because an unbounded one has no runtime symptom
// beyond the page getting slower as an account grows.
//
// Enforced by ENUMERATION rather than by a pattern. Every existing call site is
// declared below with its justification, and the scan asserts the declared set
// is the whole set — so a new `select("*")` fails here until its author adds it
// and states which bound it carries. That is the moment the decision gets made,
// instead of never.
//
// The full inventory and the read policy live in
// vault/20-domain/listings-column-inventory.md.

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { resolve, join } from "node:path";

const ROOTS = ["src", "services/edge-functions/src", "functions"];

interface DeclaredStar {
  readonly file: string;
  /** The bound that makes an unprojected read acceptable here. */
  readonly bound: string;
  readonly why: string;
}

const DECLARED: readonly DeclaredStar[] = [
  {
    file: "src/pages/flipdesk/composer.tsx",
    bound: ".maybeSingle()",
    why: "the composer canvas renders ONE listing and reads across its width",
  },
  {
    file: "src/pages/inventory-detail.tsx",
    bound: '.eq("inventory_item_id"',
    why: "one item's listings — a handful of rows, all columns rendered",
  },
  {
    file: "services/edge-functions/src/lib/data-export.ts",
    bound: '.eq("user_id"',
    why:
      "the account data export MUST stay unprojected: a projection would " +
      "silently omit columns from a record the user is entitled to, and the " +
      "export would still look complete",
  },
];

function walk(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    // Guards quote the call shape they scan for; including them makes this
    // test find itself.
    if (name === "node_modules" || name === "dist") continue;
    if (name === "test" || name === "tests" || name === "__tests__") continue;
    const full = join(dir, name);
    if (/\.(test|spec)\.[tj]sx?$/.test(name)) continue;
    if (/\.(tsx?|mjs)$/.test(name)) out.push(full);
    else if (!name.includes(".")) walk(full, out);
  }
  return out;
}

/** Files that read `listings` with an unprojected select. */
function starReaders(): string[] {
  const hits: string[] = [];
  for (const root of ROOTS) {
    for (const file of walk(resolve(process.cwd(), root))) {
      const src = readFileSync(file, "utf8");
      // Both shapes in this repo: a chained `.from("listings")\n.select("*")`,
      // and the single-line `db.from("listings").select("*")`.
      const chained = /from\("listings"\)[\s\S]{0,80}?\.select\("\*"\)/.test(src);
      if (chained) hits.push(file.slice(process.cwd().length + 1).replace(/\\/g, "/"));
    }
  }
  return [...new Set(hits)].sort();
}

describe("every unprojected listings read is declared (US-2177)", () => {
  it("has no undeclared select(*) on listings", () => {
    // The assertion the whole guard rests on. A new one fails here, and the fix
    // is to add it to DECLARED with the bound it carries.
    expect(starReaders()).toEqual(DECLARED.map((d) => d.file).sort());
  });

  it.each(DECLARED)("$file is bounded: $why", ({ file, bound }) => {
    const src = readFileSync(resolve(process.cwd(), file), "utf8");
    expect(src).toContain(bound);
  });

  it("keeps the data export unprojected on purpose", () => {
    // Stated as its own case because the OBVIOUS "fix" here — projecting it
    // like the others — is the bug. The omission would be invisible.
    const src = readFileSync(
      resolve(process.cwd(), "services/edge-functions/src/lib/data-export.ts"),
      "utf8",
    );
    expect(src).toContain('from("listings").select("*")');
  });

  it("keeps the list reads projected", () => {
    // The two surfaces that render PAGES of listings. If either ever falls back
    // to `*`, the 91-column width lands on every row again.
    const listings = readFileSync(
      resolve(process.cwd(), "src/pages/flipdesk/listings-columns.ts"),
      "utf8",
    );
    expect(listings).toContain("export const LISTINGS_COLUMNS");
    const bulk = readFileSync(
      resolve(process.cwd(), "src/pages/flipdesk/bulk-pricing.tsx"),
      "utf8",
    );
    expect(bulk).not.toMatch(/from\("listings"\)[\s\S]{0,80}?\.select\("\*"\)/);
  });
});
