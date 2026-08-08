// US-1914 AC4: "returning users are welcomed, never shamed" is a RULE, and a
// rule that lives only in a story is one the next author never reads.
//
// The rule has teeth because the copy it forbids is FALSE here, not merely
// unkind. Seller standing is monotonic by construction: level derives from
// xp_peak (00542), tenure from tier_rank_peak (00557), and badges are never
// revoked. So "you lost your standing" describes something the schema cannot
// do. Buyer confirmation streaks are the one place a chain exists, and they
// have grace weeks plus banked freezes precisely so the loss frame is not
// needed there either.
//
// Why a guard rather than a code review: the whole idiom of retention copy is
// loss aversion, it measurably works in the short term, and every growth
// playbook reaches for it first. The customer this platform most wants to keep,
// the reseller who sources for three weeks and lists forty items in a weekend,
// is exactly the one that copy punishes.
//
// DISCOVERY, not a list. The scan walks every client (SPA, edge, Pages
// Functions, iOS, Android) so a surface that does not exist yet is already
// covered. Comments and imports are stripped first: the header above declares
// the refused vocabulary, and a file that merely imports the constants renders
// nothing. Either would trip a naive scan and teach the next person to
// suppress the guard instead of reading it.

import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { REFUSED_LOSS_PHRASES } from "@/lib/loyalty-copy";

const ROOTS = ["src", "services/edge-functions/src", "functions", "ios", "android"];
const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  "coverage",
  ".git",
  "build",
  ".gradle",
  "DerivedData",
  "__snapshots__",
]);

// The fence definition and the case you are reading. Both must NAME the
// refused phrases to do their job, so scanning them is scanning the ruler.
const SELF = new Set([
  "src/lib/loyalty-copy.ts",
  "src/test/no-standing-loss-copy.test.ts",
]);

const SOURCE_EXT = /\.(ts|tsx|js|jsx|swift|kt|kts|xml|strings)$/;

function walk(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    try {
      if (statSync(full).isDirectory()) walk(full, out);
      else if (SOURCE_EXT.test(full)) out.push(full);
    } catch {
      continue;
    }
  }
  return out;
}

const FILES = ROOTS.flatMap((r) => walk(r))
  .map((f) => relative(process.cwd(), f).split(sep).join("/"))
  .filter((f) => !SELF.has(f));

/**
 * Strip what is not user-facing copy, then flatten.
 *
 * Block and line comments go first (a note explaining the rule is not a message
 * anybody reads), then import lines (a file that imports the approved copy
 * renders it correctly and must not be punished for naming the module), then
 * whitespace collapses so a phrase broken across two lines of JSX is still one
 * phrase, which is how it reaches a human eye.
 */
export function scannableText(src: string): string {
  return src
    .replace(/\r\n/g, "\n")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/^\s*(\/\/|#|\*).*$/gm, " ")
    .replace(/^\s*(import|export .* from|package|using)\b.*$/gm, " ")
    .replace(/\s+/g, " ")
    .toLowerCase();
}

describe("no standing-loss copy anywhere (US-1914 AC4)", () => {
  it("no client tells anyone they lost, broke or are about to lose standing", () => {
    const offences: string[] = [];
    for (const file of FILES) {
      let text: string;
      try {
        text = scannableText(readFileSync(file, "utf8"));
      } catch {
        continue;
      }
      for (const phrase of REFUSED_LOSS_PHRASES) {
        if (text.includes(phrase)) offences.push(`${file}: "${phrase}"`);
      }
    }
    expect(offences).toEqual([]);
    // Generous, and explicitly set: this walks five client trees, and the vitest
    // 5s default is a budget for a unit test, not for a corpus scan competing
    // with 290 other files for disk. A timeout here reads as a policy breach
    // when it is really just contention.
  }, 120_000);

  // Vacuity guard. If the walker stops finding files (a moved root, a changed
  // cwd) the assertion above passes on an empty set and the fence silently stops
  // existing. Assert the CORPUS, not the absence of offences.
  it("actually scanned every client", () => {
    expect(FILES.length).toBeGreaterThan(500);
    expect(FILES.some((f) => f.startsWith("src/pages/"))).toBe(true);
    expect(FILES.some((f) => f.startsWith("services/edge-functions/src/lib/"))).toBe(true);
    expect(FILES.some((f) => f.startsWith("functions/"))).toBe(true);
    expect(FILES.some((f) => f.endsWith(".swift"))).toBe(true);
    expect(FILES.some((f) => f.endsWith(".kt"))).toBe(true);
  }, 60_000);

  // The detector has to be able to FAIL, or the assertions above prove nothing
  // at all. A guard that passes on everything is a guard that passes forever.
  it("catches a real offence, including one wrapped across lines", () => {
    const wrapped = scannableText(
      `const copy = (
  "Hurry, you lost your streak" +
  "start again"
);`,
    );
    expect(REFUSED_LOSS_PHRASES.some((p) => wrapped.includes(p))).toBe(true);

    // ...and does NOT trip on the two shapes that must stay legal: a comment
    // explaining the rule, and an import of the approved copy.
    const commented = scannableText(
      `// never say "you lost your streak" here
export const ok = "Welcome back.";`,
    );
    expect(REFUSED_LOSS_PHRASES.some((p) => commented.includes(p))).toBe(false);

    const imported = scannableText(
      `import { STANDING_PRESERVED_COPY } from "@/lib/loyalty-copy";
export const ok = STANDING_PRESERVED_COPY;`,
    );
    expect(REFUSED_LOSS_PHRASES.some((p) => imported.includes(p))).toBe(false);
  });

  it("the refused list is non-empty and lowercase", () => {
    // A phrase with a capital in it would never match the lowercased haystack.
    // An entry that can never fire reads as protection and is not.
    expect(REFUSED_LOSS_PHRASES.length).toBeGreaterThan(10);
    for (const p of REFUSED_LOSS_PHRASES) {
      expect(p).toBe(p.toLowerCase());
      expect(p.trim()).toBe(p);
    }
  });
});
