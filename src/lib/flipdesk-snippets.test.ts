// US-2961: the snippet list's pure rules.
//
// Validation, ordering and the summary line, tested directly. The Supabase
// calls beside them are three-line wrappers whose only interesting property is
// the RLS policy behind them, which lives in migration 00678 and is asserted by
// rls-guard_test.ts on the edge — testing them here would test the mock.
import { describe, expect, it } from "vitest";
import {
  applySummary,
  bodyProblem,
  nameProblem,
  nextSortOrder,
  reorderSnippets,
  snippetNames,
  sortSnippets,
  SNIPPET_BODY_MAX,
  SNIPPET_NAME_MAX,
} from "@/lib/flipdesk-snippets";
import type { ListingSnippetRow } from "@/types/database";

const row = (over: Partial<ListingSnippetRow> = {}): ListingSnippetRow => ({
  id: "s1",
  user_id: "u1",
  name: "Shipping promise",
  body: "Ships within one business day.",
  sort_order: 0,
  created_at: "2026-08-27T00:00:00Z",
  updated_at: "2026-08-27T00:00:00Z",
  ...over,
});

const three = (): ListingSnippetRow[] => [
  row({ id: "a", name: "Shipping", sort_order: 0 }),
  row({ id: "b", name: "Bundles", sort_order: 1 }),
  row({ id: "c", name: "Returns", sort_order: 2 }),
];

describe("nameProblem (US-2961)", () => {
  it("wants a name", () => {
    expect(nameProblem("   ", [])).toBe("Give it a name.");
  });

  it("caps the length", () => {
    expect(nameProblem("x".repeat(SNIPPET_NAME_MAX + 1), [])).toContain(
      String(SNIPPET_NAME_MAX),
    );
    expect(nameProblem("x".repeat(SNIPPET_NAME_MAX), [])).toBeNull();
  });

  it("refuses a duplicate, ignoring case and surrounding space", () => {
    expect(nameProblem("  shipping  ", three())).toBe(
      "You already have one with that name.",
    );
  });

  it("does not count the row being edited against itself", () => {
    // Otherwise reopening a snippet and pressing Save would report its own name
    // as taken, which is the shape of bug that makes an editor feel broken.
    expect(nameProblem("Shipping", three(), "a")).toBeNull();
  });
});

describe("bodyProblem (US-2961)", () => {
  it("wants something to say", () => {
    expect(bodyProblem("\n  ")).toBe("Write what it should say.");
  });

  it("caps the length", () => {
    expect(bodyProblem("x".repeat(SNIPPET_BODY_MAX + 1))).toContain("stop at");
    expect(bodyProblem("x".repeat(SNIPPET_BODY_MAX))).toBeNull();
  });
});

describe("ordering (US-2961)", () => {
  it("puts a new snippet after everything that exists", () => {
    expect(nextSortOrder(three())).toBe(3);
    expect(nextSortOrder([])).toBe(0);
  });

  it("moves one row and restamps every sort_order densely", () => {
    const out = reorderSnippets(three(), 2, 0);
    expect(out.map((s) => s.id)).toEqual(["c", "a", "b"]);
    expect(out.map((s) => s.sort_order)).toEqual([0, 1, 2]);
  });

  it("restamps even when the move is a no-op", () => {
    // Rows created before this feature all carry sort_order 0, so a list that
    // has never been reordered has no total order at all. Restamping on any
    // pass through here is what gives it one.
    const flat = three().map((s) => ({ ...s, sort_order: 0 }));
    expect(reorderSnippets(flat, 1, 1).map((s) => s.sort_order)).toEqual([0, 1, 2]);
    expect(reorderSnippets(flat, -1, 9).map((s) => s.sort_order)).toEqual([0, 1, 2]);
  });

  it("sorts by sort_order, then name, then id", () => {
    const tied = [
      row({ id: "z", name: "Bundles", sort_order: 0 }),
      row({ id: "y", name: "Alpha", sort_order: 0 }),
      row({ id: "x", name: "Returns", sort_order: -1 }),
    ];
    expect(sortSnippets(tied).map((s) => s.id)).toEqual(["x", "y", "z"]);
  });
});

describe("snippetNames (US-2961)", () => {
  it("maps id to name, which is what a composer row labels itself from", () => {
    expect(snippetNames(three())).toEqual({
      a: "Shipping",
      b: "Bundles",
      c: "Returns",
    });
  });
});

describe("applySummary (US-2961)", () => {
  it("says plainly when nothing referenced it", () => {
    expect(applySummary({ applied: 0, skipped: 0, truncated: false })).toBe(
      "No open drafts use this one yet.",
    );
  });

  it("counts what changed", () => {
    expect(applySummary({ applied: 1, skipped: 0, truncated: false })).toBe(
      "Updated 1 draft.",
    );
    expect(applySummary({ applied: 4, skipped: 0, truncated: false })).toBe(
      "Updated 4 drafts.",
    );
  });

  it("accounts for the drafts that kept their own wording", () => {
    // A per-listing override is deliberate, so a draft carrying one is left
    // alone. Saying so is what stops "it only updated 3 of 5" reading as a bug.
    expect(applySummary({ applied: 3, skipped: 1, truncated: false })).toBe(
      "Updated 3 drafts. 1 kept its own wording.",
    );
    expect(applySummary({ applied: 3, skipped: 2, truncated: false })).toBe(
      "Updated 3 drafts. 2 kept their own wording.",
    );
  });

  it("says when there is more to do", () => {
    expect(applySummary({ applied: 200, skipped: 0, truncated: true })).toContain(
      "run it again",
    );
  });
});
