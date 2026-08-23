// No source file carries a character that does not render.
//
// CLAUDE.md has mandated this since the vault sync ("Plain characters only ...
// never emit an invisible or bidi character anywhere") and gave the ripgrep
// command for it. Nothing enforced it, and on 2026-08-21 that cost a guard.
//
// WHAT HAPPENED. A test regex written through a heredoc had its word boundaries
// turned into literal BACKSPACE bytes: `/\bpriceFilled\b/` became
// `/<0x08>priceFilled<0x08>/`. It reads correctly in every editor and in the
// diff. It matches nothing. Four sabotages that had been CAUGHT silently became
// NOT CAUGHT while the suite stayed green — a guard strengthened into a no-op,
// and only re-running the sabotage found it.
//
// That is the whole argument for this file. These characters are dangerous
// precisely because review cannot see them, so review is the wrong tool and a
// scan is the right one.
//
// Fixed at the same time: three source files held LITERAL NUL bytes as a join
// separator rather than a u0000 escape. They
// worked, and they were invisible in every editor and diff. Same behaviour,
// written so a human can see it.

import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, extname } from "node:path";

const ROOT = ".";
const EXT = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json", ".sql", ".yml", ".yaml"]);
const SKIP = new Set([
  "node_modules", ".git", "dist", "dist-ext", "build", ".vite", "coverage",
  "ios-screenshots", ".next", "playwright-report", "test-results",
]);

/**
 * C0 control characters, except the three that belong in text: tab (09),
 * newline (0A) and carriage return (0D).
 */
// Matching control characters IS the point of this file. The rule guards
// against them appearing by accident, which is the same goal from the
// other side, so a scoped disable is right and weakening the class is not.
// eslint-disable-next-line no-control-regex
const C0 = new RegExp('[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F]');

/**
 * Characters that occupy no visual space, or that reorder what follows.
 *
 * The bidi controls (202A-202E, 2066-2069) and the Unicode tag block
 * (E0000-E007F) are the ones that matter most: a tag-block sequence encodes
 * arbitrary ASCII invisibly, and is the usual carrier for text a reviewer
 * cannot see.
 */
const INVISIBLE = new RegExp(
  // eslint-disable-next-line no-misleading-character-class
  '[\\u00AD\\u034F\\u061C\\u180E\\u200B-\\u200F\\u202A-\\u202E\\u2060-\\u2064\\u2066-\\u2069\\uFEFF]',
);
const TAG_BLOCK = /[\u{E0000}-\u{E007F}]/u;

/**
 * Spaces that are not the space character.
 *
 * CLAUDE.md forbids these by name and says why: a no-break space "breaks shell
 * word-splitting, `grep` and column parsing while looking exactly like a space".
 * They render, so the file above's argument — that review cannot see these —
 * applies differently: a reader SEES a space and is right to. What they cannot
 * see is that `grep 'foo bar'` will never match it.
 *
 * ⚠ THIS CLASS WAS ADDED 2026-08-23 AFTER SABOTAGE, and it is worth saying how.
 * Five characters were injected into a source file to check this guard caught
 * them: a backspace, a zero-width space, a bidi override, a tag-block character
 * — all four CAUGHT — and a no-break space, which was NOT. The rule was in
 * CLAUDE.md and the guard did not implement it, which is the gap between a
 * documented rule and an enforced one.
 *
 * Exactly ONE file in the repo carried one: a stray U+00A0 in a
 * content-safety HTML fixture, between `&amp;` and `<b>`, invisible and
 * asserted on by nothing. Fixed in the same commit rather than allowlisted, so
 * this class adopts at zero.
 */
const FAKE_SPACE = new RegExp(
  "[\\u00A0\\u2000-\\u200A\\u202F\\u205F\\u3000]",
);

/**
 * Files that legitimately contain one of these, with the reason.
 *
 * SHRINK-ONLY in spirit: an entry whose file stops containing the character
 * fails below, so a cleaned-up file cannot leave a stale exemption behind for
 * the next one to hide under.
 */
const ALLOWED: Array<[file: string, why: string]> = [
  ["scripts/check-bundle-budget.mjs", "ANSI colour escapes (U+001B) in terminal output"],
  ["services/edge-functions/scripts/coverage-floor.mjs", "ANSI colour escapes in terminal output"],
  ["services/edge-functions/src/lib/csv-parse.ts", "strips a UTF-8 BOM, so it must name one"],
  ["services/edge-functions/src/lib/agent-tools.ts", "control character in a sanitisation test vector"],
  ["services/edge-functions/src/tests/content-sanitize_test.ts", "control characters ARE the fixture"],
  ["services/edge-functions/src/tests/upload-validation_test.ts", "control bytes in a magic-byte fixture"],
];

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    if (SKIP.has(e)) continue;
    const p = join(dir, e);
    let st;
    try { st = statSync(p); } catch { continue; }
    if (st.isDirectory()) walk(p, out);
    else if (EXT.has(extname(e))) out.push(p);
  }
  return out;
}

function offenders(): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const f of walk(ROOT)) {
    let src: string;
    try { src = readFileSync(f, "utf8"); } catch { continue; }
    if (
      !C0.test(src) &&
      !INVISIBLE.test(src) &&
      !TAG_BLOCK.test(src) &&
      !FAKE_SPACE.test(src)
    ) {
      continue;
    }
    const rel = f.replace(/\\/g, "/").replace(/^\.\//, "");
    const points = new Set<string>();
    src.split("\n").forEach((line, i) => {
      for (const ch of line) {
        const cp = ch.codePointAt(0)!;
        const bad =
          (cp <= 0x1f && cp !== 0x09 && cp !== 0x0d) ||
          INVISIBLE.test(ch) ||
          FAKE_SPACE.test(ch) ||
          (cp >= 0xe0000 && cp <= 0xe007f);
        if (bad) points.add(`U+${cp.toString(16).toUpperCase().padStart(4, "0")} line ${i + 1}`);
      }
    });
    out.set(rel, [...points]);
  }
  return out;
}

describe("no source file carries a character that does not render", () => {
  it("the scanner still reaches the tree", () => {
    // Guard the guard: if the walk or the extension list breaks, every
    // assertion below passes by scanning nothing.
    expect(walk(ROOT).length).toBeGreaterThan(3000);
  });

  it("finds no unexplained invisible or control characters", () => {
    const allowed = new Set(ALLOWED.map(([f]) => f));
    const novel = [...offenders().entries()]
      .filter(([f]) => !allowed.has(f))
      .map(([f, pts]) => `${f}  (${pts.slice(0, 4).join(", ")})`)
      .sort();

    expect(
      novel,
      "These files contain characters that do not render. A backspace inside a " +
        "regex, a zero-width space inside an identifier, or a Unicode tag " +
        "sequence anywhere all survive review because review cannot see them — " +
        "one of them silently turned a working guard into a no-op on 2026-08-21. " +
        "Use an escape (\\u0000, \\b) instead of the literal byte, or add an " +
        "entry with a reason to ALLOWED.",
    ).toEqual([]);
  });

  it("no exemption outlives the thing it exempts", () => {
    const found = new Set(offenders().keys());
    const stale = ALLOWED.map(([f]) => f).filter((f) => !found.has(f)).sort();
    expect(
      stale,
      `these are exempted but no longer contain any such character: ${stale.join(", ")}. ` +
        `Delete the entries — a stale exemption is a hiding place for the next one.`,
    ).toEqual([]);
  });
});
