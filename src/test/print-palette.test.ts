import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// US-3235. A dark-mode certificate printed as a blank page.
//
// Dark mode sets --foreground to #fafafc, and browsers do not print background
// colours by default -- "Background graphics" ships OFF in Chrome and Safari.
// So near-white text landed on white paper, on the one page the whole product
// is built around handing to someone else. src/index.css had no @media print
// rule at all.
//
// The fix re-asserts the light values for `.dark` at print time. That is a
// MIRROR, and mirrors drift: the next token added to `.dark` would be
// white-on-white again, silently, and nobody prints a certificate in CI. This
// file is what makes that fail instead.

const css = readFileSync(resolve(process.cwd(), "src/index.css"), "utf8");

/** The body of the first `<selector> {` block at the top level of the file. */
function blockBody(selector: string, source = css): string {
  const at = source.indexOf(selector + " {");
  if (at === -1) throw new Error(`no block for ${selector}`);
  const open = source.indexOf("{", at);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}") {
      depth--;
      if (depth === 0) return source.slice(open + 1, i);
    }
  }
  throw new Error(`unterminated block for ${selector}`);
}

const tokensIn = (body: string): Set<string> =>
  new Set([...body.matchAll(/^\s*(--[a-z0-9-]+)\s*:/gm)].map((m) => m[1]!));

describe("printing is not a theme (US-3235)", () => {
  const printBlock = blockBody("@media print");
  const darkTokens = tokensIn(blockBody(".dark"));
  const rootTokens = tokensIn(blockBody(":root"));
  const printDarkTokens = tokensIn(blockBody(".dark", printBlock));

  it("found real blocks to compare (self-check)", () => {
    // If any of these come back thin the assertions below prove nothing.
    expect(darkTokens.size).toBeGreaterThan(25);
    expect(rootTokens.size).toBeGreaterThan(25);
    expect(printDarkTokens.size).toBeGreaterThan(25);
    expect(darkTokens.has("--foreground")).toBe(true);
  });

  it("the print block neutralizes every token dark mode overrides", () => {
    const unhandled = [...darkTokens].filter((t) => !printDarkTokens.has(t)).sort();
    expect(
      unhandled,
      "these are re-coloured for dark mode and left that way when printed, so " +
        "they land as light-on-white with Background graphics off. Add the " +
        ":root value for each to the @media print block in src/index.css:\n  " +
        unhandled.join("\n  "),
    ).toEqual([]);
  });

  it("the print values are the light ones, not invented", () => {
    // A mirror that drifts in VALUE is as broken as one that drifts in
    // coverage, and much harder to see.
    const rootBody = blockBody(":root");
    const valueOf = (body: string, token: string) =>
      body.match(new RegExp(`^\\s*${token}\\s*:\\s*([^;]+);`, "m"))?.[1]?.trim();

    const wrong: string[] = [];
    for (const token of printDarkTokens) {
      const light = valueOf(rootBody, token);
      const printed = valueOf(blockBody(".dark", printBlock), token);
      if (light && printed && light !== printed) {
        wrong.push(`${token}: print has ${printed}, :root has ${light}`);
      }
    }
    expect(wrong, wrong.join("\n  ")).toEqual([]);
  });

  it("forces a white sheet rather than trusting the browser", () => {
    expect(printBlock).toMatch(/background:\s*#ffffff\s*!important/);
  });
});
