// US-2043: vitest coverage for the vault linter (Node env — see
// vitest.scripts.config.mjs). Every rule gets a passing AND a failing fixture;
// a rule tested only in its passing direction proves nothing.
import { describe, expect, it } from "vitest";
import {
  checkDrift,
  formatHunks,
  gitChangesSince,
  HUNK_COMMIT_CAP,
  nextDay,
  parseHunkLog,
  buildReviewQueue,
  checkMigrationNotes,
  isKnowledgeBearing,
  leadingCommentLines,
  isShallowRepo,
  canonicalizeFrontmatter,
  extractWikilinks,
  fixNote,
  INDEX_LINE_CAP,
  lintVault,
  parseFrontmatter,
  reachableFrom,
  stripCode,
  validateFrontmatter,
} from "./vault-lint.mjs";

const TODAY = "2026-07-18";
const yes = () => true;
const no = () => false;

const fm = (over = {}) => ({
  title: "T",
  type: "reference",
  status: "current",
  source_of_truth: "vault",
  code_refs: [],
  reviewed: TODAY,
  ...over,
});

// notes Map helper: { name: [linkTargets, frontmatterOverrides] }
const vault = (spec) => {
  const m = new Map();
  for (const [name, [links = [], over = {}]] of Object.entries(spec)) {
    m.set(name, {
      path: `vault/${name}.md`,
      fm: fm(over),
      body: links.map((l) => `[[${l}]]`).join(" "),
      links,
      raw: "",
    });
  }
  return m;
};

describe("parseFrontmatter", () => {
  it("parses scalars, block lists, inline lists and empty lists", () => {
    const { fm: f, body } = parseFrontmatter(
      `---\ntitle: Hello\ntags: [a, b]\ncode_refs:\n  - src/a.ts\n  - src/b.ts\nsummary:\n---\nBody here`,
    );
    expect(f.title).toBe("Hello");
    expect(f.tags).toEqual(["a", "b"]);
    expect(f.code_refs).toEqual(["src/a.ts", "src/b.ts"]);
    expect(f.summary).toEqual([]);
    expect(body.trim()).toBe("Body here");
  });
  it("strips surrounding quotes from values", () => {
    expect(parseFrontmatter(`---\ntitle: "A: B"\n---\nx`).fm.title).toBe("A: B");
  });
  it("returns null frontmatter when absent", () => {
    expect(parseFrontmatter("# no frontmatter").fm).toBeNull();
  });
});

describe("stripCode / extractWikilinks", () => {
  it("finds plain, aliased and heading links", () => {
    expect(extractWikilinks("[[a]] [[b|Bee]] [[c#Sec]] [[d#Sec|Dee]]")).toEqual(["a", "b", "c", "d"]);
  });
  it("IGNORES links inside fenced and inline code", () => {
    // The regression this exists for: vault/CONTRACT.md documents the wikilink
    // syntax, so it contains examples that must not be treated as links.
    const body = "real [[keep]]\n```\n[[fenced]]\n```\nand `[[inline]]` too";
    expect(extractWikilinks(body)).toEqual(["keep"]);
    expect(stripCode("`[[x]]`")).not.toContain("[[x]]");
  });
  it("ignores an empty link target", () => {
    expect(extractWikilinks("[[]] [[ok]]")).toEqual(["ok"]);
  });
});

