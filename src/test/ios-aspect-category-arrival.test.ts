// US-2274 AC3: a column value typed BEFORE a category is picked still reaches
// the aspect stores once one arrives.
//
// WHY THIS IS A GUARD AND NOT A FIX. AC3 says the projection must run even when
// the item has no eBay category, because `InventoryAspectSync.reassertDerived-
// Aspects` returns early on a blank `ebay_category_id`. The early return is
// real. What the criterion does not account for is that with no category there
// is no aspect SPEC, so there is nothing to project into - the derive endpoint
// needs a category id. Removing the guard would not project anything; it would
// send a request that cannot be answered.
//
// The property AC3 actually wants is about ARRIVAL, and it holds on both paths a
// category can arrive by:
//
//   1. THE EDITOR. Picking a category runs `applyCategoryChange`, which ends in
//      `refillDerived(categoryId:)` - the same `service.deriveAspects` call
//      `reassertDerivedAspects` makes. A Size typed with no category is picked
//      up the moment one is chosen.
//   2. THE AI PASS. The server persists `ebay_category_id` and `ebay_aspects`
//      TOGETHER, derived from the item's own columns; iOS only schedules a
//      follow-up pull (US-2270). There is nothing for the client to re-run.
//
// That was traced on 2026-08-22 and the story was deferred on the strength of
// it, with nothing holding it. This is the thing that holds it. The chain is
// three links and any one of them can be broken by an edit that looks local and
// reasonable - which is precisely the failure this story is about, since a
// broken chain produces a stale specifics editor and no error anywhere.

import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** Every .swift file under `dir`, repo-relative with forward slashes. */
function swiftSources(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(join(process.cwd(), dir), { withFileTypes: true })) {
    const p = `${dir}/${e.name}`;
    if (e.isDirectory()) out.push(...swiftSources(p));
    else if (e.name.endsWith(".swift")) out.push(p);
  }
  return out;
}

const SYNC = "ios/GradeThread/Marketplaces/Listing/InventoryAspectSync.swift";
const EDITOR = "ios/GradeThread/Marketplaces/Listing/SpecificsEditorModel.swift";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

/**
 * Comments are stripped before ANY scan. Both files name these functions while
 * explaining the rule - `InventoryAspectSync`'s header says "No-op when the item
 * has no eBay category selected yet" and `refillDerived`'s doc comment describes
 * the whole derive contract - so a raw scan passes against a deleted body.
 */
const stripSwift = (s: string) =>
  s.replace(/\r\n?/g, "\n").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

/**
 * The body of a Swift `func`, brace-balanced.
 *
 * The parameter list is walked with a PAREN counter before the opening brace is
 * looked for, because a defaulted parameter can carry its own parentheses -
 * `service: AspectsProviding = EbayAspectsService()` is exactly that, and taking
 * the first `{` after the function name would land on nothing at all here and on
 * a closure body in the general case.
 */
function funcBody(code: string, name: string): string {
  const decl = code.indexOf(`func ${name}(`);
  if (decl === -1) return "";
  let i = code.indexOf("(", decl);
  let paren = 0;
  for (; i < code.length; i++) {
    if (code[i] === "(") paren++;
    else if (code[i] === ")") {
      paren--;
      if (paren === 0) break;
    }
  }
  const open = code.indexOf("{", i);
  if (open === -1) return "";
  let brace = 0;
  for (let j = open; j < code.length; j++) {
    if (code[j] === "{") brace++;
    else if (code[j] === "}") {
      brace--;
      if (brace === 0) return code.slice(open + 1, j);
    }
  }
  return "";
}

const sync = stripSwift(read(SYNC));
const editor = stripSwift(read(EDITOR));

describe("US-2274 AC3: a category arriving later still picks up the columns", () => {
  it("finds a real body for every function this guard reads", () => {
    // Guards the guard. Every assertion below is a substring test on a body,
    // and a body extractor that silently returns "" turns each of them into a
    // test of the empty string - which reads exactly like agreement. Renaming
    // any of these three fails HERE, with a message naming the function, rather
    // than three files away as a mysterious substring miss.
    for (const [label, body] of [
      ["reassertDerivedAspects", funcBody(sync, "reassertDerivedAspects")],
      ["applyCategoryChange", funcBody(editor, "applyCategoryChange")],
      ["refillDerived", funcBody(editor, "refillDerived")],
      ["confirmCategoryChange", funcBody(editor, "confirmCategoryChange")],
    ] as const) {
      expect(body.length, `${label} body not found - this guard is reading nothing`).toBeGreaterThan(
        60,
      );
    }
  });

  it("the no-category early return is still deliberate, not accidental", () => {
    // Pinned as PRESENT rather than removed. This is the behaviour AC3
    // questioned and the trace vindicated: with no category there is no spec to
    // derive against. If someone deletes it, the derive call goes out with an
    // empty category id and the server answers nothing useful - a silent no-op
    // that costs a round trip on every save.
    const body = funcBody(sync, "reassertDerivedAspects");
    expect(body).toMatch(/guard[^\n]*ebay_category_id[\s\S]{0,80}?else \{ return \}/);
  });

  it("picking a category re-derives, which is what covers that early return", () => {
    // Link 1 of the chain. Without this call, a Size typed before the category
    // was chosen never reaches either aspect store on the editor path, and AC3
    // becomes a real bug instead of a traced non-issue.
    expect(funcBody(editor, "applyCategoryChange")).toContain("refillDerived(categoryId:");
  });

  it("the CONFIRMED category change routes through the same place", () => {
    // Link 2, and the easier one to lose. A change that needed confirmation is
    // the case where values were DROPPED for not applying to the new category,
    // so it is the one that most needs the refill. It gets it only because
    // confirmCategoryChange delegates rather than reimplementing.
    expect(funcBody(editor, "confirmCategoryChange")).toContain("applyCategoryChange(");
  });

  it("refillDerived calls the SAME derive entry point the sync does", () => {
    // Link 3. "It re-derives" is not enough - it has to re-derive through the
    // endpoint that applies the column authority, or the editor would refresh
    // its own view while the stores stayed stale.
    expect(funcBody(editor, "refillDerived")).toMatch(
      /service\.deriveAspects\(\s*itemId:\s*itemId,\s*categoryId:\s*categoryId/,
    );
  });

  it("there are exactly two derive call sites in app code, and they are these two", () => {
    // The structural half. AC3's answer rests on there being no THIRD path that
    // could arrive at a category without re-deriving. A new call site is not
    // necessarily wrong, but it is a new place this chain has to hold, so it
    // should fail here and be read rather than pass silently.
    // Walks the whole app tree rather than the two files this guard already
    // knows about - checking the known files for the count they obviously have
    // would prove nothing about a third one appearing somewhere else.
    const swift = swiftSources("ios/GradeThread");
    expect(swift.length, "found no Swift sources - the walk is reading nothing").toBeGreaterThan(
      100,
    );
    const callSites = swift
      .map((p) => ({ path: p, hits: [...stripSwift(read(p)).matchAll(/\.deriveAspects\(/g)].length }))
      .filter((f) => f.hits > 0)
      .map((f) => `${f.path}:${f.hits}`)
      .sort();
    expect(callSites).toEqual([`${EDITOR}:1`, `${SYNC}:1`].sort());
  });
});
