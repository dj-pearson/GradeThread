// A6: the theme tokens in src/index.css are hex (`--card: #ffffff`), so
// `hsl(var(--card))` computes to `hsl(#ffffff)`, which is invalid. The browser
// drops the declaration and a chart tooltip draws with no background and no
// border. 48 of these were live under src/ before A6 replaced them with the
// variable itself. This keeps the count at zero.
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = join(process.cwd(), "src");
const NEEDLE = "hsl(var(--";

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(tsx?|css)$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

describe("no hsl(var(--token)) under src/ (A6)", () => {
  it("finds zero occurrences", () => {
    const hits = walk(ROOT)
      .filter((f) => readFileSync(f, "utf8").includes(NEEDLE))
      .map((f) => relative(process.cwd(), f));
    expect(hits).toEqual([]);
  });

  it("the index.css tokens it guards against really are hex", () => {
    const css = readFileSync(join(ROOT, "index.css"), "utf8");
    expect(css).toMatch(/--card:\s*#[0-9a-f]{6}/i);
    expect(css).toMatch(/--border:\s*#[0-9a-f]{6}/i);
  });
});
