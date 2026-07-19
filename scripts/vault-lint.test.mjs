// US-2043: vitest coverage for the vault linter (Node env — see
// vitest.scripts.config.mjs). Every rule gets a passing AND a failing fixture;
// a rule tested only in its passing direction proves nothing.
import { describe, expect, it } from "vitest";
import {
  checkDrift,
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