describe("validateFrontmatter", () => {
  const opts = { path: "n.md", today: TODAY, exists: yes };

  it("accepts a valid note", () => {
    expect(validateFrontmatter(fm(), opts)).toEqual([]);
  });
  it("rejects missing frontmatter", () => {
    expect(validateFrontmatter(null, opts)[0]).toMatch(/no frontmatter/);
  });
  it("rejects each missing required field", () => {
    const errs = validateFrontmatter({ title: "T" }, opts);
    for (const f of ["type", "status", "source_of_truth", "code_refs", "reviewed"]) {
      expect(errs.some((e) => e.includes(`'${f}'`))).toBe(true);
    }
  });
  it("rejects a bad type / status / source_of_truth", () => {
    expect(validateFrontmatter(fm({ type: "nope" }), opts)[0]).toMatch(/type 'nope'/);
    expect(validateFrontmatter(fm({ status: "nope" }), opts)[0]).toMatch(/status 'nope'/);
    expect(validateFrontmatter(fm({ source_of_truth: "nope" }), opts)[0]).toMatch(/source_of_truth/);
  });
  it("accepts 'accepted' as a status (ADRs use it)", () => {
    expect(validateFrontmatter(fm({ type: "decision", status: "accepted" }), opts)).toEqual([]);
  });
  it("rejects a malformed or future reviewed date", () => {
    expect(validateFrontmatter(fm({ reviewed: "18-07-2026" }), opts)[0]).toMatch(/ISO date/);
    expect(validateFrontmatter(fm({ reviewed: "2099-01-01" }), opts)[0]).toMatch(/in the future/);
  });
  it("requires code_refs when source_of_truth is 'code'", () => {
    const errs = validateFrontmatter(fm({ source_of_truth: "code", code_refs: [] }), opts);
    expect(errs[0]).toMatch(/requires at least one code_ref/);
    expect(validateFrontmatter(fm({ source_of_truth: "code", code_refs: ["a.ts"] }), opts)).toEqual([]);
  });
  it("does NOT require code_refs when source_of_truth is 'vault'", () => {
    expect(validateFrontmatter(fm({ source_of_truth: "vault", code_refs: [] }), opts)).toEqual([]);
  });
  it("rejects a code_ref that does not exist on disk", () => {
    const errs = validateFrontmatter(fm({ code_refs: ["gone.ts"] }), { ...opts, exists: no });
    expect(errs[0]).toMatch(/does not exist -> gone\.ts/);
  });
});

describe("reachableFrom", () => {
  it("walks transitively", () => {
    const r = reachableFrom(vault({ INDEX: [["a"]], a: [["b"]], b: [[]] }));
    expect([...r].sort()).toEqual(["INDEX", "a", "b"]);
  });
  it("does not reach an unlinked note", () => {
    expect(reachableFrom(vault({ INDEX: [["a"]], a: [[]], lonely: [[]] })).has("lonely")).toBe(false);
  });
  it("terminates on a link cycle", () => {
    expect(reachableFrom(vault({ INDEX: [["a"]], a: [["b"]], b: [["a"]] })).size).toBe(3);
  });
  it("returns empty when INDEX is absent", () => {
    expect(reachableFrom(vault({ a: [[]] })).size).toBe(0);
  });
});

describe("lintVault", () => {
  const opts = { today: TODAY, exists: yes };

  it("passes a well-formed vault", () => {
    const r = lintVault(vault({ INDEX: [["a"]], a: [["INDEX"]] }), opts);
    expect(r.ok).toBe(true);
    expect(r.errors).toEqual([]);
  });
  it("fails on a dangling wikilink", () => {
    const r = lintVault(vault({ INDEX: [["ghost"]] }), opts);
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes("dangling wikilink [[ghost]]"))).toBe(true);
  });
  it("fails on an orphan", () => {
    const r = lintVault(vault({ INDEX: [[]], lonely: [[]] }), opts);
    expect(r.errors.some((e) => e.includes("ORPHAN") && e.includes("lonely"))).toBe(true);
  });
  it("fails when INDEX itself is missing", () => {
    const r = lintVault(vault({ a: [[]] }), opts);
    expect(r.errors.some((e) => e.includes("INDEX.md is missing"))).toBe(true);
  });
  it("fails when the index exceeds its line cap", () => {
    const r = lintVault(vault({ INDEX: [[]] }), { ...opts, indexLines: INDEX_LINE_CAP + 1 });
    expect(r.errors.some((e) => e.includes("over the") && e.includes("line cap"))).toBe(true);
  });
  it("passes at exactly the line cap", () => {
    const r = lintVault(vault({ INDEX: [[]] }), { ...opts, indexLines: INDEX_LINE_CAP });
    expect(r.ok).toBe(true);
  });
  it("surfaces a schema error from a nested note", () => {
    const r = lintVault(vault({ INDEX: [["a"]], a: [[], { type: "bogus" }] }), opts);
    expect(r.errors.some((e) => e.includes("type 'bogus'"))).toBe(true);
  });
  it("warns, but does not fail, on a missing summary", () => {
    const r = lintVault(vault({ INDEX: [[]] }), opts);
    expect(r.ok).toBe(true);
    expect(r.warnings.some((w) => w.includes("no summary"))).toBe(true);
  });
  it("warns on an archived note still claiming source_of_truth code", () => {
    const v = vault({ INDEX: [["a"]], a: [[], { status: "archived", source_of_truth: "code", code_refs: ["x.ts"] }] });
    const r = lintVault(v, opts);
    expect(r.ok).toBe(true);
    expect(r.warnings.some((w) => w.includes("archived note"))).toBe(true);
  });
});

