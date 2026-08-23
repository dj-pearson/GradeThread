import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { auditDistinctness, auditRepeatedText } from "../../scripts/audit-control-labels.mjs";

// US-2450: a name that does not DISTINGUISH is not a usable name.
//
// This is the sibling of control-labels.test.ts and it asks the opposite
// question. That one asks whether a control has a name at all, and its answer is
// zero. This one asks whether the name says WHICH one — because a table of two
// hundred rows where every price field announces "Price" passes that first test
// perfectly and is unusable.
//
// THREE WAYS A CONTROL GETS ITS NAME, and a scan that knows only the first will
// report a screen full of this defect as clean. All three were found in one file:
//
//   aria-label="Price"          the obvious one
//   title="Clean background"    on an icon-only button the TITLE is the name,
//                               and audit-control-labels correctly counts it as
//                               a name — it is just the same one on every photo
//   <Button>Generate</Button>   visible text is a name too, so every group card
//                               announced "Generate"
//
// A `title` BESIDE an aria-label is a visual tooltip and is correct, so those are
// skipped. Counting them is what made autolister.tsx still report twelve
// findings after every control in it had been fixed — a number that would have
// gone into a work list as though it were work.
//
// VISIBLE BUTTON TEXT — UNGUARDED SINCE US-2450, GUARDED SINCE 2026-08-23.
//
// This header used to end "there is no guard on that shape". There is one now:
// `auditRepeatedText`, which found 96 on the day it was written. How it got
// there is worth keeping, because three attempts failed first.
//
// Two halves have to be right. Scoping to `.map()` bodies is what stops it
// flagging every button on every page, and that half was the easy one. The hard
// half is finding where the OPENING TAG ENDS:
//       1. `<Button([^>]*)>` breaks on `onClick={() => setPeriod(p)}`, whose
//          `>` is not the tag's. It reported button bodies like
//          `setPeriod(p)}\n >` across a dozen admin files — the same garbage
//          the earlier attempt produced, from the same cause.
//       2. Reusing `tagAttrs`, which brace-counts correctly, failed WORSE: the
//          scan matched nothing at all and reported a confident ZERO. A broken
//          scan and a clean codebase produce identical output, and the only
//          thing that told them apart was the probe's own self-test against a
//          synthetic positive. That is why the case below pins four directions.
//
// So it PARSES instead of matching. TypeScript is already a dependency and
// hands over the tag boundary, the attribute list and the children for free.
//
// WHAT THIS STILL CANNOT SEE, stated so nobody reads more into a green run:
//   • a text INPUT, whose value is announced along with its label, so
//     aria-label="Alert name" on a field containing "Nike jackets" already
//     distinguishes. Those are counted here anyway — conservative in the
//     direction of over-reporting, which is why the baseline is a number rather
//     than zero.

// 36 → 20 on 2026-08-23 (US-2834). Sixteen of the sixteen removed were the
// one shape a scan can be certain about — a constant string aria-label on a
// control inside a `.map()` — and that subset now holds at ZERO below, so
// this number only covers the shapes the header calls conservative.
const BASELINE = 20;

// US-2834: the visible-text shape, guarded for the first time on 2026-08-23.
// 96 when the check landed, 89 an hour later once the seller-facing eBay
// lifecycle rows were named — linking the wrong listing, ending the wrong
// promotion and unscheduling the wrong drop all cost money, so those went
// first. A budget rather than a floor (see the case that uses it), and it only
// goes down.
const TEXT_BASELINE = 73;

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx$/.test(entry)) out.push(p);
  }
  return out;
}

const isTest = (f: string) =>
  /[\\/]test[\\/]/.test(f) || /__tests__/.test(f) || /\.test\.tsx?$/.test(f);

/** Each `.map(` body, by paren balance — "inside a repeated element" measured. */
function mapBodies(src: string): Array<{ start: number; body: string }> {
  const out: Array<{ start: number; body: string }> = [];
  for (const m of src.matchAll(/\.map\s*\(/g)) {
    let i = (m.index ?? 0) + m[0].length;
    const start = i;
    let depth = 1;
    while (i < src.length && depth > 0) {
      const c = src[i];
      if (c === "(") depth++;
      else if (c === ")") depth--;
      i++;
    }
    if (depth === 0) out.push({ start, body: src.slice(start, i) });
  }
  return out;
}

/** The JSX element a match sits in: back to its `<`, forward to its `>`. */
function elementAround(body: string, index: number): string {
  const open = body.lastIndexOf("<", index);
  let close = index;
  let depth = 0;
  while (close < body.length) {
    const c = body[close];
    if (c === "{") depth++;
    else if (c === "}") depth--;
    else if (c === ">" && depth === 0) break;
    close++;
  }
  return body.slice(open < 0 ? 0 : open, close + 1);
}

function auditFile(src: string): number {
  if (!src.includes(".map(")) return 0;
  const seen = new Set<number>();
  let hits = 0;
  for (const { start, body } of mapBodies(src)) {
    for (const m of body.matchAll(/\b(aria-label|title)\s*=\s*"([^"{}]{2,})"/g)) {
      const abs = start + (m.index ?? 0);
      if (seen.has(abs)) continue;
      seen.add(abs);
      if (m[1] === "title") {
        const el = elementAround(body, m.index ?? 0);
        // A tooltip beside a real name is correct.
        if (/aria-label\s*=/.test(el)) continue;
        // A `title` only becomes an accessible NAME on something focusable. On a
        // <Badge> or a <span> it is an explanatory tooltip and counting it was
        // noise — two of the three findings that kept listings-table.tsx off the
        // "already fixed" list were exactly that, and the third was a real
        // per-row <Link> that announced "Queue" on every row.
        if (!/^<\s*(button|a|Link|input|select|textarea)\b/i.test(el) && !/onClick\s*=/.test(el)) {
          continue;
        }
      }
      hits++;
    }
  }
  return hits;
}

