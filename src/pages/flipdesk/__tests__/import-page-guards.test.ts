import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// Source pins for the Import page behaviors that have no pure helper to call.

const PAGE = "src/pages/flipdesk/import.tsx";
function read(rel: string): string {
  return readFileSync(resolve(process.cwd(), rel), "utf8");
}

describe("import page: a file too big for one import (IMP-07)", () => {
  it("turns a 413 or a row-cap 400 into one plain instruction", () => {
    const src = read(PAGE);
    expect(src).toContain(
      "This file is too big for one import. Split it into files of 5,000 rows or fewer.",
    );
    expect(src).toMatch(/res\.status === 413/);
    expect(src).toMatch(/throw new Error\(TOO_BIG_MESSAGE\)/);
  });
});

describe("import page: permission (IMP-09)", () => {
  it("computes canImport once and disables Import, Reset and Undo with a reason", () => {
    const src = read(PAGE);
    expect(src).toMatch(/const canImport = can\("manage_inventory"\)/);
    expect(src.match(/can\("manage_inventory"\)/g)?.length).toBe(1);
    expect(src).toMatch(/onClick=\{handleImport\}\s+disabled=\{importing \|\| !canImport/);
    expect(src).toMatch(/disabled=\{undoingId !== null \|\| !canImport\}/);
    expect(src).toMatch(/\{!canImport && \(/);
    expect(src).toContain("Importing and undoing need inventory access in this workspace.");
  });
});

describe("import page: a poll that can never succeed (IMP-02)", () => {
  it("drops the run and its ?run= param, so the source picker is not left disabled", () => {
    const src = read(PAGE);
    const stop = src.slice(src.indexOf('decision.kind === "stop"'));
    const branch = stop.slice(0, stop.indexOf("return;"));
    expect(branch).toMatch(/setRun\(null\)/);
    expect(branch).toMatch(/next\.delete\("run"\)/);
    // The message renders outside the progress card, which unmounts with the run.
    expect(src).toMatch(/\{pollError && \(\s*<p role="alert"/);
  });

  it("shows an undo's counts only under the run that was undone", () => {
    const src = read(PAGE);
    expect(src).toMatch(/setLastUndo\(\{ \.\.\.json, runId: target\.id \}\)/);
    expect(src).toMatch(/lastUndo\?\.runId === run\.id/);
    expect(src).toMatch(/\{canUndoRun\(run\) && \(/);
  });
});