// ── US-2431: the hunks shown under a DRIFT finding ───────────────────────────
//
// A DRIFT warning names a file and a date. Verifying it therefore means
// re-reading the file, and on the 3000-line shared files that produce most of
// these warnings that IS the cost of the guard. These add the commit subjects
// and the touched line ranges so the re-read starts from what moved.
//
// Subjects alone are not enough — US-2430 had eight notes whose commit subject
// looked relevant and whose hunks were in an unrelated part of the file. That
// is why every case here asserts the RANGES, not just the subject.
describe("parseHunkLog", () => {
  const log = [
    "\u0000abc1234 US-1: touch the top",
    "@@ -1,3 +1,4 @@",
    "@@ -80 +81,10 @@",
    "\u0000def5678 US-2: a rename with no line change",
    "",
  ].join("\n");

  it("reads the subject and the NEW-side line ranges", () => {
    const c = parseHunkLog(log);
    expect(c).toHaveLength(2);
    expect(c[0].sha).toBe("abc1234");
    expect(c[0].subject).toBe("US-1: touch the top");
    // 1,4 -> L1-4;  81,10 -> L81-90. The NEW side is what matters: it is where
    // the lines are in the file the reader is about to open.
    expect(c[0].ranges).toEqual(["1-4", "81-90"]);
  });

  it("reports a commit that changed no lines rather than dropping it", () => {
    // A rename or a mode change is still a reason the drift fired. Dropping it
    // would show a warning with an empty explanation, which reads as a bug.
    expect(parseHunkLog(log)[1].ranges).toEqual([]);
  });

  it("renders a single-line hunk as one number, not a range", () => {
    expect(parseHunkLog("\u000012ab US-3: one line\n@@ -5 +5 @@\n")[0].ranges).toEqual(["5"]);
  });

  it("marks a pure deletion with a seam rather than an empty range", () => {
    // +12,0 means nothing exists there now. "L12" would send the reader to a
    // line that is not the one that changed.
    expect(parseHunkLog("\u000012ab US-4: delete\n@@ -12,4 +12,0 @@\n")[0].ranges).toEqual(["12~"]);
  });

  it("is not confused by a commit subject that looks like a hunk header", () => {
    // The log is NUL-delimited for exactly this reason. A printable delimiter
    // would let a commit message named after a diff corrupt the parse.
    const tricky = "\u0000aaa1 fix: @@ -1 +1 @@ in the title\n@@ -9 +9,2 @@\n";
    const c = parseHunkLog(tricky);
    expect(c).toHaveLength(1);
    expect(c[0].subject).toBe("fix: @@ -1 +1 @@ in the title");
    expect(c[0].ranges).toEqual(["9-10"]);
  });

  it("returns nothing for empty output", () => {
    expect(parseHunkLog("")).toEqual([]);
  });
});

