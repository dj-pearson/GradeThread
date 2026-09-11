import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

// US-3128 AC6 -- "the FTC RN database is auth-gated" must not come back.
//
// WHY A TEST AND NOT A NOTE. That one sentence was written in migration 00466,
// copied into services/edge-functions/src/lib/registered-numbers.ts and into
// vault/20-domain/brands/brand-kb-negative-findings.md, and then believed for
// months. It set the coverage of a whole column: six brands of ~180 carried a
// registered number, and every pack that skipped one cited it. The register was
// open the entire time -- https://www.ftc.gov/rn-database/search answers 200 to a
// plain unauthenticated GET -- so the cost of the sentence was the data that was
// never gathered.
//
// Nobody re-checks a door they have been told is locked. A note saying "this was
// wrong" does not stop the claim reappearing in the next file; only something
// that fails does.
//
// ── WHAT IT ALLOWS, WHICH IS THE DIFFERENCE BETWEEN A GUARD AND A BAN ──────
//
// The phrase itself is fine and has to stay: the corrections quote it, and
// migration 00466 is applied and immutable and still carries the original claim
// as history. What is refused is the claim made *straight* -- the phrase near the
// register with nothing nearby saying it is wrong. So every mention is read with
// its neighbours, and a correction marker within the window clears it.
//
// "Auth-gated" about anything else -- an app surface, a route, another API -- is
// not this claim and is not scanned for: a mention only counts when the register
// is named within the same window.

const ROOT = resolve(process.cwd());

/** Where the claim could plausibly live and be believed. */
const SCAN_ROOTS = [
  "src",
  "scripts",
  "vault",
  "docs",
  join("services", "edge-functions", "src"),
  join("services", "edge-functions", "scripts"),
];

// supabase/migrations is deliberately NOT scanned. 00466 is applied and
// immutable and its header is the historical record of the mistake; rewriting
// history to satisfy a guard is the wrong trade. prd.json and prd.archive.json
// are likewise the record of the story that corrected it.
const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".git",
  ".vite",
  "__snapshots__",
]);

/**
 * This file quotes the claim in its own fixtures, so it must not scan itself.
 * Named rather than pattern-matched: a broad "skip test files" rule would let
 * the claim live on in any test.
 */
const SELF = "src/test/ftc-register-not-auth-gated.test.ts";

const EXTENSIONS = [".ts", ".tsx", ".js", ".mjs", ".cjs", ".md", ".sql", ".json"];

/** The phrase, in the spellings it has actually been written in. */
const PHRASE = /auth[\s_-]?gated/i;

/**
 * Names the register. Without one of these in the window the mention is about
 * something else entirely -- `src/lib/seo/__tests__/public-routes.test.ts` calls
 * the signed-in app surfaces auth-gated and is correct to.
 */
const REGISTER = /\bFTC\b|rn-database|rn\.ftc\.gov|\bRN\b|registered identification/i;

/**
 * Says the claim is wrong. Deliberately generous: the point is to catch the
 * claim asserted BARE, and any honest correction reads as one of these.
 */
const CORRECTION =
  /\bfalse\b|\bwrong\b|\bmistake\b|\bcorrect(?:ed|ion|s)?\b|\bis not\b|\bwas not\b|\bit is not\b|\bnot auth[\s_-]?gated\b|\bnever was\b|\bno gate\b|\bno login\b|\bopen\b/i;

/** Lines of context read on each side of a mention. */
const WINDOW = 8;

export interface Mention {
  file: string;
  line: number;
  text: string;
}

/**
 * Find every place the register is described as auth-gated with no correction
 * beside it. PURE over (path, text) so the fixtures below can prove it fires.
 */
export function findUncorrectedMentions(
  files: ReadonlyArray<{ path: string; text: string }>,
): Mention[] {
  const out: Mention[] = [];
  for (const file of files) {
    const lines = file.text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? "";
      if (!PHRASE.test(line)) continue;
      const from = Math.max(0, i - WINDOW);
      const to = Math.min(lines.length, i + WINDOW + 1);
      const window = lines.slice(from, to).join("\n");
      if (!REGISTER.test(window)) continue; // not about this register
      if (CORRECTION.test(window)) continue; // corrected in place
      out.push({ file: file.path, line: i + 1, text: line.trim() });
    }
  }
  return out;
}

