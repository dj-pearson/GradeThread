import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

// US-2520. The web AutoLister was one 4,340-line file whose page component held
// 83 pieces of state, with a 2,425-line bulk editor and a 1,337-line queue
// beside it. iOS does the same product in four files totalling 2,130 lines.
//
// This is a shrink-only ratchet. The numbers below are what the files measure
// TODAY, and a change may lower them but never raise them. A ceiling that moves
// up on demand is not a ceiling.

const CEILINGS: Record<string, number> = {
  // Lowered from 3910 when the grouping-workbench tiles moved into
  // autolister/photo-drag-tiles.tsx. The ratchet had gone red at 3955 first,
  // which is the mechanism working: the file grew, and the answer was to take
  // something out rather than to make room. Lowered again from 3747 when
  // US-2621's selection bars pushed it to 3938 and the four toolbars moved into
  // autolister/workbench-toolbars.tsx — same mechanism, same answer. Lowered
  // again from 3698 when US-2769's missing-front check pushed it over and the
  // whole pre-generate checkpoint moved into autolister/group-warnings.ts.
  // Lowered again from 3657 when US-2450's per-photo labels pushed it over and
  // stagedSortName moved into autolister/staged-sort-name.ts — a pure function
  // that had just gained a second caller and now has its own tests. Lowered a
  // fourth time from 3655 in the same story's next batch, when the ten
  // tooltip-named icon buttons needed labels and filesFromDataTransfer moved
  // into autolister/files-from-data-transfer.ts.
  "src/pages/flipdesk/autolister.tsx": 3639,
  "src/pages/flipdesk/autolister-bulk-edit.tsx": 2010,
  "src/pages/flipdesk/autolister-queue.tsx": 1120,
};

function lineCount(rel: string): number {
  return readFileSync(resolve(process.cwd(), rel), "utf8").split("\n").length;
}

describe("the AutoLister surfaces only get smaller (US-2520)", () => {
  for (const [rel, ceiling] of Object.entries(CEILINGS)) {
    it(`${rel} stays at or under ${ceiling} lines`, () => {
      const actual = lineCount(rel);
      expect(
        actual,
        `${rel} is ${actual} lines, ceiling ${ceiling}. Extract a piece into ` +
          `src/pages/flipdesk/autolister/ rather than raising this number — ` +
          "the ceiling is the point.",
      ).toBeLessThanOrEqual(ceiling);
    });
  }

  it("the ceilings are not quietly slack", () => {
    // A ratchet nobody tightens is a ratchet that stops working. If a file has
    // dropped well below its ceiling, lower the ceiling in the same commit.
    for (const [rel, ceiling] of Object.entries(CEILINGS)) {
      const actual = lineCount(rel);
      expect(
        ceiling - actual,
        `${rel} is ${ceiling - actual} lines under its ceiling — lower it`,
      ).toBeLessThan(200);
    }
  });
});

describe("the extracted pieces are real modules (US-2520)", () => {
  const DIR = "src/pages/flipdesk/autolister";

  it("each extracted file stays small enough to read in one sitting", () => {
    const files = readdirSync(resolve(process.cwd(), DIR)).filter((f) =>
      f.endsWith(".tsx"),
    );
    expect(files.length).toBeGreaterThanOrEqual(6);
    for (const f of files) {
      const n = lineCount(`${DIR}/${f}`);
      expect(n, `${f} is ${n} lines — split it further`).toBeLessThan(500);
    }
  });

  it("nothing extracted reaches back into page state", () => {
    // These are prop-only renderers. A query or a store subscription inside one
    // would put page state back where it just came from — and would reopen the
    // "change one part, re-render the whole surface" problem the split exists
    // to fix. The upload panel's clearTasks is the one allowed exception: it is
    // a store ACTION, not a subscription, so it re-renders nothing.
    const files = readdirSync(resolve(process.cwd(), DIR)).filter((f) =>
      f.endsWith(".tsx"),
    );
    for (const f of files) {
      const src = readFileSync(resolve(process.cwd(), `${DIR}/${f}`), "utf8");
      expect(src, `${f} runs a query`).not.toMatch(/useQuery\(/);
      expect(src, `${f} subscribes to a store`).not.toMatch(
        /use[A-Za-z]*Store\((?!\s*\))/,
      );
    }
  });
});

describe("a batch in flight is navigable (US-2520)", () => {
  const NAV = "src/pages/flipdesk/autolister/batch-nav.tsx";

  it("the nav links all three surfaces and carries the batch", () => {
    const src = readFileSync(resolve(process.cwd(), NAV), "utf8");
    for (const path of [
      "/dashboard/flipdesk/autolister",
      "/dashboard/flipdesk/autolister/queue",
      "/dashboard/flipdesk/autolister/bulk-edit",
    ]) {
      expect(src).toContain(`"${path}"`);
    }
    expect(src).toMatch(/\$\{step\.path\}\?batch=\$\{batchId\}/);
    // Nothing to navigate before a batch exists.
    expect(src).toMatch(/if \(!batchId\) return null/);
  });

  it("all three pages render it, each marking its own step", () => {
    const pages: [string, string][] = [
      ["src/pages/flipdesk/autolister.tsx", "generate"],
      ["src/pages/flipdesk/autolister-queue.tsx", "queue"],
      ["src/pages/flipdesk/autolister-bulk-edit.tsx", "bulk-edit"],
    ];
    for (const [rel, step] of pages) {
      const src = readFileSync(resolve(process.cwd(), rel), "utf8");
      expect(src, `${rel} does not render the batch nav`).toContain(
        `current="${step}"`,
      );
    }
  });
});
