// US-2960: the two composer wirings that fail SILENTLY.
//
//   1. ORDER INSIDE saveDraft. The description is rendered from the item and
//      listing rows, so the render has to run after both writes. Put it first
//      and every derived block prints the brand, the size and the measurements
//      the seller just replaced — and nothing errors, nothing warns, and the
//      draft looks saved. Only the buyer sees it.
//   2. THE DELETED WARNING. The stale-description reminder compared item
//      specifics against prose that restated them. The attributes block derives
//      those values from the very columns the specific writes, so the drift it
//      warned about cannot happen and the warning would fire on nothing.
//
// Source-scanned, like the composer's other wiring guards: mounting the page
// needs Supabase, eBay taxonomy, seven hooks and a query client, and the failure
// mode here is exactly the silent kind a blunt guard is for.
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { composerPage as src } from "@/lib/__tests__/helpers/composer-source";

/**
 * Drop comments before searching.
 *
 * A dead symbol's NAME survives in the note explaining why it was deleted, and
 * that note is worth keeping — this guard and the anchors test both carry one.
 * What must not survive is a live reference, so the scan reads code only.
 */
function stripComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(entry)) out.push(full);
  }
  return out;
}

describe("saveDraft renders the description LAST (US-2960)", () => {
  const start = src.indexOf("async function saveDraft(");
  // To the function's closing brace, found as the first line that dedents back
  // to the component's own level and is followed by another declaration.
  // Brace-counting would break on the first arrow function anyone adds.
  const rest = src.slice(start);
  const closed = rest.search(/\n {2}\}\n\n {2}(?:async )?function /);
  const body = rest.slice(0, closed > 0 ? closed : rest.length);

  it("finds the save path at all", () => {
    expect(start).toBeGreaterThan(0);
    expect(body).toContain("descriptionBlocks.save(listingId)");
  });

  it("calls the description route after the item write", () => {
    const item = body.indexOf('.from("inventory_items")');
    const save = body.indexOf("descriptionBlocks.save(listingId)");
    expect(item).toBeGreaterThan(0);
    expect(save).toBeGreaterThan(item);
  });

  it("calls the description route after the LAST listing write", () => {
    // Both branches count — the update on an existing row and the insert that
    // creates one. The render has to follow whichever ran.
    const lastListingWrite = body.lastIndexOf('.from("listings")');
    const save = body.indexOf("descriptionBlocks.save(listingId)");
    expect(lastListingWrite).toBeGreaterThan(0);
    expect(save).toBeGreaterThan(lastListingWrite);
  });
});

describe("the stale-description reminder is gone (US-2960)", () => {
  // This file names the dead symbols in the list below, which is code rather
  // than comment, so it has to exclude itself or it reports its own guard.
  const SELF = "description-blocks-composer.test.ts";
  const files = walk(join(process.cwd(), "src")).filter((f) => !f.endsWith(SELF));

  for (const symbol of [
    "descriptionMentions",
    "specDescMismatches",
    "SHARED_DESC_FIELDS",
    "SHARED_FIELD_LABELS",
    "sharedValuesFromAspects",
  ]) {
    it(`has no reference to ${symbol} anywhere under src/`, () => {
      const hits = files
        .filter((f) => stripComments(readFileSync(f, "utf8")).includes(symbol))
        .map((f) => f.replace(process.cwd(), ""));
      expect(hits).toEqual([]);
    });
  }

  it("no longer renders the amber out-of-date notice", () => {
    expect(src).not.toContain("the description may be out of date");
  });
});

describe("the composer hands the card blocks, not a string (US-2960)", () => {
  it("passes the block array and the rendered preview", () => {
    const at = src.indexOf("<DescriptionCard");
    expect(at).toBeGreaterThan(0);
    const call = src.slice(at, src.indexOf("/>", at));
    for (const prop of [
      "blocks={descriptionBlocks.blocks}",
      "onBlocksChange={descriptionBlocks.setBlocks}",
      "preview={descriptionBlocks.preview}",
      "onGoToField={focusSection}",
    ]) {
      expect(call, prop).toContain(prop);
    }
    expect(call).not.toContain("setDescription={setDescription}");
  });

  it("routes every whole-description writer through the blocks", () => {
    // A string that only reached `description` would be rendered away by the
    // next save, which is the whole point of blocks being the source of truth.
    expect(src).toContain("function applyDescriptionText(next: string)");
    expect(src).toContain("applyWholeText(");
    const template = src.slice(
      src.indexOf("function applyTemplate()"),
      src.indexOf("function appendKeyword("),
    );
    expect(template).toContain("applyDescriptionText(");
    expect(template).not.toContain("setDescription(");
  });
});