describe("formatHunks", () => {
  const many = (n) =>
    Array.from({ length: n }, (_, i) => ({ sha: `sha${i}`, subject: `s${i}`, ranges: ["1"] }));

  it("is empty when there is nothing to show", () => {
    expect(formatHunks([])).toBe("");
  });

  it("caps the listing and SAYS how many it elided", () => {
    // AC2: a wall of hunks is the same failure as a filename with no hunks.
    // Silently truncating would be worse than either — it reads as complete.
    const out = formatHunks(many(HUNK_COMMIT_CAP + 3));
    expect(out.split("\n").filter((l) => l.includes("sha"))).toHaveLength(HUNK_COMMIT_CAP);
    expect(out).toContain(`and 3 earlier commit(s) not shown`);
  });

  it("does not add an elision line when everything fits", () => {
    expect(formatHunks(many(HUNK_COMMIT_CAP))).not.toContain("not shown");
  });

  it("explains a commit with no line ranges instead of printing a blank", () => {
    expect(formatHunks([{ sha: "a1", subject: "rename", ranges: [] }]))
      .toContain("no line changes");
  });
});

describe("nextDay", () => {
  it("advances one day so a commit ON the review date is excluded", () => {
    // That commit is what the reviewer READ, not drift from it.
    expect(nextDay("2026-07-01")).toBe("2026-07-02");
  });
  it("crosses a month and a year boundary", () => {
    expect(nextDay("2026-01-31")).toBe("2026-02-01");
    expect(nextDay("2026-12-31")).toBe("2027-01-01");
  });
  it("returns the input unchanged when it is not a date", () => {
    expect(nextDay("not-a-date")).toBe("not-a-date");
  });
});

describe("gitChangesSince", () => {
  it("asks git for hunk HEADERS only, after the day following the review", () => {
    let args = null;
    const spawn = (_cmd, a) => {
      args = a;
      return { status: 0, stdout: "" };
    };
    gitChangesSince("/root", spawn)("src/x.ts", "2026-07-01");
    expect(args).toContain("-U0"); // headers, not context — AC2
    expect(args).toContain("--after=2026-07-02T00:00:00");
    expect(args).toContain("src/x.ts");
  });

  it("degrades to NO hunks when git fails, never to a wrong answer", () => {
    // AC4. The same rule the shallow-clone guard follows for commitTime: a
    // missing explanation is recoverable, a confidently wrong one is not.
    //
    // stdout is NON-EMPTY on purpose. A first version of this case used
    // `stdout: ""`, which parses to [] whether or not the status is checked —
    // so deleting the status check left it GREEN. Sabotage found that; the
    // stub now emits output that WOULD parse, so the only thing that can make
    // the result empty is the status check itself.
    const spawn = () => ({ status: 128, stdout: "\u0000dead123 partial output\n@@ -1 +1,5 @@\n" });
    expect(gitChangesSince("/root", spawn)("src/x.ts", "2026-07-01")).toEqual([]);
  });

  it("caches per (path, since) so one ref is not re-shelled per note", () => {
    let calls = 0;
    const spawn = () => {
      calls++;
      return { status: 0, stdout: "" };
    };
    const f = gitChangesSince("/root", spawn);
    f("src/x.ts", "2026-07-01");
    f("src/x.ts", "2026-07-01");
    expect(calls).toBe(1);
    // A DIFFERENT review date is a different question and must re-run.
    f("src/x.ts", "2026-06-01");
    expect(calls).toBe(2);
  });
});

