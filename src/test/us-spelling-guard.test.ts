import { describe, expect, it } from "vitest";

// US-3233. The guard itself lives in scripts/check-us-spelling.mjs; this is what
// runs it, because vitest's include glob is src/** and scripts/*.test.mjs is not
// in any lane that gates a push.
//
// Two things are being held here and they are different:
//   1. the tree is clean (no British spelling in copy a user reads), and
//   2. the RULE still works. A spelling scan that has quietly stopped matching
//      reads exactly like a clean tree, which is the failure this repo keeps
//      hitting, so `selfCheckProblems()` runs the detector against a fixture it
//      must trip before a quiet result is worth anything.
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore -- plain ESM script, no types
import { ALLOW, BRITISH, britishWordsIn, run, selfCheckProblems } from "../../scripts/check-us-spelling.mjs";

describe("US spelling in user-facing copy (US-3233)", () => {
  it("finds no British spelling in any copy position", () => {
    const { scanned, findings } = run();
    expect(scanned, "the scanner extracted nothing, so a clean result means nothing")
      .toBeGreaterThan(10_000);
    expect(
      findings.map(
        (f: { file: string; line: number; hits: string[][] }) =>
          `${f.file}:${f.line} ${f.hits.map(([w, fix]) => `${w}->${fix}`).join(",")}`,
      ),
      "British spelling in copy a user reads. Fix the string; do not add an " +
        "allow entry unless the British spelling is doing a job (an eBay value, " +
        "a stored status, a brand's own name) and say what the job is.",
    ).toEqual([]);
  });

  it("keeps every allow entry load-bearing", () => {
    const { stale } = run();
    expect(
      stale,
      "an allow entry whose file no longer carries the word it excuses. The " +
        "list is shrink-only: delete the entry rather than re-writing the reason.",
    ).toEqual([]);
  });

  it("still fires on the fixture it is supposed to fire on", () => {
    // Mode 0/1 from the guards-that-do-not-guard notes: a rule that has stopped
    // matching produces the same green as correct code.
    expect(selfCheckProblems()).toEqual([]);
  });

  // AC3, by path and by name. These two are not a preference.
  it.each([
    ["src/lib/aspect-normalize.ts", "eBay"],
    ["services/edge-functions/src/lib/aspect-normalize.ts", "eBay"],
    ["src/lib/ebay-prefill.ts", "normalizer"],
  ])("%s is exempt by path, with the reason inline", (path, reasonWord) => {
    const entry = ALLOW.find((a: { path: string }) => a.path === path);
    expect(
      entry,
      `${path} must stay exempt: rewriting an eBay allowed value is a listing ` +
        `failure, not a typo fix.`,
    ).toBeTruthy();
    expect(entry.words.length).toBeGreaterThan(0);
    expect(entry.why).toContain(reasonWord);
  });

  it("never reports a word that is correct US English", () => {
    // "cancellation" cost an earlier draft of this list 86 false reports: the
    // US spelling has two Ls too. Same for the -ation/-ance forms around it.
    for (const ok of [
      "cancellation",
      "Refund and Cancellation Policy",
      "the analysis says",
      "good practice",
      "a dialogue with the buyer",
    ]) {
      expect(britishWordsIn(ok), `${ok} is correct US English`).toEqual([]);
    }
    expect(Object.keys(BRITISH)).not.toContain("cancellation");
  });

  it("reports a word that is not", () => {
    expect(britishWordsIn("a cancelled order in a grey colour")).toEqual([
      ["cancelled", "canceled"],
      ["grey", "gray"],
      ["colour", "color"],
    ]);
  });

  it("treats a quoted or assigned value as a citation, not a misspelling", () => {
    // API docs have to name the status value the API accepts.
    expect(britishWordsIn("sales with status `cancelled` are not revenue")).toEqual([]);
    expect(britishWordsIn("Defaults to status=cancelled")).toEqual([]);
    // But the same word in ordinary prose is still a finding.
    expect(britishWordsIn("the order was cancelled by the buyer")).toHaveLength(1);
  });
});
