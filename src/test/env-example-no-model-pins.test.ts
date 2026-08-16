// US-2633: `.env.example` must not choose the grading model.
//
// It pinned `DEFAULT_AI_MODEL=claude-sonnet-4-6` while `lib/ai-config.ts`
// defaults to `claude-sonnet-5`. Copying the template therefore did two things,
// and the second is the serious one:
//
//   1. downgraded the vision model used to grade garments, and
//   2. flipped the SAMPLING REGIME. `modelUsesEffort()` is true for sonnet-5 and
//      false for sonnet-4-6, so the pin moved grading off `output_config.effort`
//      onto the old temperature path — a different decoding strategy, chosen by
//      a copy-paste.
//
// The grading contract says model and prompt changes go through shadow → eval →
// canary, never a silent edit. A template that changes the model bypasses that
// entirely for every new environment, and does it invisibly, because the pinned
// value looks like documentation of the default rather than an override of it.
//
// The env reference already carried this as a warning ("`.env.example` still
// ships `claude-sonnet-4-6`, so copying the example file pins an older model
// than leaving the var unset does"). It sat there, correct and unfixed. A
// written-down defect with no gate is a defect.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const EXAMPLE = "services/edge-functions/.env.example";
const CONFIG = "services/edge-functions/src/lib/ai-config.ts";

/**
 * Variables that SELECT A MODEL. Pinning any of these in the template overrides
 * the code default for whoever copies it, and a later change to that default
 * never reaches them.
 */
const MODEL_VARS = [
  "DEFAULT_AI_MODEL",
  "LIGHTWEIGHT_AI_MODEL",
  "DEFAULT_IMAGE_MODEL",
  "GRADING_COMPOSITE_MODEL",
];

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

/** Assignments in a .env file, ignoring comments. */
function assignments(src: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of src.split(/\r?\n/)) {
    if (/^\s*#/.test(line)) continue;
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m) out.set(m[1]!, m[2]!.trim());
  }
  return out;
}

describe("US-2633: the example env file does not pick the grading model", () => {
  it("no model-selecting variable carries a value", () => {
    const env = assignments(read(EXAMPLE));
    const pinned = MODEL_VARS.filter((v) => (env.get(v) ?? "") !== "");
    expect(
      pinned,
      "a pinned model in the template overrides the code default for anyone who " +
        "copies it, and can change the sampling regime as a side effect. Leave " +
        "these empty and let lib/ai-config.ts be the single source.",
    ).toEqual([]);
  });

  it("guard-the-guard: these variables are still present in the template", () => {
    // An empty value and a deleted line both satisfy the case above, and only
    // one of them is right — a reader needs to see the name to know it exists.
    const src = read(EXAMPLE);
    for (const v of MODEL_VARS) {
      expect(new RegExp(`^${v}=`, "m").test(src), `${v} vanished from ${EXAMPLE}`).toBe(true);
    }
  });

  it("guard-the-guard: the code default is still effort-based", () => {
    // The whole argument above rests on the default model being one that takes
    // output_config.effort. If that ever stops being true the reasoning here
    // needs re-reading, not silently inheriting.
    const config = read(CONFIG);
    const model = /model:\s*"([^"]+)"/.exec(config)?.[1];
    expect(model, "could not find DEFAULTS.model in ai-config.ts").toBeTruthy();
    const effortFamilies = [...config.matchAll(/m\.startsWith\("([^"]+)"\)/g)].map((m) => m[1]!);
    expect(
      effortFamilies.some((f) => model!.startsWith(f)),
      `the default model ${model} is no longer in modelUsesEffort()`,
    ).toBe(true);
  });

  it("the template no longer claims grading is greedy-decoded", () => {
    // US-2035 retracted that claim in ai-config.ts and both vault notes were
    // updated; the template kept asserting it, which is the copy that a new
    // operator reads first.
    const src = read(EXAMPLE);
    expect(src).not.toMatch(/ALWAYS low-temperature/);
    expect(src).not.toMatch(/defaults to 0 \(greedy decoding\)/);
  });
});