describe("checkDrift", () => {
  // commitTime stub: every ref reports the same commit date.
  const at = (day) => () => `${day}T12:00:00+00:00`;
  const codeNote = (over = {}) =>
    vault({ INDEX: [["a"]], a: [[], { source_of_truth: "code", code_refs: ["src/x.ts"], reviewed: "2026-07-01", ...over }] });

  it("flags a code_ref committed AFTER the review date", () => {
    const r = checkDrift(codeNote(), { commitTime: at("2026-07-10") });
    expect(r.warnings.some((w) => w.includes("DRIFT") && w.includes("src/x.ts"))).toBe(true);
    expect(r.errors).toEqual([]);
  });
  it("appends the commit subjects and line ranges when changesSince is given", () => {
    const r = checkDrift(codeNote(), {
      commitTime: at("2026-07-10"),
      changesSince: () => [{ sha: "abc1234", subject: "US-9: moved the weights", ranges: ["40-52"] }],
    });
    expect(r.warnings[0]).toContain("abc1234 US-9: moved the weights");
    expect(r.warnings[0]).toContain("[L40-52]");
  });

  it("falls back to the plain message when changesSince is absent", () => {
    // AC4: CI's shallow clone has no per-file history, so the hunk lookup has
    // to be optional. Losing the hunks must not lose the WARNING.
    const r = checkDrift(codeNote(), { commitTime: at("2026-07-10") });
    expect(r.warnings[0]).toContain("DRIFT");
    expect(r.warnings[0]).not.toContain("[L");
  });

  it("does not flag a code_ref committed BEFORE the review date", () => {
    const r = checkDrift(codeNote(), { commitTime: at("2026-06-01") });
    expect(r.warnings).toEqual([]);
  });
  it("does not flag a commit on the review date itself", () => {
    const r = checkDrift(codeNote(), { commitTime: at("2026-07-01") });
    expect(r.warnings).toEqual([]);
  });
  it("escalates to an ERROR for type:contract under --strict", () => {
    const r = checkDrift(codeNote({ type: "contract" }), { commitTime: at("2026-07-10"), strict: true });
    expect(r.errors.length).toBe(1);
    expect(r.warnings).toEqual([]);
  });
  it("keeps NON-contract drift a warning even under --strict", () => {
    const r = checkDrift(codeNote({ type: "reference" }), { commitTime: at("2026-07-10"), strict: true });
    expect(r.errors).toEqual([]);
    expect(r.warnings.length).toBe(1);
  });
  it("EXEMPTS archived notes — they are supposed to describe old code", () => {
    const r = checkDrift(codeNote({ type: "contract", status: "archived" }), { commitTime: at("2026-07-10"), strict: true });
    expect(r.errors).toEqual([]);
    expect(r.warnings).toEqual([]);
  });
  it("ignores source_of_truth 'vault' notes entirely", () => {
    const v = vault({ INDEX: [["a"]], a: [[], { source_of_truth: "vault", code_refs: ["src/x.ts"], reviewed: "2020-01-01" }] });
    expect(checkDrift(v, { commitTime: at("2026-07-10") }).warnings).toEqual([]);
  });
  it("skips a ref git has no record of", () => {
    expect(checkDrift(codeNote(), { commitTime: () => null }).warnings).toEqual([]);
  });
  it("skips a note whose reviewed date is malformed (schema rule owns that)", () => {
    const r = checkDrift(codeNote({ reviewed: "nonsense" }), { commitTime: at("2026-07-10") });
    expect(r.warnings).toEqual([]);
  });
});

describe("isShallowRepo", () => {
  const spawn = (stdout, status = 0) => () => ({ status, stdout });
  it("detects a shallow clone", () => {
    expect(isShallowRepo(".", spawn("true\n"))).toBe(true);
  });
  it("reports a full clone as not shallow", () => {
    expect(isShallowRepo(".", spawn("false\n"))).toBe(false);
  });
  it("treats a git failure as not shallow (drift still runs)", () => {
    expect(isShallowRepo(".", spawn("", 128))).toBe(false);
  });
});

describe("canonicalizeFrontmatter", () => {
  it("orders known keys and renders list forms correctly", () => {
    const out = canonicalizeFrontmatter({
      summary: "s", reviewed: TODAY, title: "T", tags: ["a", "b"],
      code_refs: ["x.ts"], type: "reference", status: "current", source_of_truth: "vault",
    });
    expect(out.split("\n")[0]).toBe("title: T");
    expect(out).toContain("tags: [a, b]");
    expect(out).toContain("code_refs:\n  - x.ts");
    expect(out.indexOf("reviewed:")).toBeLessThan(out.indexOf("summary:"));
  });
  it("quotes values containing a colon", () => {
    expect(canonicalizeFrontmatter({ title: "ADR-1: Thing" })).toBe('title: "ADR-1: Thing"');
  });
  it("renders an empty list inline", () => {
    expect(canonicalizeFrontmatter({ code_refs: [] })).toBe("code_refs: []");
  });
});

