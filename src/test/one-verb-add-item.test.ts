import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

// US-2860. One action -- put a garment into inventory -- carried four labels on
// the web ("Add item", "Add an item", "New item", "Intake an item") and two
// more sets on iOS, where the Add-tab dialog and the Home-toolbar menu named
// the SAME three intake routes differently from each other.
//
// The verb is "Add item". Where an entry point picks a mode, the mode is a
// qualifier and never a competing verb: "Photos first", "Details first",
// "Bulk with AI". "Take photos" is a different verb, and a user reading it
// after reading "Add item" does not know they are the same action.
//
// The vault note is vault/20-domain/one-verb-add-item.md.

const ROOT = process.cwd();
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");

/** Every .ts/.tsx under src/, minus tests (which must name the retired forms). */
function webSources(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const p = join(dir, entry);
      if (statSync(p).isDirectory()) {
        if (entry === "node_modules" || entry === "dist") continue;
        walk(p);
        continue;
      }
      if (!/\.tsx?$/.test(entry)) continue;
      if (/\.test\.tsx?$/.test(entry)) continue;
      if (p.includes(`${join("src", "test")}`)) continue;
      out.push(relative(ROOT, p).replace(/\\/g, "/"));
    }
  };
  walk(resolve(ROOT, "src"));
  return out;
}

// The retired label forms, as they appear in a CONTROL: a JSX text node, a
// `label:`/`cta:`/`title:` field, or a heading. Deliberately NOT a bare
// substring match -- prose like "Add an item to get started." is correct
// English in a sentence and is not what this guard is about.
const RETIRED: Array<{ label: string; re: RegExp }> = [
  {
    label: '"New item" as a control',
    re: /(?:^\s*New item\s*$|>New item<|(?:label|cta|title):\s*"New item")/m,
  },
  {
    label: '"Add an item" as a control',
    re: /(?:^\s*Add an item\s*$|>Add an item<|(?:label|cta|title):\s*"Add an item")/m,
  },
  {
    label: '"Intake an item" anywhere',
    re: /Intake an item/,
  },
];

const files = webSources();

describe("one verb for adding an item, on the web (US-2860)", () => {
  it("the scan is reading real files", () => {
    expect(files.length).toBeGreaterThan(300);
    expect(files.some((f) => f.endsWith("pages/flipdesk/intake.tsx"))).toBe(true);
  });

  for (const { label, re } of RETIRED) {
    it(`no source uses ${label}`, () => {
      const offenders = files.filter((f) => {
        const src = read(f)
          // A comment naming the retired form while explaining the rename is
          // not a control the user can read.
          .replace(/\/\/[^\n]*/g, "")
          .replace(/\/\*[\s\S]*?\*\//g, "")
          .replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
        return re.test(src);
      });
      expect(
        offenders,
        `the verb is "Add item". These files still use ${label}. Prose inside a ` +
          "sentence is fine and is not matched here; a button, heading, or a " +
          "label/cta/title field is not.",
      ).toEqual([]);
    });
  }

  it("the canonical label is actually in use", () => {
    // Without this the three assertions above pass on a codebase that renamed
    // every entry point out of existence.
    const users = files.filter((f) => /"Add item"|>Add item</.test(read(f)));
    expect(
      users.length,
      "nothing uses the canonical label -- either the entry points are gone, or " +
        "the patterns above stopped matching and this file is decorative.",
    ).toBeGreaterThanOrEqual(5);
  });
});

describe("iOS names the same modes the same way (US-2860)", () => {
  const ios = read("ios/GradeThread/ContentView.swift");

  it("the verb is Add item in all four places it is spoken", () => {
    for (const site of [
      '"Add item",', // the Add-tab confirmation dialog title
      'Label("Add item", systemImage: "plus.circle.fill")', // the Add tab
      'primaryLabel: "Add item"', // the iPad sidebar toolbar
      '.accessibilityLabel("Add item")', // the compact "+" menu
    ]) {
      expect(ios, `iOS lost the verb at: ${site}`).toContain(site);
    }
  });

  it("the two mode choosers agree, and neither invents a verb", () => {
    for (const mode of ["Photos first", "Details first", "Bulk with AI"]) {
      const hits = (ios.match(new RegExp(`"${mode}"`, "g")) ?? []).length;
      expect(
        hits,
        `"${mode}" should appear TWICE -- once in the Add-tab dialog and once ` +
          `in the Home-toolbar menu. Found ${hits}. Two choosers for the same ` +
          "three routes is how six names for three things happened.",
      ).toBe(2);
    }
  });

  it("the Siri phrases are deliberately exempt, and stay that way", () => {
    // Speech is a different register. Nobody says "add item to GradeThread"
    // out loud, and a phrase that is DELETED stops matching the shortcuts
    // people have already saved. So the App Intent gained the product's
    // phrasing rather than swapping to it. Asserted, not left to a comment,
    // because "tidy up the retired wording" is exactly what a later pass over
    // this rename would do to them.
    const intents = read("ios/GradeThread/Intents/GradeThreadAppIntents.swift");
    for (const phrase of [
      '"Add an item to \\(.applicationName)"',
      '"Add an item with \\(.applicationName)"',
      '"New item in \\(.applicationName)"',
      '"Add item to \\(.applicationName)"',
    ]) {
      expect(
        intents.includes(phrase),
        `the Siri phrase ${phrase} was removed. Removing one breaks the saved ` +
          "shortcuts that use it; this list only ever grows.",
      ).toBe(true);
    }
    // The action NAME, which a user reads in the Shortcuts app, follows the
    // product's verb even though the spoken phrases do not.
    expect(intents).toContain(
      'static var title: LocalizedStringResource = "Add Item"',
    );
    expect(intents).toContain('shortTitle: "Add Item",');
  });

  it("the retired iOS wording is gone", () => {
    for (const gone of [
      "Photo-first (Snap & Catalog)",
      "Details-first (manual form)",
      "Take photos",
      "Type details",
      "Bulk list with AI",
      '"Add an item"',
    ]) {
      expect(ios.includes(gone), `iOS still says: ${gone}`).toBe(false);
    }
  });
});
