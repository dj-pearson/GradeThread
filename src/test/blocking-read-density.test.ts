// US-3434: a loader that stops the page on three different reads is where the
// read-failure defect lives.
//
// WHY A DENSITY RULE RATHER THAN A PER-SITE REGISTRY. Blocking the page on a
// failed read is usually RIGHT: most of these files load one thing and that
// thing is what the page is for. Scanned 2026-09-20: 19 such sites across 15
// files, and 19 of them were correct. Registering all 19 would be ceremony
// nobody reads.
//
// What was NOT correct was the one file with FOUR. src/pages/submission-detail.tsx
// blocked on the dispute lookup (US-3427), the linked inventory item (US-3428)
// and the photos (US-3433), none of which is the grade report the seller came
// for. Three real defects, one file, and the count is what pointed at it --
// the third was found by running this scan rather than by a bug report.
//
// So the rule is the signal that worked: a file may block on two reads without
// explaining itself. A third means somebody should name the consumers, which is
// what vault/20-domain/read-failure-contract.md asks for.
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..", "..");
const ROOTS = ["src/pages", "src/components", "src/hooks"];
const LIMIT = 2;

/**
 * Files allowed more than LIMIT, each with the reason blocking is right.
 *
 * Like knownNoise in check-ui-antipatterns.mjs: an entry that stops matching
 * ALSO fails, so the list can only shrink.
 */
const ALLOWED: Record<string, string> = {
  "src/components/submission/camera-capture-dialog.tsx":
    "NOT A LOADER. All three sit in the capture ACTION handler — the camera is " +
    "not ready, the frame could not be grabbed, the encode failed — and each " +
    "offers the fallback (upload a photo instead, try again). There is no " +
    "primary content being withheld: the dialog's whole job is the capture " +
    "that just failed.",
};

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name === "__tests__") continue;
      out.push(...walk(p));
    } else if (/\.tsx?$/.test(name) && !/\.test\./.test(name)) {
      out.push(p);
    }
  }
  return out;
}

/** setError("…") followed within a few lines by a bare `return;`. */
function blockingSites(text: string): number {
  const lines = text.split("\n");
  let n = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (!/\bsetError\(/.test(line) || /setError\(null\)/.test(line)) continue;
    if (/^\s*return;/m.test(lines.slice(i, i + 4).join("\n"))) n++;
  }
  return n;
}

const counts = new Map<string, number>();
let total = 0;
for (const root of ROOTS) {
  for (const file of walk(join(ROOT, root))) {
    const n = blockingSites(readFileSync(file, "utf8"));
    if (n > 0) {
      counts.set(relative(ROOT, file).split("\\").join("/"), n);
      total += n;
    }
  }
}

describe("US-3434: blocking-read density", () => {
  it("found the sites at all (guards the guard)", () => {
    // Every assertion below passes on an empty scan, and the thing being
    // scanned for is a two-line shape that a refactor could rename.
    expect(total, "the scan matched nothing, so it proves nothing").toBeGreaterThan(10);
    expect(counts.size).toBeGreaterThan(5);
  });

  it("no file stops the page on more than two reads without saying why", () => {
    const over = [...counts.entries()]
      .filter(([f, n]) => n > LIMIT && !(f in ALLOWED))
      .map(([f, n]) => `${f} (${n})`)
      .sort();
    expect(
      over,
      "this file returns early on three or more failed reads. At least one of " +
        "them is probably not what the page is FOR — name the read's consumers, " +
        "withhold those and let the rest render (vault/20-domain/" +
        "read-failure-contract.md), or add the file to ALLOWED with the reason " +
        "every one of them is primary.",
    ).toEqual([]);
  });

  it("every ALLOWED entry still exceeds the limit, so the list can only shrink", () => {
    const stale = Object.keys(ALLOWED)
      .filter((f) => (counts.get(f) ?? 0) <= LIMIT)
      .sort();
    expect(
      stale,
      "an ALLOWED entry no longer blocks on more than two reads; delete it",
    ).toEqual([]);
  });

  it("submission-detail is down to its two primary reads", () => {
    // The file the rule came from. Both survivors are the page's subject: the
    // submission itself and its grade report. The dispute lookup, the linked
    // item and the photos were converted by US-3427, US-3428 and US-3433.
    expect(counts.get("src/pages/submission-detail.tsx")).toBe(2);
  });
});