describe("fixNote", () => {
  it("stamps a MISSING reviewed date", () => {
    const r = fixNote(`---\ntitle: T\ntype: reference\nstatus: current\nsource_of_truth: vault\ncode_refs: []\n---\nbody`, { today: TODAY });
    expect(r.changed).toBe(true);
    expect(r.text).toContain(`reviewed: ${TODAY}`);
    expect(r.applied.join()).toMatch(/stamped missing reviewed/);
  });
  it("NEVER touches an existing reviewed date", () => {
    // The one thing --fix must not automate: bumping `reviewed` asserts a human
    // re-read the code_refs. See vault/CONTRACT.md.
    const src = `---\ntitle: T\ntype: reference\nstatus: current\nsource_of_truth: vault\ncode_refs: []\nreviewed: 2020-01-01\ntags: []\n---\nbody`;
    expect(fixNote(src, { today: TODAY }).text).toContain("reviewed: 2020-01-01");
  });
  it("preserves the body verbatim", () => {
    const body = "# Title\n\nSome [[link]] and `code`.\n";
    const r = fixNote(`---\ntitle: T\n---\n${body}`, { today: TODAY });
    expect(r.text.endsWith(body)).toBe(true);
  });
  it("is a no-op on a note with no frontmatter", () => {
    expect(fixNote("just text", { today: TODAY }).changed).toBe(false);
  });
});

describe("revisit_by (US-2056)", () => {
  const opts = { today: TODAY, exists: yes };
  const withRevisit = (over) =>
    vault({ INDEX: [["d"]], d: [[], { type: "decision", status: "accepted", ...over }] });

  it("warns when the revisit date has passed", () => {
    const r = lintVault(withRevisit({ revisit_by: "2026-01-01" }), opts);
    expect(r.ok).toBe(true);
    expect(r.warnings.some((w) => w.includes("REVISIT DUE"))).toBe(true);
  });
  it("stays silent before the date", () => {
    const r = lintVault(withRevisit({ revisit_by: "2099-01-01" }), opts);
    expect(r.warnings.some((w) => w.includes("REVISIT DUE"))).toBe(false);
  });
  it("stays silent on the date itself", () => {
    const r = lintVault(withRevisit({ revisit_by: TODAY }), opts);
    expect(r.warnings.some((w) => w.includes("REVISIT DUE"))).toBe(false);
  });
  it("does not nag about a decision already superseded", () => {
    const r = lintVault(withRevisit({ revisit_by: "2026-01-01", status: "superseded" }), opts);
    expect(r.warnings.some((w) => w.includes("REVISIT DUE"))).toBe(false);
  });
  it("ignores a malformed date rather than guessing", () => {
    const r = lintVault(withRevisit({ revisit_by: "soon" }), opts);
    expect(r.warnings.some((w) => w.includes("REVISIT DUE"))).toBe(false);
  });
});

describe("knowledge-bearing migrations (US-2059)", () => {
  const mig = (file, sql = "SELECT 1;") => ({ file, sql });
  const prose = (n) => Array.from({ length: n }, (_, i) => `-- line ${i}`).join("\n") + "\nSELECT 1;";
  const none = new Set();

  it("grandfathers everything at or below the threshold", () => {
    const r = checkMigrationNotes([mig("00468_handbags_accessories_brand_knowledge.sql")], none);
    expect(r).toEqual([]);
  });
  it("FAILS a NEW migration whose name says knowledge", () => {
    const r = checkMigrationNotes([mig("00500_shoes_brand_knowledge.sql")], none);
    expect(r[0]).toMatch(/name says knowledge/);
    expect(r[0]).toMatch(/IMMUTABLE/);
  });
  it("FAILS a NEW migration with an over-long header even when the name is innocent", () => {
    const r = checkMigrationNotes([mig("00500_add_column.sql", prose(45))], none);
    expect(r[0]).toMatch(/45-line header/);
  });
  it("passes once a note claims it via code_refs", () => {
    const refs = new Set(["supabase/migrations/00500_shoes_brand_knowledge.sql"]);
    expect(checkMigrationNotes([mig("00500_shoes_brand_knowledge.sql")], refs)).toEqual([]);
  });
  it("passes a NEW migration with a short header and an ordinary name", () => {
    expect(checkMigrationNotes([mig("00500_add_column.sql", prose(5))], none)).toEqual([]);
  });
  it("treats exactly the limit as acceptable, one over as not", () => {
    expect(checkMigrationNotes([mig("00500_a.sql", prose(40))], none)).toEqual([]);
    expect(checkMigrationNotes([mig("00501_a.sql", prose(41))], none)).toHaveLength(1);
  });
  it("ignores a file with no leading number rather than crashing", () => {
    expect(checkMigrationNotes([mig("no_number_knowledge.sql")], none)).toHaveLength(1);
  });
});

