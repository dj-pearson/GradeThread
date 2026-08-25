import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * A NavLink render-prop className inside a Radix `asChild` slot renders as
 * its own source text.
 *
 * The sidebar's desktop rows are wrapped in `<TooltipTrigger asChild>`, and
 * Radix's Slot merges className by string-joining the parent's onto the
 * child's. React Router's `className={({ isActive }) => ...}` is a FUNCTION,
 * so the join stringified it and the browser received the function body as a
 * class list. Every token that happened to follow a space stayed a real class
 * -- `items-center`, `gap-3`, `text-sm` -- while `flex` was glued to the
 * opening backtick and was lost. The whole sidebar rendered each icon on one
 * line and its label on the next, and nothing failed: not tsc, not eslint,
 * not a render test, because the element and the text were all still there.
 *
 * The rule is per-file rather than per-element on purpose. Matching "a
 * function className nested inside an asChild" needs a parser, and the cheap
 * version -- a file may not contain both -- costs nothing real: compute the
 * active state from `useLocation()` and pass a string.
 */
const SRC = "src";
const NEEDLE = "className={({";

function tsxFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === "node_modules" || e.name === "components/ui") continue;
      out.push(...tsxFiles(p));
    } else if (e.name.endsWith(".tsx")) {
      out.push(p);
    }
  }
  return out;
}

describe("render-prop className inside an asChild slot", () => {
  const files = tsxFiles(SRC).filter((f) => !f.includes(join("components", "ui")));

  it("finds files to scan", () => {
    expect(files.length).toBeGreaterThan(100);
  });

  it("no file mixes asChild with a function className", () => {
    const offenders = files.filter((f) => {
      const src = readFileSync(f, "utf8");
      return src.includes("asChild") && src.includes(NEEDLE);
    });
    expect(
      offenders,
      "Radix Slot string-joins className, so a function className is stringified into the DOM. Compute the active state with useLocation() and pass a string.",
    ).toEqual([]);
  });

  it("the dashboard sidebar passes a string className to every NavLink", () => {
    const src = readFileSync(
      join(SRC, "components", "dashboard", "sidebar.tsx"),
      "utf8",
    );
    expect(src.includes(NEEDLE)).toBe(false);
    // The class that was silently dropped. If this row stops being a flex row
    // the layout is back to icon-above-label.
    expect(src).toContain('"flex items-center gap-3 rounded-lg px-3 py-2.5');
  });
});
