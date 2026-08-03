// US-2172: every bulk action on the listings table either offers an undo or
// says out loud that it cannot be undone.
//
// The failure this guards is a UI absence, which is the hardest kind to notice:
// a seller who bulk-archives 200 items and looks for Undo finds nothing, and
// nothing in the code is "wrong" — the feature simply is not there. So the
// wiring is asserted rather than trusted, in the same source-scan style as the
// other listings-page guards.
//
// The decision LOGIC lives in pure modules with their own unit tests
// (src/lib/bulk-status-undo.ts, and undoableFrom for the price path). This file
// only proves the page is actually connected to them.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// US-2173 AC2: the bulk handlers this scans became injected-dependency units in
// their own module. A source scan is file-path-bound, so it follows them. What is
// asserted is unchanged: an undo offered for every reversible bulk action, and an
// explicit "there is no undo" for the two that are not.
const FILE = "src/pages/flipdesk/listings-actions.ts";
const src = readFileSync(resolve(process.cwd(), FILE), "utf8");
// The confirm DIALOG copy stayed in the page — it is JSX. The promise it makes
// and the toast that repeats it are now in two files, and both halves matter:
// the dialog is where a seller decides, the toast is where they look for Undo.
const PAGE = "src/pages/flipdesk/listings.tsx";
const pageSrc = readFileSync(resolve(process.cwd(), PAGE), "utf8");

/** The body of one `async function name(...)` up to the next top-level one. */
function fn(name: string): string {
  const start = src.indexOf(`async function ${name}(`);
  if (start === -1) throw new Error(`No async function ${name} in ${FILE}`);
  const rest = src.slice(start);
  const end = rest.indexOf("\n  async function ", 1);
  return end === -1 ? rest.slice(0, 8000) : rest.slice(0, end);
}

describe("reversible bulk actions offer an undo", () => {
  it("the bulk price drop keeps its undo action", () => {
    const body = fn("bulkPriceDrop");
    expect(body).toContain("undoableFrom");
    expect(body).toContain('label: "Undo"');
  });

  it("the bulk status change offers an undo", () => {
    const body = fn("bulkSetStatus");
    expect(body).toContain("undoEntriesFor");
    expect(body).toContain('label: "Undo"');
  });

  it("the status undo records where each row came from", () => {
    const body = fn("bulkSetStatus");
    // Without previousStatus the undo has nothing to write back, and an undo
    // that restores a guessed value is worse than none.
    expect(body).toContain("previousStatus: it.status");
    // Captured only after the write SUCCEEDS — a failed row never changed.
    expect(body.indexOf("undoEntries.push")).toBeGreaterThan(body.indexOf("done++"));
  });

  it("the status undo re-reads current state instead of the cached array", () => {
    // The gap between the batch and the undo click is exactly where a sale
    // lands. Planning off `items` would restore a status over the top of one.
    const body = fn("undoBulkStatus");
    expect(body).toContain('.from("items_full")');
    expect(body).toContain("planStatusUndo");
    expect(body).not.toContain("items.find(");
  });

  it("the status undo names what it skipped", () => {
    // AC3: a silent partial undo leaves the seller believing the batch was
    // fully reversed.
    expect(fn("undoBulkStatus")).toContain("describeSkipped");
  });
});

describe("irreversible bulk actions say so", () => {
  it("bulk publish tells the seller there is no undo, and what to use instead", () => {
    const body = fn("bulkPublishToEbay");
    expect(body).toContain("Publishing can't be undone");
    expect(body).toContain("use End to take one down");
    // The absence of an Undo button is the point — offering one that no-ops is
    // the failure mode AC4 names.
    expect(body).not.toContain('label: "Undo"');
  });

  it("bulk delete says a delete is permanent, in the dialog and the toast", () => {
    // Whitespace-insensitive: this copy is JSX-wrapped and reflows on edit, so
    // matching the literal line breaks would fail on a reformat rather than on
    // the promise disappearing.
    expect(pageSrc.replace(/\s+/g, " ")).toContain("This can't be undone");
    expect(fn("bulkDeleteItems")).toContain("there's nothing to undo");
    expect(fn("bulkDeleteItems")).not.toContain('label: "Undo"');
  });
});

describe("the bulk edit dialog offers an undo", () => {
  const dialog = readFileSync(
    resolve(process.cwd(), "src/components/flipdesk/bulk-edit-dialog.tsx"),
    "utf8",
  );

  it("builds the undo from the response's prior values", () => {
    expect(dialog).toContain("bulkEditUndoItems(result.results)");
    expect(dialog).toContain('label: "Undo"');
  });

  it("sends the undo in the per-listing shape", () => {
    // A shared patch cannot express "a goes back to 30, b goes back to 12", so
    // an undo issued as a normal bulk edit would put every row on one price.
    expect(dialog.replace(/\s+/g, " ")).toContain("mutateAsync({ items:");
  });

  it("says how many rows could not be put back", () => {
    // Silently reverting 8 of 10 and reporting success is the failure this
    // whole story is about.
    expect(dialog).toContain("unrevertableEditCount");
    expect(dialog).toContain("can't be put back");
  });

  it("reports the undo's own per-row failures", () => {
    // Undo is a real marketplace push and can fail too.
    expect(dialog).toContain("couldn't be reverted");
  });
});

describe("the bulk edit endpoint contract", () => {
  const hook = readFileSync(resolve(process.cwd(), "src/hooks/use-ebay.ts"), "utf8");

  it("accepts both the shared-edit and per-listing shapes", () => {
    expect(hook).toContain('"items" in input');
    expect(hook).toContain("{ items: input.items }");
    expect(hook).toContain("{ listing_ids: input.listingIds, edit: input.edit }");
  });

  it("surfaces the per-row prior values the undo needs", () => {
    expect(hook).toContain("previous?: Record<string, unknown>");
  });
});
