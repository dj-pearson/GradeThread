import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { auditDistinctness } from "../../scripts/audit-control-labels.mjs";

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
// WHAT THIS CANNOT SEE, stated so nobody reads more into a green run:
//   • visible button text. Detecting "every row's button says Generate" needs to
//     know the element repeats AND that the text is static, and the version that
//     tried it flagged every button on every page. The three found by hand are
//     fixed; there is no guard on that shape.
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
