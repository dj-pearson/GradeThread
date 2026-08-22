// US-2772: a commit subject may not announce a close that prd.json contradicts.
//
// THE FAILURE THIS COMES FROM, because the guard is only sensible next to it.
// Commit 68b3f103a is titled "docs(prd): close US-2729, US-2686 and US-2772".
// Two of the three were archived by it. US-2772 stayed at passes:false with
// zero notes while its code — a step-up on the two Google Ads routes that move
// live spend — was already running in production. markDone() throws on an
// unknown id and writes all-or-nothing, so nothing half-failed: the id was
// never passed to it, and the subject line asserted an outcome nobody checked.
//
// It was picked up again on 2026-08-22 precisely BECAUSE it looked untouched,
// and the only thing that stopped a second implementation of shipped work was
// step-up-coverage_test.ts's header describing the work as done. A backlog that
// errs toward MORE work left is the expensive direction.
//
// The parser is the whole guard, so the parser is what is tested. Both
// directions matter: a claim it misses is the original bug back again, and a
// false positive is a hook people disable, which is the same thing slower.
import { describe, expect, it } from "vitest";
import { closeClaims, closeState } from "../../scripts/check-close-claims.mjs";

describe("US-2772: which subjects claim a close", () => {
  it("reads the ids out of an ordinary close subject", () => {
    expect(closeClaims("docs(prd): close US-2729, US-2686 and US-2772")).toEqual([
      "US-2729",
      "US-2686",
      "US-2772",
    ]);
  });

  it("stops at a clause that is no longer about closing", () => {
    // The real subject. "note US-2777" is not a claim about US-2777's state,
    // and treating it as one would fire the guard on a correct commit — which
    // is how a hook gets turned off.
    expect(
      closeClaims("docs(prd): close US-2729, US-2686 and US-2772; note US-2777 and US-2687"),
    ).toEqual(["US-2729", "US-2686", "US-2772"]);
  });

  it("does NOT match disclose", () => {
    // Found by running the audit: "feat(legal): disclose the browser extension
    // in the privacy policy" and "feat(billing): confirm + disclose before an
    // in-place plan upgrade" were both reported as close claims before the word
    // boundary went in. Two false positives out of three reported hits.
    expect(closeClaims("feat(legal): disclose the browser extension (US-1757)")).toEqual([]);
    expect(closeClaims("feat(billing): confirm + disclose before an upgrade (US-2118)")).toEqual([]);
  });

  it("ignores a subject that merely names a story", () => {
    expect(closeClaims("fix(admin): step up before an ads change (US-2772)")).toEqual([]);
    expect(closeClaims("docs(prd): note US-2687")).toEqual([]);
  });

  it("reads closes/closed/closing, not just close", () => {
    for (const verb of ["close", "closed", "closes", "closing"]) {
      expect(closeClaims(`docs(prd): ${verb} US-1`), verb).toEqual(["US-1"]);
    }
  });

  it("does not double-count an id named twice", () => {
    expect(closeClaims("docs(prd): close US-1 and US-1")).toEqual(["US-1"]);
  });
});

describe("US-2772: what counts as actually closed", () => {
  const archive = new Set(["US-100"]);
  const prd = new Map<string, { id: string; passes: boolean }>([
    ["US-200", { id: "US-200", passes: true }],
    ["US-300", { id: "US-300", passes: false }],
  ]);

  it("archived is closed", () => {
    expect(closeState("US-100", prd, archive)).toBe("archived");
  });

  it("passes:true still in prd.json is closed too", () => {
    // The archive move is a SEPARATE step and `--no-archive` skips it on
    // purpose for a bulk close. Failing here would fire the guard on a correct
    // workflow, which is the false positive that gets a hook disabled.
    expect(closeState("US-200", prd, archive)).toBe("passes");
  });

  it("passes:false is the bug this exists for", () => {
    expect(closeState("US-300", prd, archive)).toBe("open");
  });

  it("an id in neither file is not a pass", () => {
    // A typo in the subject is the same lie wearing different clothes: the
    // message claims a state for something that does not exist to have it.
    expect(closeState("US-999", prd, archive)).toBe("unknown");
  });
});

describe("US-2772: the historical commit", () => {
  it("the subject that caused this would be caught", () => {
    const subject =
      "docs(prd): close US-2729, US-2686 and US-2772; note US-2777 and US-2687";
    const claims = closeClaims(subject);
    expect(claims).toContain("US-2772");
    // State as it stood in that commit: the other two archived, this one not.
    const archiveThen = new Set(["US-2729", "US-2686"]);
    const prdThen = new Map([["US-2772", { id: "US-2772", passes: false }]]);
    const bad = claims.filter((id) =>
      ["open", "unknown"].includes(closeState(id, prdThen, archiveThen)),
    );
    expect(bad).toEqual(["US-2772"]);
  });
});
