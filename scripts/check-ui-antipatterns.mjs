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
// tool's exit code covers every rule at once, and one rule here is mostly
// noise: `broken-image` matches the literal text `<img` ANYWHERE, including
// prose comments and HTML-snippet strings. A rule that cannot tell markup from
// a sentence about markup should not be able to block a deploy.
//
// So: ENFORCED rules fail the build at zero, in every root. Everything else
// must match a NAMED entry in that root's KNOWN_NOISE list, and an entry that
// stops matching is also an error — the list can only shrink.
//
// US-2623 (2026-08-16): `functions/` IS IN SCOPE NOW. It had been excluded with
// the note that scoring it "needs its own decision, not a suppression here",
// and it went unscored for long enough that two real side-tab findings sat on
// the live blog template — the `.key-takeaways` callout carried a 4px accent
// stripe on every published post, which is the exact pattern the guidance calls
// the single most recognizable tell. The tree that renders our highest-traffic
// public pages was the one tree the gate could not see.

import { spawnSync } from "node:child_process";

/**
 * Rules that fail the build outright. These are the ones the project's own
 * guidance calls out, and they have no false-positive mode: a `border-l-4` on a
 * card is a side tab, not a sentence about one.
 */
export const ENFORCED = new Set([
  "side-tab",
  "gradient-text",
  "bounce-easing",
]);

/**
 * ⚠ FOUR IDS WERE REMOVED FROM `ENFORCED` ON 2026-08-23 BECAUSE THEY COULD
 * NEVER FIRE, and the removal makes this gate weaker on paper and identical in
 * practice. Read this before adding any of them back.
 *
 * The set used to also carry `nested-cards`, `icon-tile-grid`,
 * `border-and-shadow` and `uppercase-eyebrow`. A textbook instance of each was
 * written into a probe component and scanned: none produced a single finding.
 * Checked against the tool's own source, not inferred:
 *
 *   • `icon-tile-grid` and `uppercase-eyebrow` ARE NOT THE TOOL'S NAMES. It
 *     calls them `icon-tile-stack` and `hero-eyebrow-chip`. An id that matches
 *     no rule is not an error anywhere — it simply never appears in the
 *     findings, so the entry sat in the set looking like enforcement.
 *   • `border-and-shadow` exists under no spelling at all.
 *   • `nested-cards` is real, and it lives in `detect-antipatterns-browser.js`
 *     with `scopes: ['layout']`. It needs a RENDERED PAGE. `impeccable detect
 *     <dir>` reads source files, so a browser-scoped rule cannot fire here
 *     however bad the markup is. The same is true of the two renamed ones.
 *
 * So the gate enforced three tells while claiming seven. The other four are
 * still repo policy — CLAUDE.md's craft floor names every one of them — they
 * are just not machine-checkable by a source scan, and pretending otherwise is
 * what let this sit. Catching them needs `impeccable detect <url>` against a
 * running page, which is a different job with a different runner.
 *
 * `selfCheck()` below exists so this cannot recur silently.
 */
export const NOT_SOURCE_CHECKABLE = new Map([
  ["nested-cards", "browser-scoped (scopes: ['layout']) — needs a rendered page"],
  ["icon-tile-stack", "browser-scoped; the set used to spell it `icon-tile-grid`"],
  ["hero-eyebrow-chip", "browser-scoped; the set used to spell it `uppercase-eyebrow`"],
  ["border-and-shadow", "no rule of this name exists in the tool, under any spelling"],
]);

/** One deliberately-bad file per enforced rule. */
const SELF_CHECK_DIR = "scripts/fixtures/ui-antipatterns";

/**
 * The trees that get scored, and the non-enforced findings each one is allowed
 * to keep.
 *
 * KNOWN_NOISE IS A LIST OF NAMED SITES, NOT A NUMBER, and that is deliberate.
 * A numeric baseline is a budget: at 14 (which is where `functions/` would have
 * started) fourteen real findings could arrive without this gate saying a word.
 * Matching each one by file and snippet means a NEW finding fails even when the
 * total is unchanged, and a site that gets fixed has to be deleted from here.
 *
 * `src` keeps an empty list — it reached zero in US-2402 by rewriting the prose
 * that tripped `broken-image` ("an img element" rather than the tag text), and
 * the same rewrite took `functions/` from 14 to 2.
 */
export const ROOTS = [
  { path: "src", knownNoise: [] },
  { path: "functions",
    knownNoise: [
      {
        file: "functions/_shared/blog-render.ts",
        snippet: "<img\\b([^>",
        why:
          "The REGEX that finds in-body images so they can be given width, " +
          "height, loading and decoding attributes (US-306/US-434). The rule " +
          "is matching the pattern that fixes images, not a broken tag.",
      },
      {
        file: "functions/_shared/blog-render.ts",
        snippet: '<img${attrs.replace(',
        why:
          "The reassembly half of that same rewriter. `attrs` is what it just " +
          "parsed off a real tag, so the src is whatever the author wrote — " +
          "the rule cannot follow a tag built from a string and never will.",
      },
    ],
  },
];

/** Split a root's findings into blocking and everything else. */
export function partition(findings) {
  return {
    enforced: findings.filter((f) => ENFORCED.has(f.antipattern)),
    other: findings.filter((f) => !ENFORCED.has(f.antipattern)),
  };
}