/**
 * The three files that carry the correction. If a mention survives in one of
 * them with no correction the scan above catches it; if the whole correction is
 * DELETED the scan goes quiet, which is why presence is asserted separately.
 */
const CORRECTION_ANCHORS = [
  join("services", "edge-functions", "src", "lib", "registered-numbers.ts"),
  join("vault", "20-domain", "brands", "brand-kb-negative-findings.md"),
  join("scripts", "ops", "ftc-rn-lookup.mjs"),
];

function walk(dir: string, acc: string[]): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return acc;
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    let stat;
    try {
      stat = statSync(full);
    } catch {
      continue;
    }
    if (stat.isDirectory()) walk(full, acc);
    else if (EXTENSIONS.some((e) => entry.endsWith(e))) acc.push(full);
  }
  return acc;
}

function scanTree(): Array<{ path: string; text: string }> {
  const files: string[] = [];
  for (const root of SCAN_ROOTS) walk(join(ROOT, root), files);
  return files
    .map((f) => ({
      path: relative(ROOT, f).replace(/\\/g, "/"),
      text: readFileSync(f, "utf8"),
    }))
    .filter((f) => f.path !== SELF);
}

describe("the FTC RN register is open, and saying otherwise fails", () => {
  // The fixtures come first on purpose. A scanner that has quietly stopped
  // matching reports a clean tree, which is indistinguishable from a clean tree.
  it("fires on the claim asserted bare", () => {
    const found = findUncorrectedMentions([
      {
        path: "fixture/reintroduced.ts",
        text: [
          "// No RN is seeded for this brand.",
          "// The FTC RN database is auth-gated and returns 401 to automation,",
          "// so the registrant could not be confirmed.",
        ].join("\n"),
      },
    ]);
    expect(found).toHaveLength(1);
    expect(found[0]?.line).toBe(2);
  });

  it("allows the phrase when the correction sits beside it", () => {
    expect(
      findUncorrectedMentions([
        {
          path: "fixture/corrected.md",
          text: [
            "> The FTC register was recorded here as auth-gated.",
            ">",
            "> That is FALSE: the search answers 200 to a plain GET.",
          ].join("\n"),
        },
      ]),
    ).toHaveLength(0);
  });

  it("ignores auth-gated said about anything that is not this register", () => {
    expect(
      findUncorrectedMentions([
        {
          path: "fixture/unrelated.ts",
          text: "// /dashboard/snap is auth-gated, so the signup CTA points at signup.",
        },
      ]),
    ).toHaveLength(0);
  });

  it("needs the register named nearby, not merely the word somewhere in the file", () => {
    const far = [
      "// The FTC register is the source for all of this.",
      ...Array.from({ length: 30 }, (_, i) => `// filler line ${i}`),
      "// This surface is auth-gated.",
    ].join("\n");
    expect(findUncorrectedMentions([{ path: "fixture/far.ts", text: far }])).toHaveLength(0);
  });

  it("does not describe the register as auth-gated anywhere in the tree", () => {
    const found = findUncorrectedMentions(scanTree());
    expect(
      found.map((m) => `${m.file}:${m.line}  ${m.text}`),
      "https://www.ftc.gov/rn-database/search answers 200 to a plain unauthenticated GET. " +
        "This claim set the registered_numbers column's coverage for months. If a lookup " +
        "is failing, say what it actually returned -- do not resurrect the gate.",
    ).toEqual([]);
  });

  it("keeps the correction itself, in all three places it was made", () => {
    for (const anchor of CORRECTION_ANCHORS) {
      const text = readFileSync(join(ROOT, anchor), "utf8");
      expect(PHRASE.test(text), `${anchor} no longer quotes the claim it corrects`).toBe(true);
      expect(CORRECTION.test(text), `${anchor} no longer says the claim is wrong`).toBe(true);
    }
  });
});
