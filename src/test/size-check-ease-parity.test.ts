import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// US-2916 guard. The size checker converts a body-measurement chart into the
// flat range a garment of that size should show, and the ease it adds is the
// ease src/lib/fit-model.ts already ships. Edge code cannot import from src/, so
// services/edge-functions/src/lib/size-check.ts keeps its own copy.
//
// Two copies of a number is how a feature starts telling two stories. This test
// reads BOTH files' source and fails if a slim or relaxed ease diverges, so
// changing one without the other is a red test rather than a composer that says
// a Large measures 22 in while the fit report says it measures 23.
//
// It parses text rather than importing, on purpose: fit-model.ts keeps its bands
// private (they are an implementation detail of predictFit) and exporting them
// only so a test could read them would widen the module's surface for no
// product reason.

const FIT_MODEL = resolve(process.cwd(), "src/lib/fit-model.ts");
const SIZE_CHECK = resolve(
  process.cwd(),
  "services/edge-functions/src/lib/size-check.ts",
);

/** `const TOP_CHEST: CircBands = { kind: "circ", tooSmall: 0, slim: 3, ... }` */
function fitModelEase(src: string, name: string): { slim: number; relaxed: number } {
  const m = src.match(
    new RegExp(`const ${name}\\s*:\\s*CircBands\\s*=\\s*\\{([^}]*)\\}`),
  );
  if (!m) throw new Error(`fit-model.ts no longer declares ${name}`);
  return { slim: field(m[1], "slim", name), relaxed: field(m[1], "relaxed", name) };
}

/** `const TOP_CHEST_EASE: Ease = { slim: 3, relaxed: 10 };` */
function sizeCheckEase(src: string, name: string): { slim: number; relaxed: number } {
  const m = src.match(new RegExp(`const ${name}\\s*:\\s*Ease\\s*=\\s*\\{([^}]*)\\}`));
  if (!m) throw new Error(`size-check.ts no longer declares ${name}`);
  return { slim: field(m[1], "slim", name), relaxed: field(m[1], "relaxed", name) };
}

function field(body: string, key: string, owner: string): number {
  const m = body.match(new RegExp(`\\b${key}\\s*:\\s*(-?\\d+(?:\\.\\d+)?)`));
  if (!m) throw new Error(`${owner} has no ${key}`);
  return Number(m[1]);
}

// [fit-model constant, size-check constant]. Every pair the checker uses.
const PAIRS: Array<[string, string]> = [
  ["TOP_CHEST", "TOP_CHEST_EASE"],
  ["OUTER_CHEST", "OUTER_CHEST_EASE"],
  ["DRESS_CHEST", "DRESS_CHEST_EASE"],
  ["WAIST", "WAIST_EASE"],
  ["HIPS", "HIP_EASE"],
];

describe("size-check ease parity with fit-model", () => {
  const fit = readFileSync(FIT_MODEL, "utf8");
  const check = readFileSync(SIZE_CHECK, "utf8");

  it.each(PAIRS)("%s matches %s", (fitName, checkName) => {
    expect(sizeCheckEase(check, checkName)).toEqual(fitModelEase(fit, fitName));
  });

  it("pins the published numbers, so a matched pair of edits is still caught", () => {
    // US-2916 AC3 states these outright. If a future story genuinely changes an
    // ease, it changes this list too and says why in its notes.
    expect(PAIRS.map(([fitName]) => [fitName, fitModelEase(fit, fitName)])).toEqual([
      ["TOP_CHEST", { slim: 3, relaxed: 10 }],
      ["OUTER_CHEST", { slim: 6, relaxed: 16 }],
      ["DRESS_CHEST", { slim: 3, relaxed: 10 }],
      ["WAIST", { slim: 1, relaxed: 5 }],
      ["HIPS", { slim: 2, relaxed: 8 }],
    ]);
  });

  it("covers every ease constant size-check declares", () => {
    const declared = [...check.matchAll(/const (\w+):\s*Ease\s*=/g)].map((m) => m[1]);
    expect(declared.sort()).toEqual(PAIRS.map(([, c]) => c).sort());
  });
});
