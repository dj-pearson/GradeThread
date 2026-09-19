import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  REGISTRIES,
  KNOWN_ABSENT,
  KNOWN_ABSENT_UNNUMBERED,
  namedBranches,
  missingBranches,
  unnumberedBranches,
} from "../../scripts/check-held-branches.mjs";

// US-3421. The guard asks the REMOTE whether a branch a registry names actually
// exists. That question needs network, and CI has it while an offline run does
// not, so the script skips loudly rather than printing a green line it did not
// earn. This file is what stays gated either way: the parsing and the
// comparison are pure, and they are where the guard can go wrong quietly.
//
// What it is guarding against, measured 2026-09-18: PENDING_MIGRATIONS.md and
// KNOWN_GAPS both name `held-*` branches as the home of six finished, unapplied
// migrations, and `git ls-remote --heads origin` returns 212 heads with no
// match. It stayed invisible because the two registries agree with EACH OTHER;
// only the remote knows.

const ROOT = join(__dirname, "../..");

describe("held-branch registries (US-3421)", () => {
  const named = namedBranches(ROOT);

  it("finds a real set of names, so the scan cannot pass vacuously", () => {
    // A parse that matches nothing reports the same clean result as a repo with
    // nothing parked. Tied to the baseline rather than to a literal, because
    // this number falls every time a held migration lands: it was 5 when this
    // was written and 4 the same afternoon, when US-3387 rebuilt 00793 into the
    // tree. A hardcoded floor would have to be edited on every such landing,
    // which is how a floor quietly stops being a floor.
    expect(named.size).toBeGreaterThanOrEqual(KNOWN_ABSENT.size);
    expect(KNOWN_ABSENT.size, "the baseline is empty — delete this guard").toBeGreaterThan(0);
  });

  it("every registry still contributes at least one name", () => {
    // A registry that stops matching is the quiet failure: it reads exactly
    // like a registry with nothing left to check.
    for (const { file } of REGISTRIES) {
      const from = [...named.values()].filter((files) => files.includes(file));
      expect(from.length, `${file} contributes no branch name any more`).toBeGreaterThan(0);
    }
  });

  it("reads the merge-order table and NOT the prose around it", () => {
    // The scoping is what keeps this worth running. PENDING_MIGRATIONS.md
    // narrates branches that were superseded, renamed or deleted on purpose —
    // those SHOULD be absent, and reporting them turned a 5-line finding into a
    // 14-line one where most entries were correct.
    const doc = readFileSync(join(ROOT, "PENDING_MIGRATIONS.md"), "utf8");
    expect(doc, "the fixture for this case is gone").toContain("held/us-3324-00792");
    expect(
      [...named.keys()],
      "a branch named only in prose must not be asked about",
    ).not.toContain("held/us-3324-00792");
  });

  it("ignores a struck-through name, which is a record of what a row used to say", () => {
    const doc = readFileSync(join(ROOT, "PENDING_MIGRATIONS.md"), "utf8");
    expect(doc).toMatch(/~~`?held-v3\/us-3256-00797`?~~/);
    expect([...named.keys()]).not.toContain("held-v3/us-3256-00797");
  });

  it("reports a named branch the remote does not have", () => {
    // The comparison itself, against a fixed remote set rather than the network.
    // The fixture is taken from the live list rather than named, because the
    // branch this pinned by hand stopped being named when its migration landed.
    const present = [...named.keys()][0]!;
    const onRemote = new Set(["main", present]);
    const missing = missingBranches(named, onRemote);
    expect(missing.map((m) => m.branch)).not.toContain(present);
    expect(missing.length, "everything else should be reported").toBe(named.size - 1);
    expect(missing[0]?.files.length, "a finding says where it was named").toBeGreaterThan(0);
  });

  it("says nothing when the remote has every name", () => {
    expect(missingBranches(named, new Set(named.keys()))).toEqual([]);
  });

  it("the baseline describes exactly what is missing today, both directions", () => {
    // Shrink-only. An entry for a branch that is no longer named is an
    // allowance nothing needs, and a named-and-absent branch with no entry is
    // the regression this exists for. The script asserts the same pair against
    // the live remote; this asserts the half that needs no network — that every
    // baselined name is still one the registries actually name.
    for (const [branch, why] of KNOWN_ABSENT) {
      expect(
        [...named.keys()],
        `KNOWN_ABSENT names ${branch} (${why}) and no registry does any more — delete the entry`,
      ).toContain(branch);
    }
  });

  it("is wired into verify and into a workflow", () => {
    // src/test/guard-lane-parity.test.ts makes this assertion for every
    // check-*.mjs. Repeating it here is deliberate: that file keys on the
    // filename appearing SOMEWHERE, and this names the two places so a failure
    // says which one is missing.
    const verify = readFileSync(join(ROOT, "scripts/verify.mjs"), "utf8");
    expect(verify).toContain("scripts/check-held-branches.mjs");
    const ci = readFileSync(join(ROOT, ".github/workflows/ci.yml"), "utf8");
    expect(ci).toContain("scripts/check-held-branches.mjs");
  });
});

