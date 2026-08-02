// US-2028: dialogs must clamp their height with dvh, never vh.
//
// On mobile Safari `vh` is the LARGE viewport height — it ignores the
// collapsing URL bar — so `max-h-[90vh]` on a dialog overflows the actually
// visible area and the primary CTA can sit underneath browser chrome. The plan
// picker and credit-pack dialogs are on the payment path, so this was a
// revenue bug, not a cosmetic one.
//
// The base DialogContent has always been correct (max-h-[calc(100dvh-2rem)]);
// ~20 call sites overrode it with vh. Those were all converted, and this guard
// exists so they cannot come back — which is the part a find-and-replace alone
// does not buy. The next person copying an existing dialog is the one this
// protects.
//
// WHY A STATIC GUARD RATHER THAN A BROWSER TEST: headless Chromium has no
// collapsing URL bar, so dvh and vh resolve identically there and a Playwright
// assertion would pass for both spellings — it would prove nothing about the
// bug. The spelling IS the property here, so the source is the right thing to
// assert against.

import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { SCAN_TIMEOUT_MS } from "@/lib/__tests__/_source-scan";

const SRC = join(process.cwd(), "src");

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === "node_modules") continue;
      walk(full, out);
    } else if (/\.(tsx|ts)$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

// US-2383: memoized per worker. The walk is cheap idle and expensive under a
// full parallel run — the same shape that made composer-locks.test.ts flake at
// vitest's 5000ms default. Reading the list once and giving the scan
// SCAN_TIMEOUT_MS (US-2129's measured 30s) removes the timing dependency
// without changing what is scanned.
let cachedFiles: string[] | null = null;
function sourceFiles(): string[] {
  if (!cachedFiles) cachedFiles = walk(SRC);
  return cachedFiles;
}

// Only CLAMPS are the problem. `min-h-[60vh]` is a floor and `h-[70vh]` on a
// non-dialog element (an admin preview iframe) is a fixed box — neither can
// hide a CTA behind browser chrome the way a max-height clamp can. Matching
// those too would force noisy, meaningless churn and teach people to ignore
// this test.
const MAX_H_VH = /max-h-\[[^\]]*\d+vh[^\]]*\]/g;

describe("US-2028: dialog height clamps use dvh, not vh", () => {
  it("no file clamps max-height in vh", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles()) {
      // Don't flag this guard's own documentation of the pattern.
      if (file.endsWith("dialog-dynamic-viewport.test.ts")) continue;
      const src = readFileSync(file, "utf8");
      const hits = src.match(MAX_H_VH);
      if (hits) {
        offenders.push(`${file.replace(process.cwd(), "")}: ${[...new Set(hits)].join(", ")}`);
      }
    }

    expect(
      offenders,
      "max-h-[Nvh] hides content behind mobile browser chrome — use dvh " +
        "(the base DialogContent already does: max-h-[calc(100dvh-2rem)]).\n" +
        offenders.join("\n"),
    ).toEqual([]);
  }, SCAN_TIMEOUT_MS);

  it("the base DialogContent still clamps in dvh", () => {
    // If this ever regresses, every dialog that DOESN'T override inherits the
    // bug — so the base is worth pinning separately from the call sites.
    const base = readFileSync(join(SRC, "components/ui/dialog.tsx"), "utf8");
    expect(base).toMatch(/max-h-\[calc\(100dvh/);
  });
});
