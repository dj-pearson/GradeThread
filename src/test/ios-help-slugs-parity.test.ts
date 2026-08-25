import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PRODUCT_HELP_SLUGS } from "@/lib/help-slugs";

// US-2874 AC3.
//
// The story asks for "a generated Swift mirror of PRODUCT_HELP_SLUGS". There is
// no TypeScript-to-Swift generator in this repo, and the owner's note on
// US-2876 is explicit that a SECOND one-off generator is the thing to avoid --
// US-2864's AC6 was parked there for the same reason. So this uses the
// guarantee the repo already relies on for BuyerEntitlements.swift: a fenced
// table plus a test that reads the .swift as text. When US-2876's generator
// lands, HelpSlugs.swift becomes its output and this test keeps holding.
//
// The Python guard (ios/Scripts/check-help-slugs.py) checks the direction it
// CAN check without importing TypeScript: every Swift slug exists. This one
// checks the direction that needs the real registry: the two lists are the same
// list, in the same order.

const ROOT = process.cwd();
const SWIFT = "ios/GradeThread/Help/HelpSlugs.swift";
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");

/** Strip doc comments: the header names slugs while explaining itself. */
const stripComments = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/\/?.*$/gm, "");

function swiftCases(): Array<{ name: string; slug: string }> {
  const src = read(SWIFT);
  const fenced = src.slice(
    src.indexOf("// BEGIN GENERATED TABLE"),
    src.indexOf("// END GENERATED TABLE"),
  );
  return [...stripComments(fenced).matchAll(/case\s+(\w+)\s*=\s*"([a-z0-9-]+)"/g)].map(
    (m) => ({ name: m[1]!, slug: m[2]! }),
  );
}

describe("the Swift help slugs mirror the registry (US-2874 AC3)", () => {
  it("the fence exists and holds a table", () => {
    // Guards the guard: without the fence every assertion below reads an empty
    // string and passes, which looks exactly like agreement.
    const src = read(SWIFT);
    expect(src).toContain("// BEGIN GENERATED TABLE");
    expect(src).toContain("// END GENERATED TABLE");
    expect(swiftCases().length).toBeGreaterThan(20);
  });

  it("the slugs match, in the same order", () => {
    expect(swiftCases().map((c) => c.slug)).toEqual(
      PRODUCT_HELP_SLUGS.map((s) => s.slug),
    );
  });

  it("no slug is listed twice", () => {
    const slugs = swiftCases().map((c) => c.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  it("each case name is the slug in camelCase", () => {
    // Mechanical, so a hand-added entry cannot invent a name that reads fine
    // and no longer says which slug it is.
    for (const { name, slug } of swiftCases()) {
      const expected = slug
        .split("-")
        .map((part, i) => (i === 0 ? part : part[0]!.toUpperCase() + part.slice(1)))
        .join("");
      expect(name, `${slug} should be spelled ${expected}`).toBe(expected);
    }
  });
});

describe("the sheet matches the web's empty behaviour (US-2874 AC2)", () => {
  const sheet = stripComments(read("ios/GradeThread/Help/HelpSheet.swift"));

  it("a missing article renders nothing", () => {
    // US-2618: the web HelpLink renders NOTHING when the article table has no
    // row for the slug. A help button that opens an empty sheet is worse than
    // one that was never offered.
    expect(sheet).toContain("case missing");
    expect(sheet).toMatch(/if case \.notFound = error/);
    const branch = sheet.slice(sheet.indexOf("case .missing:"));
    expect(branch).toContain("dismiss()");
  });

  it("a 404 is not treated as a failure", () => {
    // Otherwise every slug without an article shows an error, which is how a
    // half-populated help table reads as a broken app.
    const load = sheet.slice(sheet.indexOf("func load("), sheet.indexOf("/// The question-mark"));
    const missingAt = load.indexOf("state = .missing");
    const failedAt = load.indexOf("state = .failed");
    expect(missingAt).toBeGreaterThan(-1);
    expect(failedAt).toBeGreaterThan(-1);
    expect(missingAt).toBeLessThan(failedAt);
  });

  it("it uses the app's own networking, not a bare URLSession", () => {
    // ios/Scripts/no-default-shared-session.py polices this too; asserting it
    // here means the failure names the reason rather than the pattern.
    expect(sheet).toContain("EdgeAPI");
    expect(sheet).not.toContain("URLSession(");
  });

  it("one sheet modifier, driven by one Identifiable", () => {
    // ios/Scripts/check-chained-sheets.py: a view has ONE sheet slot, and two
    // .sheet modifiers compete for it silently.
    expect((sheet.match(/\.sheet\(/g) ?? []).length).toBe(1);
    expect(sheet).toContain(".sheet(item:");
  });

  it("the slug is typed, never a bare string", () => {
    expect(sheet).toContain("let slug: HelpSlug");
    expect(sheet).toContain("init(slug: HelpSlug");
    // Scoped to the VIEWS. The decoded article legitimately carries a
    // `slug: String` off the wire, and a whole-file regex fired on that --
    // an assertion that fails on correct code is one that gets deleted.
    const views = sheet.slice(sheet.indexOf("struct HelpButton"));
    expect(
      /slug:\s*String/.test(views),
      "a view takes the slug as a String, so the compiler stops checking it",
    ).toBe(false);
  });
});

describe("the guard runs in both places (US-2874 AC4)", () => {
  it("the local lane runs it", () => {
    expect(read("scripts/verify.mjs")).toContain('"check-help-slugs.py"');
  });

  it("CI runs it", () => {
    expect(read(".github/workflows/ios-ci.yml")).toContain(
      "ios/Scripts/check-help-slugs.py",
    );
  });
});
