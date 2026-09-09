import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// US-3254. description-preview.tsx renders a description segment with
// dangerouslySetInnerHTML, and explains why that is safe:
//
//   "GradeThread-built markup, escaped at the source in the edge service.
//    Nothing a seller or the model wrote reaches this branch: the edge marks
//    only facts, disclosure and credentials as html."
//
// Every word of that is true, and nothing tested any of it. The invariant has
// four moving parts across three files:
//
//   HTML_KEYS                 decides which blocks become kind "html"
//   listing-facts-block.ts    \
//   seller-credentials.ts      >  the escapeHtml calls that make that markup
//   disclosure.ts             /   safe to hand to innerHTML
//
// Adding a seller-editable key to HTML_KEYS, or dropping one escapeHtml call in
// any of the three builders, turns the React comment into a false statement and
// puts seller or model prose into an innerHTML — with nothing failing.

const read = (rel: string) => readFileSync(resolve(process.cwd(), rel), "utf8");

const BLOCKS = "services/edge-functions/src/lib/description-blocks.ts";
const BUILDERS = [
  "services/edge-functions/src/lib/listing-facts-block.ts",
  "services/edge-functions/src/lib/seller-credentials.ts",
  "services/edge-functions/src/lib/disclosure.ts",
];

/**
 * Interpolations that are safe without escapeHtml, each with its reason. An
 * unexplained entry is how a rule like this rots, so the shape forces one.
 */
const SAFE_INTERPOLATIONS: { expr: string; why: string }[] = [
  {
    expr: "FACTS_MARKER_START",
    why: "a module constant HTML comment marker, not data",
  },
  {
    expr: "FACTS_MARKER_END",
    why: "a module constant HTML comment marker, not data",
  },
  {
    expr: "defects.length",
    why: "an array length, so a number — it cannot carry markup",
  },
  {
    expr: "items",
    why:
      "already escaped where it is built, six lines up: each <li> is " +
      "`escapeHtml(label)` and `escapeHtml(value)`. This is the one entry " +
      "here whose safety comes from its CONSTRUCTION rather than from its " +
      "type, so it is the one to re-read if that map ever changes.",
  },
];

describe("only GradeThread-built markup reaches innerHTML (US-3254)", () => {
  it("the consumer still renders raw HTML, so this file still matters", () => {
    // If the dangerouslySetInnerHTML goes away, this whole guard is obsolete
    // rather than passing for a good reason.
    const preview = read("src/components/flipdesk/composer/description-preview.tsx");
    expect(preview).toContain("dangerouslySetInnerHTML");
    expect(preview).toContain('seg.kind === "html"');
  });

  it("exactly three block keys become raw HTML", () => {
    const src = read(BLOCKS);
    const at = src.indexOf("const HTML_KEYS");
    expect(at, "HTML_KEYS has been renamed — re-point this guard").toBeGreaterThan(-1);
    const block = src.slice(at, src.indexOf("]", at));
    const keys = [...block.matchAll(/"([a-z_]+)"/g)].map((m) => m[1]).sort();
    // Adding a fourth is a deliberate decision. It should have to fail here
    // first and be argued for in the diff, because the React comment two files
    // away asserts this exact set.
    expect(keys).toEqual(["credentials", "disclosure", "facts"]);
  });

  it("every interpolation in the HTML builders is escaped", () => {
    const safe = new Set(SAFE_INTERPOLATIONS.map((s) => s.expr));
    const offenders: string[] = [];

    for (const rel of BUILDERS) {
      const src = read(rel);
      const lines = src.split(/\r?\n/);
      lines.forEach((line, i) => {
        // Only lines that actually emit markup.
        if (!/<(div|ul|li|p|a|strong|em|span|table|tr|td)\b/.test(line)) return;
        for (const m of line.matchAll(/\$\{([^}]*)\}/g)) {
          const expr = m[1]!.trim();
          if (expr.includes("escapeHtml(")) continue;
          if (safe.has(expr)) continue;
          offenders.push(`${rel}:${i + 1}  \${${expr}}`);
        }
      });
    }

    expect(
      offenders,
      "these interpolate into markup that description-preview.tsx hands to " +
        "dangerouslySetInnerHTML. Wrap them in escapeHtml, or add them to " +
        "SAFE_INTERPOLATIONS with the reason they cannot carry markup:\n  " +
        offenders.join("\n  "),
    ).toEqual([]);
  });

  it("the scan actually reads markup lines (self-check)", () => {
    // A regex that matches no lines passes forever. Prove it sees the real
    // ones, including at least one that IS escaped.
    let markupLines = 0;
    let escapedInterpolations = 0;
    for (const rel of BUILDERS) {
      for (const line of read(rel).split(/\r?\n/)) {
        if (!/<(div|ul|li|p|a|strong|em|span|table|tr|td)\b/.test(line)) continue;
        markupLines++;
        if (line.includes("escapeHtml(")) escapedInterpolations++;
      }
    }
    expect(markupLines).toBeGreaterThan(10);
    expect(escapedInterpolations).toBeGreaterThan(3);
  });
});
