import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// Reported on a device: after an AutoLister run, tapping any listing in the
// drafts list opened a bulk-edit grid of the whole batch rather than that
// listing.
//
// It was deliberate once. US-681's comment said the push was
// `DraftsBulkEditView(batchId:)` "instead of being a dead row": a reasonable
// call when the row did nothing, and the wrong one as soon as a batch held
// twenty drafts. The grid also edits only title / price / condition / category,
// so a tap aimed at photos, measurements, specifics or the description landed
// somewhere that cannot edit any of them.
//
// Swift does not compile on this machine, so iOS CI stays the safety net for
// anything that has to BUILD. What is answerable by reading is where a tap
// goes, and that is the half that was wrong.

const LIBRARY = "ios/GradeThread/AutoLister/Drafts/DraftsLibraryView.swift";
const CANVAS = "ios/GradeThread/Inventory/ItemCanvas/ItemCanvasView.swift";

function read(rel: string): string {
  return readFileSync(resolve(process.cwd(), rel), "utf8").replace(/\r\n?/g, "\n");
}

/**
 * Blank out comments, preserving offsets and line count.
 *
 * This matters more than usual here. The fix's own comment NAMES the call it
 * removed, `DraftsBulkEditView(batchId:)`, because a reader deserves to know
 * what used to be there and why it moved. A scan that reads comments would find
 * that string and report the bug as still present, forever, and the only way to
 * quiet it would be to delete the explanation. That is failure mode 7: the
 * guard fires on the documentation written about it.
 */
function stripComments(src: string): string {
  let out = "";
  let i = 0;
  let inString = false;
  while (i < src.length) {
    const c = src[i];
    const next = src[i + 1];
    if (inString) {
      if (c === "\\") {
        out += "  ";
        i += 2;
        continue;
      }
      if (c === '"') inString = false;
      out += c;
      i++;
      continue;
    }
    if (c === '"') {
      inString = true;
      out += c;
      i++;
      continue;
    }
    if (c === "/" && next === "/") {
      while (i < src.length && src[i] !== "\n") {
        out += " ";
        i++;
      }
      continue;
    }
    if (c === "/" && next === "*") {
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) {
        out += src[i] === "\n" ? "\n" : " ";
        i++;
      }
      out += "  ";
      i += 2;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/** The `ForEach` that draws one row per draft, code only. */
function rowBlock(src: string): string {
  const code = stripComments(src);
  const start = code.indexOf("ForEach(store.filtered(matching: search))");
  expect(start, "the drafts ForEach was renamed; this guard is now blind").toBeGreaterThan(-1);
  const end = code.indexOf("} header: {", start);
  expect(end, "the ForEach's section header moved; this guard is now blind").toBeGreaterThan(start);
  return code.slice(start, end);
}

describe("the stripper actually strips", () => {
  // Asserting the intermediate, because a stripper that silently does nothing
  // makes every assertion below pass against broken code.
  it("removes a line comment and keeps a lookalike inside a string", () => {
    const src = 'let a = 1 // DraftsBulkEditView(batchId: draft.batchId)\nlet b = "// not a comment"\n';
    const stripped = stripComments(src);
    expect(stripped).not.toContain("DraftsBulkEditView");
    expect(stripped).toContain('"// not a comment"');
    expect(stripped.split("\n").length).toBe(src.split("\n").length);
  });

  it("removes a block comment and preserves the line count", () => {
    const src = "let a = 1\n/* ItemCanvasView(item:\n   more */\nlet b = 2\n";
    const stripped = stripComments(src);
    expect(stripped).not.toContain("ItemCanvasView");
    expect(stripped.split("\n").length).toBe(src.split("\n").length);
  });

  it("the real file still contains its explanation, and the code does not", () => {
    // Both halves. The comment must survive (it is the record of why the push
    // changed) and it must not be what satisfies the assertions.
    const raw = read(LIBRARY);
    expect(raw).toContain("US-681");
    expect(stripComments(raw)).not.toContain("US-681");
  });
});

describe("a drafts row opens its own item", () => {
  it("the row pushes the item destination", () => {
    expect(rowBlock(read(LIBRARY))).toContain("DraftItemDestination(");
  });

  it("the row does not push the batch editor", () => {
    // The actual regression. Scoped to the ForEach, because the batch editor is
    // still legitimately constructed twice elsewhere in this file.
    expect(rowBlock(read(LIBRARY))).not.toContain("DraftsBulkEditView(");
  });

  it("the destination is handed the row's own item id", () => {
    const row = rowBlock(read(LIBRARY));
    expect(row).toContain("inventoryItemId: draft.inventoryItemId");
  });
});

describe("the destination resolves the id to the model the canvas needs", () => {
  it("ItemCanvasView still takes a LocalInventoryItem, not an id", () => {
    // If this ever loosens to an id, the whole bridge below is dead weight and
    // should go, but nothing else in the repo would say so.
    expect(stripComments(read(CANVAS))).toContain("init(item: LocalInventoryItem)");
  });

  it("the bridge queries the item by id and shows the canvas", () => {
    const code = stripComments(read(LIBRARY));
    const start = code.indexOf("private struct DraftItemDestination");
    expect(start, "DraftItemDestination is gone").toBeGreaterThan(-1);
    const destination = code.slice(start);
    expect(destination).toContain("Query(filter: #Predicate<LocalInventoryItem> { $0.id == id })");
    expect(destination).toContain("ItemCanvasView(item: item)");
  });

  it("a not-yet-synced item asks for a pull instead of dead-ending", () => {
    // AutoLister creates items server-side and posts no pull of its own, so a
    // seller walking straight from a finished run into Drafts can outrun the
    // sync. @Query is live, so the ask is all that is needed: the canvas
    // appears by itself when the merge lands.
    const code = stripComments(read(LIBRARY));
    const destination = code.slice(code.indexOf("private struct DraftItemDestination"));
    expect(destination).toContain("NotificationCenter.default.post(name: .inventoryPullRequested");
    expect(destination, "the fallback should still reach the batch editor").toContain(
      "DraftsBulkEditView(batchId: batchId)",
    );
  });
});

describe("the batch editor US-681 added is still reachable", () => {
  it("the toolbar opens it across every draft", () => {
    expect(stripComments(read(LIBRARY))).toContain("DraftsBulkEditView()");
  });

  it("the row's leading swipe opens it scoped to that batch", () => {
    const row = rowBlock(read(LIBRARY));
    expect(row).toContain("swipeActions(edge: .leading");
    expect(row).toContain("swipedBatchId = draft.batchId");
    // A swipe action cannot hold a NavigationLink, so the state it sets has to
    // be wired to a destination or the swipe is a no-op that looks fine.
    expect(stripComments(read(LIBRARY))).toContain(
      "navigationDestination(item: $swipedBatchId)",
    );
  });

  it("the trailing Listing Kit swipe survived the change", () => {
    const row = rowBlock(read(LIBRARY));
    expect(row).toContain("swipeActions(edge: .trailing");
    expect(row).toContain("draftsSheet = .listingKit(");
  });
});