describe("a repeated control names its own row (US-2450)", () => {
  const files = walk(resolve(process.cwd(), "src")).filter((f) => !isTest(f));

  it("scans a real corpus", () => {
    // Guards the guard: a broken walk makes every assertion below vacuous.
    expect(files.length).toBeGreaterThan(200);
  });

  it("the rule actually fires on the shape it is about", () => {
    // Guards the guard again, and this one is the important half: the FIRST
    // version of this scan missed dynamic imports and called 189 live pages
    // dead, and a later version counted tooltips beside real labels. A rule this
    // fiddly gets a fixture.
    expect(auditFile(`rows.map((r) => <button aria-label="Edit" />)`)).toBe(1);
    expect(auditFile(`rows.map((r) => <button title="Edit" />)`)).toBe(1);
    // A tooltip beside a real name is correct and must not be counted.
    expect(
      auditFile('rows.map((r) => <button title="Edit" aria-label={`Edit ${r.n}`} />)'),
    ).toBe(0);
    // An interpolated name is the fix, not a finding.
    expect(auditFile("rows.map((r) => <button aria-label={`Edit ${r.n}`} />)")).toBe(0);
    // Outside a map, a fixed label is a landmark or a one-off and is fine.
    expect(auditFile(`<nav aria-label="Jump to group" />`)).toBe(0);
  });

  it("does not exceed the recorded baseline", () => {
    let total = 0;
    const perFile: Array<[string, number]> = [];
    for (const f of files) {
      const n = auditFile(readFileSync(f, "utf8"));
      if (n) {
        total += n;
        perFile.push([f, n]);
      }
    }
    if (total > BASELINE) {
      perFile.sort((a, b) => b[1] - a[1]);
      const worst = perFile
        .slice(0, 5)
        .map(([f, n]) => `${f.split(`${sep}src${sep}`)[1] ?? f} (${n})`)
        .join(", ");
      throw new Error(
        `${total} fixed labels inside repeated elements, baseline ${BASELINE}. ` +
          `Each of these is announced identically for every row on screen, so a ` +
          `screen reader user cannot tell which item they are acting on. ` +
          `Interpolate the row's identity. Worst files: ${worst}`,
      );
    }
    expect(total).toBeLessThanOrEqual(BASELINE);
  });

  it("the shape a scan can be SURE about is zero, not inside the budget", () => {
    // The baseline above is a budget, and its header explains honestly why:
    // this scan over-reports on text inputs, whose value is announced along
    // with the label. A budget of 20 permits twenty NEW ones to hide under the
    // existing count.
    //
    // One subset has no ambiguity at all — a CONSTANT string aria-label on a
    // control rendered inside a `.map()` callback. Every row announces the
    // same words, every time, and there is no reading of it that is fine. So
    // it is held at zero here instead of sharing the budget.
    //
    // Fifteen of these existed on 2026-08-23, across admin, buyer and FlipDesk:
    // "Delete want", "Delete rule", "Remove filter", "Edit fact". Most were
    // destructive, which is the case that matters — a missing name reads as
    // unknown, a repeated one reads as understood.
    const hits: string[] = [];
    for (const f of files) {
      for (const h of auditDistinctness(readFileSync(f, "utf8"))) {
        hits.push(`${f.split(`${sep}src${sep}`)[1] ?? f}:${h.line} "${h.name}"`);
      }
    }
    expect(
      hits,
      "a per-row control with a constant label announces the same words on " +
        "every row. Interpolate whatever the row already shows on screen.",
    ).toEqual([]);
  });

  it("that subset check is not vacuous", () => {
    // Both directions, because a scan that matches nothing forever reads
    // exactly like a clean codebase — the defect this repo keeps finding.
    expect(files.length).toBeGreaterThan(200);
    const bad = `<ul>{rows.map((r) => (<li key={r.id}>` +
      `<Button aria-label="Delete row" /></li>))}</ul>`;
    expect(auditDistinctness(bad).length).toBe(1);
    // An interpolated label is correct by construction and must stay unreported;
    // a rule that flags every label in a list is the version that gets deleted.
    const good = "<ul>{rows.map((r) => (<li key={r.id}>" +
      "<Button aria-label={`Delete ${r.name}`} /></li>))}</ul>";
    expect(auditDistinctness(good)).toEqual([]);
    // And a constant label on a control rendered ONCE is fine: the defect is
    // repetition, not constancy.
    expect(auditDistinctness('<div><Button aria-label="Close" /></div>')).toEqual([]);
  });

  it("a per-row button named only by its visible text is counted", () => {
    // THE SHAPE THE HEADER SAYS IS UNGUARDED. It is guarded now, and the
    // difference is the tool rather than the effort: this PARSES with the
    // TypeScript compiler instead of matching. Three regex attempts across
    // two sessions failed on the same thing — `onClick={() => f(x)}` holds a
    // `>` that is not the tag's — and the last one failed silently, matching
    // nothing and reporting a confident zero.
    //
    // A BUDGET, not a floor, and deliberately: 96 is too many to fix in one
    // pass, several are genuinely fine (a map over a fixed set of actions is
    // not a list of garments), and a number that fails today teaches people
    // to delete the check. It ratchets — the companion case below refuses to
    // let it sit slack.
    let total = 0;
    const worst: Array<[string, number]> = [];
    for (const f of files) {
      const hits = auditRepeatedText(readFileSync(f, "utf8"), f);
      if (hits.length) {
        total += hits.length;
        worst.push([f.split(`${sep}src${sep}`)[1] ?? f, hits.length]);
      }
    }
    if (total > TEXT_BASELINE) {
      worst.sort((a, b) => b[1] - a[1]);
      throw new Error(
        `${total} per-row buttons are named only by static visible text, ` +
          `baseline ${TEXT_BASELINE}. Every row announces the same word — ` +
          `"Refund", "Reject", "End" — with nothing to say which one. Give ` +
          `the button an aria-label carrying the row's identity. Worst: ` +
          worst.slice(0, 5).map(([f, n]) => `${f} (${n})`).join(", "),
      );
    }
    expect(total).toBeLessThanOrEqual(TEXT_BASELINE);
  });

  it("the visible-text baseline is not slack either", () => {
    let total = 0;
    for (const f of files) {
      total += auditRepeatedText(readFileSync(f, "utf8"), f).length;
    }
    expect(
      TEXT_BASELINE - total,
      `the count is ${total} and the baseline is ${TEXT_BASELINE} — lower it`,
    ).toBeLessThan(10);
  });

  it("the visible-text scan is not vacuous, in four directions", () => {
    // A parse that matches nothing reports the same zero as a clean codebase.
    // The previous attempt at this shape did exactly that, so every direction
    // is pinned rather than assumed.
    const hit = auditRepeatedText(
      "const A = () => <ul>{rows.map((r) => (<li key={r.id}>" +
        "<Button onClick={() => go(r)}>Generate</Button></li>))}</ul>;",
    );
    expect(hit.length, "a static-text button inside a map must be found").toBe(1);
    expect(hit[0]?.text).toBe("Generate");

    // An aria-label names the row: correct, not reported.
    expect(auditRepeatedText(
      "const A = () => <ul>{rows.map((r) => (<li key={r.id}>" +
        "<Button aria-label={`Go ${r.name}`}>Generate</Button></li>))}</ul>;",
    )).toEqual([]);

    // An interpolated child IS the row's identity: correct, not reported.
    expect(auditRepeatedText(
      "const A = () => <ul>{rows.map((r) => (<li key={r.id}>" +
        "<Button>{r.name}</Button></li>))}</ul>;",
    )).toEqual([]);

    // Outside a map, one button saying Close is perfectly clear.
    expect(auditRepeatedText(
      "const A = () => <div><Button onClick={() => x()}>Close</Button></div>;",
    )).toEqual([]);
  });

  it("the baseline is not slack", () => {
    // A ratchet nobody tightens stops working. If the count has dropped, lower
    // the baseline in the same commit.
    let total = 0;
    for (const f of files) total += auditFile(readFileSync(f, "utf8"));
    expect(
      BASELINE - total,
      `the count is ${total} and the baseline is ${BASELINE} — lower it`,
    ).toBeLessThan(10);
  });

  it("the two surfaces already fixed stay fixed", () => {
    // These are the ones a regression would hurt most: hundreds of virtualized
    // rows each. Pinned individually so they cannot drift back under cover of a
    // baseline that happens to have room in it.
    for (const rel of [
      "src/pages/flipdesk/listings-table.tsx",
      "src/pages/flipdesk/autolister.tsx",
      "src/pages/flipdesk/autolister-bulk-edit.tsx",
    ]) {
      const src = readFileSync(resolve(process.cwd(), rel), "utf8");
      expect(auditFile(src), `${rel} regressed`).toBe(0);
    }
  });
});