/** True when a finding is the site a KNOWN_NOISE entry describes. */
export function matchesNoise(finding, entry) {
  const file = String(finding.file ?? "").split("\\").join("/");
  return (
    file.endsWith(entry.file) && String(finding.snippet ?? "").includes(entry.snippet)
  );
}

/**
 * Reconcile a root's non-enforced findings against its allowlist.
 * Returns { unexpected, stale } — both empty is the passing state.
 */
export function reconcileNoise(other, knownNoise) {
  const unexpected = other.filter(
    (f) => !knownNoise.some((entry) => matchesNoise(f, entry)),
  );
  const stale = knownNoise.filter(
    (entry) => !other.some((f) => matchesNoise(f, entry)),
  );
  return { unexpected, stale };
}

function detect(root) {
  // shell:true on Windows — npx resolves to npx.cmd, which spawnSync cannot
  // exec directly (EINVAL) without a shell.
  const res = spawnSync(`npx impeccable detect ${root} --json`, {
    encoding: "utf8",
    shell: true,
    maxBuffer: 32 * 1024 * 1024,
  });
  if (res.error) {
    console.error(`[ui-antipatterns] could not run impeccable: ${res.error.message}`);
    process.exit(1);
  }
  try {
    return Object.values(JSON.parse(res.stdout));
  } catch {
    console.error(
      `[ui-antipatterns] impeccable did not return JSON for ${root}. Output was:\n` +
        `${res.stdout.slice(0, 500)}\n${res.stderr.slice(0, 500)}`,
    );
    process.exit(1);
  }
}

/**
 * Prove every ENFORCED rule can still fire.
 *
 * A rule id that matches nothing is not an error in this tool — it is simply
 * absent from the findings, which reads exactly like a clean codebase. That is
 * how four ids sat in `ENFORCED` enforcing nothing (see NOT_SOURCE_CHECKABLE),
 * and a rename in the tool would do it again tomorrow.
 *
 * So the gate scans a directory of deliberately-bad fixtures and requires each
 * enforced id to come back. If the tool renames a rule, drops one, or moves it
 * behind the browser engine, THIS fails loudly instead of the codebase quietly
 * passing.
 */
function selfCheck() {
  const emitted = new Set(detect(SELF_CHECK_DIR).map((f) => f.antipattern));
  const dead = [...ENFORCED].filter((id) => !emitted.has(id));
  if (dead.length === 0) return true;
  console.error(
    `\x1b[31m\x1b[1m[ui-antipatterns] ${dead.length} enforced rule(s) no longer ` +
      `fire on their own fixture\x1b[0m`,
  );
  for (const id of dead) {
    console.error(
      `  ${id} — ${SELF_CHECK_DIR}/${id}.tsx is a textbook instance and the ` +
        `detector said nothing about it.`,
    );
  }
  console.error(
    "  Either the tool renamed or removed the rule, or it moved behind the\n" +
      "  browser engine. Do NOT delete the fixture to make this pass: the\n" +
      "  point is that an id enforcing nothing looks identical to a clean\n" +
      "  codebase. Fix the id, or move it to NOT_SOURCE_CHECKABLE with a reason.",
  );
  return false;
}

function main() {
  let failed = false;
  const summary = [];

  if (!selfCheck()) process.exit(1);

  for (const root of ROOTS) {
    const { enforced, other } = partition(detect(root.path));
    const { unexpected, stale } = reconcileNoise(other, root.knownNoise);

    if (enforced.length > 0) {
      failed = true;
      console.error(
        `\x1b[31m\x1b[1m[ui-antipatterns] ${root.path}: ${enforced.length} blocking finding(s)\x1b[0m`,
      );
      for (const f of enforced) {
        console.error(`  ${f.file}:${f.line}  [${f.antipattern}] ${f.snippet ?? ""}`);
        console.error(`    → ${f.description}`);
      }
      console.error(
        "\nThese are the defaults the project's UI guidance rules out. Emphasis " +
          "comes from weight and size; declare elevation once (border OR shadow).",
      );
    }

    if (unexpected.length > 0) {
      failed = true;
      console.error(
        `\x1b[31m\x1b[1m[ui-antipatterns] ${root.path}: ${unexpected.length} finding(s) not in KNOWN_NOISE\x1b[0m`,
      );
      for (const f of unexpected) {
        console.error(`  ${f.file}:${f.line}  [${f.antipattern}] ${f.snippet ?? ""}`);
      }
      console.error(
        "\nCheck whether these are real before adding them. Prose that mentions " +
          "a tag can say 'an img element' instead, which is how both roots got " +
          "to their current number.",
      );
    }

    if (stale.length > 0) {
      failed = true;
      console.error(
        `\x1b[31m\x1b[1m[ui-antipatterns] ${root.path}: ${stale.length} KNOWN_NOISE entr(ies) no longer match\x1b[0m`,
      );
      for (const e of stale) console.error(`  ${e.file} :: ${e.snippet}`);
      console.error("\nThe site was fixed or moved. Delete the entry — this list only shrinks.");
    }

    summary.push(`${root.path} 0 blocking, ${other.length}/${root.knownNoise.length} known-noise`);
  }

  if (failed) process.exit(1);
  console.log(`\x1b[32m\x1b[1m[ui-antipatterns] OK\x1b[0m ${summary.join(" · ")}.`);
}

if (import.meta.url === `file://${process.argv[1]?.split("\\").join("/")}` ||
    process.argv[1]?.endsWith("check-ui-antipatterns.mjs")) {
  main();
}
