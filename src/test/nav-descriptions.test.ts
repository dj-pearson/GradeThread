import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// US-2861. The sidebar offered twenty-three destinations and said nothing about
// any of them: Sourcing, Verified, Offers & Messages, Money, Pricing,
// MeasureCard. A seller who has never used the product cannot tell Sourcing
// from Scout or Money from Pricing by reading those words. The iOS Tools hub
// has carried a written one-line explanation for every module since US-749, and
// the web nav did not use them.
//
// `description` is a REQUIRED field on NavItem, so tsc already catches a new
// entry with none. This file guards the parts a type cannot: that the field
// stays required, that the sentences are sentences, and that they are actually
// rendered rather than merely stored.

const FILE = "src/components/dashboard/sidebar.tsx";
const src = readFileSync(resolve(process.cwd(), FILE), "utf8");

/** Everything inside the `navGroups` literal. */
function navGroupsBody(): string {
  const start = src.indexOf("const navGroups: NavGroup[] = [");
  expect(start, "navGroups literal not found").toBeGreaterThan(-1);
  // The literal ends at the first line that is exactly "];" at column 0.
  const end = src.indexOf("\n];", start);
  expect(end, "end of navGroups literal not found").toBeGreaterThan(start);
  return src.slice(start, end);
}

const body = navGroupsBody();

const labels = [...body.matchAll(/^\s*label: "([^"]+)",$/gm)].map((m) => m[1]!);
const titles = [...body.matchAll(/^\s*title: "([^"]+)",$/gm)].map((m) => m[1]!);
const descriptions = [...body.matchAll(/^\s*description: "([^"]+)",$/gm)].map(
  (m) => m[1]!,
);

describe("the NavItem contract keeps descriptions required (US-2861)", () => {
  it("NavItem.description is required, not optional", () => {
    expect(
      /\n\s*description: string;/.test(src),
      "NavItem.description must stay `description: string;`. Making it optional " +
        "(`description?:`) removes the only thing forcing a new nav entry to " +
        "explain itself, which is how twenty-three of them ended up unexplained.",
    ).toBe(true);
    expect(/\n\s*description\?: string;\s*\n\s*\/\/ A group renders/.test(src)).toBe(
      true,
    ); // NavGroup's is optional on purpose: one group has no title.
  });

  it("NavSubgroup.description is required", () => {
    expect(src).toContain(
      "type NavSubgroup = { title: string; description: string; items: NavItem[] };",
    );
  });
});

describe("every nav entry and titled section explains itself (US-2861)", () => {
  it("there is one description per label plus one per titled section", () => {
    expect(labels.length, "no nav labels parsed").toBeGreaterThan(15);
    expect(titles.length, "no section titles parsed").toBeGreaterThan(3);
    expect(
      descriptions.length,
      `expected ${labels.length} item descriptions + ${titles.length} section ` +
        `descriptions = ${labels.length + titles.length}, found ${descriptions.length}. ` +
        "An entry or a section is missing its sentence.",
    ).toBe(labels.length + titles.length);
  });

  for (const [i, d] of descriptions.entries()) {
    it(`description ${i + 1} is one plain sentence: "${d.slice(0, 40)}..."`, () => {
      expect(d.endsWith("."), `"${d}" should end with a full stop`).toBe(true);
      // A second ". " means a second sentence. One idea per entry.
      expect(
        d.slice(0, -1).includes(". "),
        `"${d}" is two sentences. A nav entry gets one.`,
      ).toBe(false);
      expect(d.length, `"${d}" is too long for a tooltip`).toBeLessThanOrEqual(90);
      expect(d.length, `"${d}" is too short to say anything`).toBeGreaterThan(20);
    });
  }

  it("no description just restates its own label", () => {
    for (const label of labels) {
      const restated = descriptions.some(
        (d) => d.replace(/\.$/, "").toLowerCase() === label.toLowerCase(),
      );
      expect(restated, `"${label}" is described by its own name`).toBe(false);
    }
  });
});

describe("the descriptions are rendered, not just stored (US-2861)", () => {
  // The most ordinary way a guard like this goes quiet: the data is present,
  // the assertions pass, and nothing puts it on screen.
  it("nav items render their description on both desktop and mobile", () => {
    // TWO renders, not one: the mobile inline line and the desktop tooltip.
    // Checking only that the string appears somewhere passes when either half
    // is deleted, which is exactly the failure this test exists to catch.
    const uses = src.match(/\{item\.description\}/g) ?? [];
    expect(
      uses.length,
      "expected {item.description} twice — once inline for the mobile sheet, " +
        `once inside the desktop TooltipContent. Found ${uses.length}.`,
    ).toBe(2);
    expect(src, "desktop path must put it in a tooltip").toMatch(
      /TooltipContent[\s\S]{0,120}\{item\.description\}/,
    );
    expect(
      src,
      "mobile path must render it inline, under the label",
    ).toMatch(/\{item\.label\}<\/span>[\s\S]{0,300}\{item\.description\}/);
  });

  it("section headers render their description", () => {
    expect(src).toContain("description: group.description,");
    expect(src).toContain("description: sg.description,");
    expect(src).toContain("{args.description}");
  });

  it("the mobile sheet asks for the inline variant", () => {
    expect(src).toContain('variant="mobile"');
    expect(
      /variant === "mobile"/.test(src),
      "SidebarNav must branch on the variant, or the mobile sheet renders the " +
        "desktop hover-only path and a phone user still sees nothing.",
    ).toBe(true);
  });
});
