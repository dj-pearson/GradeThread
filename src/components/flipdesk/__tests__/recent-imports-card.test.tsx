import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { RecentImportsCard } from "@/components/flipdesk/recent-imports-card";
import { canUndoRun, importOriginLabel, isOpenRun, type ImportRun } from "@/hooks/use-import-runs";

// IMP-10: the Recent imports list and the page's resume-on-mount.

function run(over: Partial<ImportRun>): ImportRun {
  return {
    id: "r1",
    status: "completed",
    origin: "csv",
    total_rows: 3,
    processed_rows: 3,
    inserted_count: 2,
    updated_count: 1,
    skipped_count: 0,
    failed_count: 0,
    created_at: "2026-09-20T12:00:00Z",
    ...over,
  };
}

describe("recent imports helpers", () => {
  it("labels spreadsheet and closet origins", () => {
    expect(importOriginLabel("sheet")).toBe("Google Sheet");
    expect(importOriginLabel("paste")).toBe("Pasted rows");
    expect(importOriginLabel("poshmark")).toBe("Poshmark closet");
  });

  it("offers undo only for a finished run with something to put back", () => {
    expect(canUndoRun(run({}))).toBe(true);
    expect(canUndoRun(run({ status: "failed" }))).toBe(true);
    expect(canUndoRun(run({ status: "running" }))).toBe(false);
    // An undo in progress blocks a second one...
    const claimed = Date.parse("2026-09-21T00:00:00Z");
    expect(canUndoRun(run({ undone_at: "2026-09-21T00:00:00Z" }), claimed + 60_000)).toBe(false);
    // ...until its claim is stale, which means the undo died mid-way.
    expect(canUndoRun(run({ undone_at: "2026-09-21T00:00:00Z" }), claimed + 11 * 60_000)).toBe(true);
    expect(canUndoRun(run({ status: "undone", undone_at: "2026-09-21T00:00:00Z" }))).toBe(false);
    expect(canUndoRun(run({ inserted_count: 0, updated_count: 0 }))).toBe(false);
    expect(isOpenRun(run({ status: "pending" }))).toBe(true);
  });
});

describe("RecentImportsCard", () => {
  it("renders one row per run with counts and an Undo for undoable runs", () => {
    const html = renderToStaticMarkup(
      <RecentImportsCard
        runs={[
          run({ id: "a", origin: "poshmark" }),
          run({ id: "b", status: "undone", undone_at: "2026-09-21T00:00:00Z" }),
        ]}
        onUndo={() => {}}
        undoingId={null}
        canUndo
      />,
    );
    expect(html).toContain("Recent imports");
    expect(html).toContain("Poshmark closet");
    expect(html).toContain("2 new, 1 filled");
    expect(html.match(/>Undo</g)?.length).toBe(1);
  });

  it("disables Undo for a member without inventory access", () => {
    const html = renderToStaticMarkup(
      <RecentImportsCard runs={[run({})]} onUndo={() => {}} undoingId={null} canUndo={false} />,
    );
    expect(html).toMatch(/<button[^>]*disabled/);
  });

  it("renders nothing with no runs", () => {
    expect(
      renderToStaticMarkup(
        <RecentImportsCard runs={[]} onUndo={() => {}} undoingId={null} canUndo />,
      ),
    ).toBe("");
  });
});

describe("the import page resumes and keeps runs (IMP-10)", () => {
  const src = readFileSync(resolve(process.cwd(), "src/pages/flipdesk/import.tsx"), "utf8");

  it("reads ?run= and the newest open run on mount", () => {
    expect(src).toMatch(/searchParams\.get\("run"\)/);
    expect(src).toMatch(/recentData\.find\(isOpenRun\)/);
  });

  it("writes ?run= when a run starts from a file or a closet read", () => {
    expect(src.match(/rememberRun\(/g)?.length).toBeGreaterThanOrEqual(3);
  });

  it("loading a file or pressing Reset never clears the last run", () => {
    const detect = src.slice(src.indexOf("function detectFromText("), src.indexOf("const mappedRows"));
    expect(detect).not.toContain("setRun(null)");
    const at = src.indexOf("setLoaded(null);");
    expect(at).toBeGreaterThan(0);
    const reset = src.slice(at, at + 200);
    expect(reset).not.toContain("setRun(null)");
  });

  it("renders the Recent imports card", () => {
    expect(src).toContain("<RecentImportsCard");
  });
});
