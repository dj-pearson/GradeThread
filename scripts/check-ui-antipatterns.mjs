#!/usr/bin/env node
// US-2336: the UI anti-pattern gate.
//
// `npx impeccable detect` runs 60 deterministic rules with no install, no API
// key and no LLM. The project's own UI guidance names several of these as the
// recognizable tells of default AI output — a coloured side tab above 1px is
// called out as "the single most recognizable tell" — so they are worth failing
// a build over.
//
// WHY THIS WRAPPER EXISTS RATHER THAN A BARE `impeccable detect` IN CI. The
// tool's exit code covers every rule at once, and one rule here is pure noise:
// `broken-image` matches the literal text `<img` ANYWHERE, including prose
// comments and HTML-snippet strings. Every one of its current findings was
// checked by hand and not one is a real broken tag — they are sentences like
// "a drop-in <img> replacement" and the embed snippet in lib/verified.ts, which
// builds `<img src="${img}"` as a string for sellers to paste. A rule that
// cannot tell markup from a sentence about markup should not be able to block
// a deploy.
//
// So: ENFORCED rules fail the build at zero. Everything else is reported and
// counted, and the count is compared against a recorded baseline so noise
// cannot quietly grow either. Adding a rule to ENFORCED is the way to tighten
// this; raising the baseline is the way to admit defeat, so the baseline
// carries the reason it is where it is.

import { spawnSync } from "node:child_process";

/**
 * Rules that fail the build outright. These are the ones the project's own
 * guidance calls out, and they have no false-positive mode: a `border-l-4` on a
 * card is a side tab, not a sentence about one.
 */
export const ENFORCED = new Set([
  "side-tab",
  "gradient-text",
  "nested-cards",
  "icon-tile-grid",
  "border-and-shadow",
  "bounce-easing",
  "uppercase-eyebrow",
]);

/**
 * Findings that are reported but do not fail. The number is not a budget to
 * spend — it is a description of known tool noise.
 *
 * IT IS NOW ZERO (US-2402, 2026-08-04). It was 14, and all 14 were the
 * broken-image rule matching `<img` inside PROSE — comments like "a drop-in
 * <img> replacement". Those comments now say "an img element", so the tool
 * reports nothing and the baseline describes the truth again.
 *
 * WHY LOWERING IT MATTERED MORE THAN THE COMMENTS DID: at 14, fourteen real
 * findings could have arrived without this gate saying a word. A baseline that
 * outlives the noise it describes is a budget, which is exactly what the
 * paragraph above says it must not become. Lower it whenever the noise goes.
 */
export const NOISE_BASELINE = 0;

export function partition(findings) {
  const enforced = findings.filter((f) => ENFORCED.has(f.antipattern));
  const other = findings.filter((f) => !ENFORCED.has(f.antipattern));
  return { enforced, other };
}

function main() {
  // shell:true on Windows — npx resolves to npx.cmd, which spawnSync cannot
  // exec directly (EINVAL) without a shell.
  const res = spawnSync("npx impeccable detect src --json", {
    encoding: "utf8",
    shell: true,
    maxBuffer: 32 * 1024 * 1024,
  });
  if (res.error) {
    console.error(`[ui-antipatterns] could not run impeccable: ${res.error.message}`);
    process.exit(1);
  }
  let findings;
  try {
    findings = Object.values(JSON.parse(res.stdout));
  } catch {
    console.error(
      "[ui-antipatterns] impeccable did not return JSON. Output was:\n" +
        `${res.stdout.slice(0, 500)}\n${res.stderr.slice(0, 500)}`,
    );
    process.exit(1);
  }

  const { enforced, other } = partition(findings);

  if (enforced.length > 0) {
    console.error(`\x1b[31m\x1b[1m[ui-antipatterns] ${enforced.length} blocking finding(s)\x1b[0m`);
    for (const f of enforced) {
      console.error(`  ${f.file}:${f.line}  [${f.antipattern}] ${f.snippet ?? ""}`);
      console.error(`    → ${f.description}`);
    }
    console.error(
      "\nThese are the defaults the project's UI guidance rules out. Emphasis " +
        "comes from weight and size; declare elevation once (border OR shadow).",
    );
    process.exit(1);
  }

  if (other.length > NOISE_BASELINE) {
    console.error(
      `\x1b[31m\x1b[1m[ui-antipatterns] non-blocking findings grew: ${other.length} > ${NOISE_BASELINE}\x1b[0m`,
    );
    const byRule = {};
    for (const f of other) byRule[f.antipattern] = (byRule[f.antipattern] ?? 0) + 1;
    console.error(`  by rule: ${JSON.stringify(byRule)}`);
    console.error(
      "\nThe baseline describes verified tool noise, not a budget. Check whether " +
        "the new ones are real before raising it.",
    );
    process.exit(1);
  }

  console.log(
    `\x1b[32m\x1b[1m[ui-antipatterns] OK\x1b[0m 0 blocking, ${other.length}/${NOISE_BASELINE} known-noise findings.`,
  );
}

if (import.meta.url === `file://${process.argv[1]?.split("\\").join("/")}` ||
    process.argv[1]?.endsWith("check-ui-antipatterns.mjs")) {
  main();
}
