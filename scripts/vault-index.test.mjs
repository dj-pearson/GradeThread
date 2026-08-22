// US-2045: vitest coverage for the vault index generator (Node env — see
// vitest.scripts.config.mjs).
import { describe, expect, it } from "vitest";
import {
  END,
  folderOf,
  groupByFolder,
  mocNameFor,
  renderIndexBody,
  renderMoc,
  sameContent,
  spliceGenerated,
  START,
  summaryFor,
} from "./vault-index.mjs";

const note = (path, over = {}) => ({
  path,
  body: over.body ?? "",
  links: [],
  raw: "",
  fm: { title: "T", type: "reference", status: "current", source_of_truth: "vault", code_refs: [], reviewed: "2026-07-18", ...over.fm },
});

const asMap = (spec) => new Map(Object.entries(spec));

describe("folderOf", () => {
  it("extracts the folder", () => {
    expect(folderOf("vault/10-ops/x.md")).toBe("10-ops");
  });
  it("groups a vault-root note under _meta, not its own filename", () => {
    // Regression: CONTRACT.md previously produced a heading called "CONTRACT.md".
    expect(folderOf("vault/CONTRACT.md")).toBe("_meta");
  });
  it("handles nested folders by their top level", () => {
    expect(folderOf("vault/20-domain/brands/x.md")).toBe("20-domain");
  });
});

describe("summaryFor", () => {
  it("prefers the frontmatter summary", () => {
    expect(summaryFor(note("vault/a/x.md", { fm: { summary: "From frontmatter." }, body: "Body text." }))).toBe("From frontmatter.");
  });
  it("falls back to the first prose sentence", () => {
    const n = note("vault/a/x.md", { body: "# Heading\n\n> quote\n\nFirst sentence. Second one." });
    expect(summaryFor(n)).toBe("First sentence.");
  });
  it("skips headings, quotes, tables and list items when falling back", () => {
    const n = note("vault/a/x.md", { body: "# H\n| a | b |\n- item\n> q\nReal prose here." });
    expect(summaryFor(n)).toBe("Real prose here.");
  });
  it("strips wikilink syntax out of the fallback", () => {
    const n = note("vault/a/x.md", { body: "See [[other|the other note]] for detail." });
    expect(summaryFor(n)).toBe("See other for detail.");
  });
  it("returns empty when there is no prose at all", () => {
    expect(summaryFor(note("vault/a/x.md", { body: "# Only a heading\n" }))).toBe("");
  });
});

describe("groupByFolder", () => {
  it("excludes 00-index — navigation is not a destination", () => {
    const g = groupByFolder(asMap({ INDEX: note("vault/00-index/INDEX.md"), a: note("vault/10-ops/a.md") }));
    expect([...g.keys()]).toEqual(["10-ops"]);
  });
  it("sorts notes within a folder by name", () => {
    const g = groupByFolder(asMap({ zebra: note("vault/10-ops/zebra.md"), alpha: note("vault/10-ops/alpha.md") }));
    expect(g.get("10-ops").map((n) => n.name)).toEqual(["alpha", "zebra"]);
  });
});

describe("renderIndexBody", () => {
  const many = (n) => asMap(Object.fromEntries(
    Array.from({ length: n }, (_, i) => [`n${i}`, note(`vault/10-ops/n${i}.md`, { fm: { summary: `S${i}` } })]),
  ));

  it("lists notes directly below the MOC threshold", () => {
    const out = renderIndexBody(many(3), { mocThreshold: 12 });
    expect(out).toContain("- [[n0]] — reference — S0");
    expect(out).not.toContain("moc-ops");
  });
  it("collapses a folder to a MOC link once it hits the threshold", () => {
    const out = renderIndexBody(many(12), { mocThreshold: 12 });
    expect(out).toContain("12 notes — see [[moc-ops]].");
    expect(out).not.toContain("- [[n0]]");
  });
  it("renders the human-readable folder label", () => {
    expect(renderIndexBody(many(1))).toContain("## 10-ops — operations and runbooks");
  });
  it("omits the em-dash tail when a note has no summary", () => {
    const out = renderIndexBody(asMap({ a: note("vault/10-ops/a.md") }));
    expect(out).toContain("- [[a]] — reference");
    expect(out).not.toContain("reference — \n");
  });
});

describe("renderMoc", () => {
  it("emits schema-valid frontmatter and links back to INDEX", () => {
    const out = renderMoc("10-ops", [{ name: "a", ...note("vault/10-ops/a.md", { fm: { summary: "S" } }) }]);
    expect(out.startsWith("---\ntitle:")).toBe(true);
    expect(out).toContain("type: moc");
    expect(out).toContain("[[INDEX]]");
    expect(out).toContain("- [[a]] — reference — S");
  });
  it("names MOCs by folder, without the numeric prefix", () => {
    expect(mocNameFor("40-growth")).toBe("moc-growth");
  });
});

describe("spliceGenerated", () => {
  it("replaces only the generated region", () => {
    const existing = `Top prose\n\n${START}\nOLD\n${END}\n\nBottom prose\n`;
    const out = spliceGenerated(existing, "NEW");
    expect(out).toContain("Top prose");
    expect(out).toContain("Bottom prose");
    expect(out).toContain("NEW");
    expect(out).not.toContain("OLD");
  });
  it("throws when the markers are missing", () => {
    expect(() => spliceGenerated("no markers", "x")).toThrow(/markers/);
  });
  it("throws when the markers are inverted", () => {
    expect(() => spliceGenerated(`${END}\n${START}`, "x")).toThrow(/markers/);
  });
  it("is idempotent", () => {
    const existing = `A\n\n${START}\nOLD\n${END}\n\nB\n`;
    expect(spliceGenerated(spliceGenerated(existing, "NEW"), "NEW")).toBe(spliceGenerated(existing, "NEW"));
  });
});


describe("sameContent", () => {
  // The generator writes LF. `.md` is not pinned in .gitattributes, so a Windows
  // checkout hands these files back as CRLF, and a raw !== then reported every
  // generated file as stale on every run. It did: --check failed on
  // moc-business.md while `git diff` showed one changed date, because git
  // normalises line endings and the comparison did not.
  //
  // The cost was not noise. The only way to clear it was to re-run the
  // generator, which rewrites `reviewed` to today - so a guard meant to make
  // someone re-read a note trained them to bump its date without reading, which
  // is the one failure mode no automation here can catch.
  it("treats CRLF and LF copies of the same text as equal", () => {
    const lf = "---\ntitle: T\n---\n\n- [A](a.md) - hook\n";
    expect(sameContent(lf, lf.split("\n").join("\r\n"))).toBe(true);
  });

  it("still sees a real content change", () => {
    expect(sameContent("- [A](a.md)\n", "- [B](b.md)\n")).toBe(false);
  });

  it("does not treat a missing line as a line-ending difference", () => {
    expect(sameContent("a\nb\n", "a\n")).toBe(false);
  });
});
