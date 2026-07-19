// US-1996 AC1: keep the authenticity eval gate from being forgotten.
//
// THE SITUATION, stated precisely, because it is easy to misread in both
// directions:
//
//   • authenticity-eval.ts implements the gate US-1770 asked for, and it works
//     (it has tests).
//   • NOTHING imports it. It has zero non-self callers.
//   • But there is ALSO no authenticity prompt-activation path anywhere — the
//     grading prompt lifecycle knows three stages (per_image, composite,
//     listing_gen) and none of them is authenticity.
//
// So "no authenticity prompt version can activate without clearing the gate" is
// currently TRUE — vacuously. Nothing can activate at all. The exposure is not
// present-tense; it is that someone later builds the activation path, does not
// know this module exists (its own tests are green, which reads like coverage),
// and ships an ungated one.
//
// WHY THIS IS A GUARD AND NOT AN IMPLEMENTATION: wiring the gate today would
// mean inventing an authenticity prompt-version lifecycle nobody has asked for
// — a speculative feature built to satisfy a checkbox, which is how dead code
// like authenticity-eval.ts got here in the first place. The honest move is to
// make the requirement impossible to miss AT THE MOMENT it becomes real.
//
// This test fails the build if an authenticity prompt-activation path appears
// without calling runAuthenticityEval. It is deliberately allowed to pass today
// with zero activation sites: absence is the current, correct state.

import { assert, assertEquals } from "@std/assert";

const LIB = new URL("../lib/", import.meta.url);
const ROUTES = new URL("../routes/", import.meta.url);

async function readAll(dir: URL): Promise<Array<{ name: string; src: string }>> {
  const out: Array<{ name: string; src: string }> = [];
  for await (const entry of Deno.readDir(dir)) {
    if (!entry.isFile || !entry.name.endsWith(".ts")) continue;
    out.push({
      name: entry.name,
      src: await Deno.readTextFile(new URL(entry.name, dir)),
    });
  }
  return out;
}

// An "authenticity activation site" = a place where the two concepts appear
// TOGETHER, within PROXIMITY_CHARS of each other. Co-presence anywhere in a file
// is far too loose: ai-grading.ts is ~3000 lines that legitimately mention
// per-image authenticity types AND, hundreds of lines away, cache invalidation
// for "a newly activated prompt version". That was a false positive on the first
// run of this guard, and a guard that cries wolf is one people delete.
const PROXIMITY_CHARS = 300;
const ACTIVATION_RE = /activatePromptVersion|activate\w*\s*\w*prompt|prompt\w*\s*\w*activate/gi;

function authenticityActivationSites(src: string): number {
  let hits = 0;
  for (const m of src.matchAll(ACTIVATION_RE)) {
    const at = m.index ?? 0;
    const window = src.slice(
      Math.max(0, at - PROXIMITY_CHARS),
      at + m[0].length + PROXIMITY_CHARS,
    );
    if (/authenticity/i.test(window)) hits++;
  }
  return hits;
}

Deno.test("US-1996: any authenticity prompt activation must call the eval gate", async () => {
  const files = [...await readAll(LIB), ...await readAll(ROUTES)];
  const offenders: string[] = [];

  for (const f of files) {
    // The gate module itself, and this guard, obviously mention both.
    if (f.name === "authenticity-eval.ts") continue;
    if (authenticityActivationSites(f.src) === 0) continue;
    if (!/runAuthenticityEval/.test(f.src)) offenders.push(f.name);
  }

  assertEquals(
    offenders,
    [],
    "These files activate an authenticity prompt without clearing the golden-set " +
      "gate (lib/authenticity-eval.ts runAuthenticityEval). US-1770 required that " +
      "a candidate authenticity prompt pass an accuracy gate BEFORE activation, " +
      "and that a per-brand regression block it:\n" + offenders.join("\n"),
  );
});

// If the gate module is ever deleted as "dead code", this test would start
// passing for the wrong reason — an empty guard over a requirement nobody is
// enforcing any more. Pin its existence so removing it is a deliberate act that
// breaks the build rather than a quiet cleanup.
Deno.test("US-1996: the authenticity gate still exists to be wired to", async () => {
  const src = await Deno.readTextFile(new URL("authenticity-eval.ts", LIB));
  assert(
    /export async function runAuthenticityEval/.test(src),
    "runAuthenticityEval has gone. If authenticity prompts were genuinely dropped " +
      "as a product, delete this guard too and say so in US-1996 — but do not let " +
      "the gate disappear silently while the requirement stands.",
  );
});