// ── The branch no registry could hold ───────────────────────────────────────
//
// Found 2026-09-18 while investigating US-3399. Both registries are keyed on a
// migration: the merge-order table has a version column, KNOWN_GAPS explains a
// hole in the numbering. A branch with finished work and no SQL fits neither, so
// it can only be named in prose, and prose is deliberately out of scope. The
// guard was green while `held/us-3399-chart-order` was as lost as the four it
// tracks -- its SHA, d3ec2de55, is not an object in this clone.

describe("held branches that carry no migration", () => {
  const unnumbered = unnumberedBranches(ROOT);

  it("finds the one branch with no migration number", () => {
    expect([...unnumbered.keys()]).toContain("held/us-3399-chart-order");
  });

  it("stays silent on every branch that DOES carry a number", () => {
    // The noise argument, as a case rather than a claim. PENDING_MIGRATIONS.md
    // names nine numbered branches in prose alone -- the same stories at
    // successive conventions and numbers -- and those have a registry, so this
    // check must not repeat them.
    for (const name of unnumbered.keys()) {
      expect(name, `${name} carries a migration number and has a registry`).not.toMatch(
        /\d{5}/,
      );
    }
  });

  it("the numbered narration really is in the file, so the case above is not vacuous", () => {
    // If PENDING_MIGRATIONS.md stopped narrating superseded branches, the
    // silence above would be silence about nothing.
    const doc = readFileSync(join(ROOT, "PENDING_MIGRATIONS.md"), "utf8");
    const numbered = [...doc.matchAll(/\bheld(?:-v\d+)?\/[A-Za-z0-9._-]*\d{5}[A-Za-z0-9._-]*/g)];
    expect(
      new Set(numbered.map((m) => m[0])).size,
      "expected the file to still name several numbered held branches",
    ).toBeGreaterThan(4);
  });

  it("reads prose, which is the opposite of the numbered scan and the point", () => {
    // `namedBranches` is scoped to table rows. This one is not, deliberately:
    // a migration-less branch has no table row to be in.
    const named = namedBranches(ROOT);
    expect([...named.keys()]).not.toContain("held/us-3399-chart-order");
    expect([...unnumbered.keys()]).toContain("held/us-3399-chart-order");
  });

  it("the baseline says what each entry holds, not just that it is gone", () => {
    // An entry naming only a branch tells the next reader nothing about what
    // rebuilding it costs. US-3399's says which test file went with it.
    expect(KNOWN_ABSENT_UNNUMBERED.size).toBeGreaterThan(0);
    for (const [branch, what] of KNOWN_ABSENT_UNNUMBERED) {
      expect(what.length, `${branch} has no description`).toBeGreaterThan(40);
    }
  });

  it("the baseline matches what is missing today, both directions", () => {
    // Shrink-only, same as KNOWN_ABSENT: an entry that stops being missing
    // fails as loudly as a new gap.
    const onRemote = new Set<string>();
    const missing = new Set(
      missingBranches(unnumbered, onRemote).map((m) => m.branch),
    );
    for (const branch of KNOWN_ABSENT_UNNUMBERED.keys()) {
      expect(missing, `${branch} is baselined but not named any more`).toContain(branch);
    }
  });

  it("the two baselines never name the same branch", () => {
    // They are found by different rules and reported separately. An overlap
    // would double-report one branch and make the counts disagree.
    for (const branch of KNOWN_ABSENT_UNNUMBERED.keys()) {
      expect(KNOWN_ABSENT.has(branch), `${branch} is in both baselines`).toBe(false);
    }
  });
});
