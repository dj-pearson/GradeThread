import { describe, it, expect } from "vitest";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

import {
  narrowCss,
  classesIn,
  classesOf,
  // @ts-expect-error - plain .mjs helper, no type declarations
} from "../../scripts/lib/narrow-css.mjs";

/**
 * US-3013: the narrower is what makes the authed UI harness trustworthy.
 *
 * `impeccable detect <url>` reads the page's STYLESHEET, not only its computed
 * styles, so three of its rules fire on a utility DEFINITION the page never
 * uses. Handing it the whole app stylesheet meant every authed page came back
 * carrying findings that belonged to src/index.css - which is what sank the
 * first attempt at that harness (US-2999).
 *
 * ⚠ THE FAILURE MODE IS ASYMMETRIC. Keeping a rule the page cannot reach
 * reports a finding nobody can act on; dropping one it CAN reach hides a real
 * one. So the tests below check both directions, and the ones that matter most
 * are the ones asserting a rule SURVIVES.
 */
describe("classesOf", () => {
  it("unescapes Tailwind's variants, which is the whole job", () => {
    // A selector for `md:flex` is written `.md\:flex`. Reading it as "md"
    // would match a class nobody has, and drop the rule.
    expect(classesOf(".md\\:flex")).toEqual(["md:flex"]);
    expect(classesOf(".w-1\\/2")).toEqual(["w-1/2"]);
    expect(classesOf(".p-\\[13px\\]")).toEqual(["p-[13px]"]);
  });

  it("finds every class in a compound selector", () => {
    expect(classesOf(".a .b > .c")).toEqual(["a", "b", "c"]);
    expect(classesOf(".group:hover .child")).toEqual(["group", "child"]);
  });

  it("returns nothing for a selector that names no class", () => {
    expect(classesOf(":root")).toEqual([]);
    expect(classesOf("html, body")).toEqual([]);
    expect(classesOf("*, ::before")).toEqual([]);
  });
});

describe("classesIn", () => {
  it("reads both quote styles", () => {
    const used = classesIn(`<div class="a b"><span class='c'></span></div>`);
    expect([...used].sort()).toEqual(["a", "b", "c"]);
  });
});

describe("narrowCss", () => {
  const css = `
    :root { --x: 1px }
    .used { color: red }
    .unused { color: blue }
    .used .also-used { color: green }
    .used .not-here { color: pink }
    @media (min-width: 40rem) { .used { padding: 1px } .unused { padding: 2px } }
    @keyframes spin { to { transform: rotate(360deg) } }
  `;
  const used = new Set(["used", "also-used"]);
  const out = narrowCss(css, used);

  it("keeps a rule every one of whose classes is on the page", () => {
    expect(out).toContain(".used");
    expect(out).toContain(".also-used");
  });

  it("drops a rule naming a class the page does not have", () => {
    expect(out).not.toContain(".unused");
    expect(out).not.toContain(".not-here");
  });

  it("keeps selectors that name no class at all", () => {
    // `:root` carries the design tokens. Dropping it makes every colour
    // resolve to nothing and the page renders unstyled, which reports clean.
    expect(out).toContain(":root");
  });

  it("recurses into at-rules and drops one that empties out", () => {
    expect(out).toContain("@media");
    expect(out.match(/@media/g)).toHaveLength(1);
  });

  it("passes @keyframes through whole", () => {
    // It holds declarations, not selectors. Dropping an animation's frames
    // would SILENCE a rule rather than remove a false positive.
    expect(out).toContain("@keyframes spin");
  });

  it("does not let a brace inside a string end a block early", () => {
    const tricky = `.a::after { content: "}" } .b { color: red }`;
    const kept = narrowCss(tricky, new Set(["a", "b"]));
    expect(kept).toContain(".a::after");
    expect(kept).toContain(".b");
  });
});

/**
 * The measurement this whole thing rests on, re-run against the real
 * stylesheet whenever one has been built.
 */
const distAssets = join(process.cwd(), "dist", "assets");
const built = existsSync(distAssets)
  ? readdirSync(distAssets).filter((f) => f.endsWith(".css"))
  : [];

describe.skipIf(!built.length)("against the built stylesheet", () => {
  const css = built
    .map((f) => readFileSync(join(distAssets, f), "utf8"))
    .join("\n");

  it("strips the three utilities that fire on a page using none of them", () => {
    // Measured 2026-08-30: with the full stylesheet, a page whose body is
    // `<h1>Hello</h1>` reports gradient-text, bounce-easing and dark-glow.
    const body = `<main class="p-4"><h1 class="font-bold">Hello</h1></main>`;
    const narrowed = narrowCss(css, classesIn(body));
    expect(narrowed.length).toBeLessThan(css.length / 4);
    expect(narrowed).not.toMatch(/bg-clip-text/);
  });

  it("keeps what a real Card needs, or the harness scans an unstyled page", () => {
    const cardClasses =
      "bg-card text-card-foreground flex flex-col gap-6 rounded-xl border py-6 shadow-sm";
    const body = `<div class="${cardClasses}"></div>`;
    const narrowed = narrowCss(css, classesIn(body));
    for (const needed of ["rounded-xl", "shadow-sm", "bg-card"]) {
      expect(narrowed).toContain(needed);
    }
    // The tokens the card's colours resolve through.
    expect(narrowed).toContain(":root");
  });
});