describe("leadingCommentLines / isKnowledgeBearing", () => {
  it("counts only the LEADING comment block, not comments after SQL", () => {
    expect(leadingCommentLines("-- a\n-- b\nSELECT 1;\n-- c\n-- d")).toBe(2);
  });
  it("skips blank lines inside the leading block", () => {
    expect(leadingCommentLines("-- a\n\n-- b\nSELECT 1;")).toBe(2);
  });
  it("returns null for an ordinary migration", () => {
    expect(isKnowledgeBearing("00500_add_index.sql", "-- one line\nSELECT 1;")).toBeNull();
  });
});

describe("review queue (US-2067)", () => {
  const at = (day) => () => `${day}T12:00:00+00:00`;
  const v = (spec) => {
    const m = new Map();
    for (const [name, over] of Object.entries(spec)) {
      m.set(name, { path: `vault/${name}.md`, fm: fm(over), body: "", links: [], raw: "" });
    }
    return m;
  };

  it("is empty when nothing has drifted", () => {
    const q = buildReviewQueue(v({ a: { source_of_truth: "code", code_refs: ["x.ts"] } }),
      { commitTime: at("2026-01-01"), today: TODAY });
    expect(q.total).toBe(0);
  });
  it("ranks a drifted CONTRACT above a drifted reference", () => {
    const q = buildReviewQueue(v({
      ref: { type: "reference", source_of_truth: "code", code_refs: ["x.ts"], reviewed: "2026-01-01" },
      con: { type: "contract", source_of_truth: "code", code_refs: ["x.ts"], reviewed: "2026-06-01" },
    }), { commitTime: at("2026-07-10"), today: TODAY });
    expect(q.batch[0].name).toBe("con");
  });
  it("includes a decision past revisit_by", () => {
    const q = buildReviewQueue(v({ d: { type: "decision", revisit_by: "2026-01-01" } }),
      { commitTime: () => null, today: TODAY });
    expect(q.batch[0].reason).toMatch(/revisit_by/);
  });
  it("does not nag about an archived or superseded note", () => {
    const q = buildReviewQueue(v({
      a: { status: "archived", source_of_truth: "code", code_refs: ["x.ts"], reviewed: "2020-01-01" },
      s: { status: "superseded", type: "decision", revisit_by: "2020-01-01" },
    }), { commitTime: at("2026-07-10"), today: TODAY });
    expect(q.total).toBe(0);
  });
  it("emits ONE entry per note even when several refs drifted", () => {
    const q = buildReviewQueue(v({ a: { source_of_truth: "code", code_refs: ["x.ts", "y.ts", "z.ts"], reviewed: "2026-01-01" } }),
      { commitTime: at("2026-07-10"), today: TODAY });
    expect(q.total).toBe(1);
  });
  it("BOUNDS the batch — a session must be able to end", () => {
    const many = {};
    for (let i = 0; i < 20; i++) many[`n${i}`] = { source_of_truth: "code", code_refs: ["x.ts"], reviewed: "2026-01-01" };
    const q = buildReviewQueue(v(many), { commitTime: at("2026-07-10"), today: TODAY, limit: 5 });
    expect(q.total).toBe(20);
    expect(q.batch).toHaveLength(5);
  });
});
