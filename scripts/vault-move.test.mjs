// US-2047: vitest coverage for the vault move/stub tool (Node env — see
// vitest.scripts.config.mjs). Pure functions only; the CLI's git mv and writes
// are exercised by the dry-run path in the story's manual verification.
import { describe, expect, it } from "vitest";
import {
  buildFrontmatter,
  deriveSummary,
  deriveTitle,
  findResidualMentions,
  makeStub,
  parseStubRegistry,
  renderStubRegistry,
  rewriteRefs,
  STUB_MAX_LINES,
  upsertStubRow,
} from "./vault-move.mjs";

describe("deriveTitle", () => {
  it("uses the first H1", () => {
    expect(deriveTitle("intro\n# Real Title\n## Sub", "x/y.md")).toBe("Real Title");
  });
  it("falls back to a de-slugged filename", () => {
    expect(deriveTitle("no heading here", "docs/key-rotation.md")).toBe("key rotation");
  });
  it("ignores H2 and deeper", () => {
    expect(deriveTitle("## Not this\n# Yes this", "x/y.md")).toBe("Yes this");
  });
});

describe("deriveSummary", () => {
  it("takes the first prose sentence", () => {
    expect(deriveSummary("# H\n\nFirst one. Second one.")).toBe("First one.");
  });
  it("skips headings, quotes, lists, tables, code and numbered items", () => {
    expect(deriveSummary("# H\n> q\n- l\n| t |\n`c`\n1. n\nActual prose.")).toBe("Actual prose.");
  });
  it("returns empty when there is no prose", () => {
    expect(deriveSummary("# Only heading")).toBe("");
  });
});

describe("buildFrontmatter", () => {
  const base = { title: "T", type: "runbook", status: "current", sot: "vault", codeRefs: [], reviewed: "2026-07-18", tags: [], summary: "S" };
  it("emits every required field", () => {
    const out = buildFrontmatter(base);
    for (const k of ["title", "type", "status", "source_of_truth", "code_refs", "reviewed", "tags"]) {
      expect(out).toContain(`${k}:`);
    }
  });
  it("renders empty code_refs inline and populated ones as a block list", () => {
    expect(buildFrontmatter(base)).toContain("code_refs: []");
    expect(buildFrontmatter({ ...base, codeRefs: ["a.ts", "b.ts"] })).toContain("code_refs:\n  - a.ts\n  - b.ts");
  });
  it("quotes a title or summary containing a colon", () => {
    expect(buildFrontmatter({ ...base, title: "ADR: x" })).toContain('title: "ADR: x"');
    expect(buildFrontmatter({ ...base, summary: "a: b" })).toContain('summary: "a: b"');
  });
  it("omits summary when empty rather than emitting a blank key", () => {
    expect(buildFrontmatter({ ...base, summary: "" })).not.toContain("summary:");
  });
});

describe("makeStub", () => {
  it("stays within the lint cap", () => {
    const lines = makeStub("deploy", "vault/10-ops/deploy.md", "2026-07-18").split("\n").filter((l) => l.trim()).length;
    expect(lines).toBeLessThanOrEqual(STUB_MAX_LINES);
  });
  it("links the note and names the new path", () => {
    const s = makeStub("deploy", "vault/10-ops/deploy.md", "2026-07-18");
    expect(s).toContain("[[deploy]]");
    expect(s).toContain("vault/10-ops/deploy.md");
    expect(s).toContain("2026-07-18");
  });
});

describe("rewriteRefs", () => {
  it("rewrites a markdown link target", () => {
    const r = rewriteRefs("see [the doc](DEPLOY.md) now", "DEPLOY.md", "vault/10-ops/deploy.md");
    expect(r.text).toBe("see [the doc](vault/10-ops/deploy.md) now");
    expect(r.count).toBe(1);
  });
  it("rewrites an inline-code path", () => {
    const r = rewriteRefs("read `DEPLOY.md` first", "DEPLOY.md", "vault/10-ops/deploy.md");
    expect(r.text).toBe("read `vault/10-ops/deploy.md` first");
  });
  it("handles ./ and / prefixed forms", () => {
    expect(rewriteRefs("[a](./DEPLOY.md)", "DEPLOY.md", "N.md").text).toBe("[a](N.md)");
    expect(rewriteRefs("`/DEPLOY.md`", "DEPLOY.md", "N.md").text).toBe("`N.md`");
  });
  it("does NOT rewrite a bare prose mention — too risky to guess", () => {
    const r = rewriteRefs("as described in DEPLOY.md above", "DEPLOY.md", "N.md");
    expect(r.count).toBe(0);
    expect(r.text).toContain("DEPLOY.md");
  });
  it("does not partially match a longer filename", () => {
    const r = rewriteRefs("`DEPLOY.md.bak`", "DEPLOY.md", "N.md");
    expect(r.count).toBe(0);
  });
  it("counts every occurrence", () => {
    expect(rewriteRefs("[a](X.md) and `X.md`", "X.md", "N.md").count).toBe(2);
  });
});

describe("findResidualMentions", () => {
  it("reports a mention the rewriter left alone", () => {
    expect(findResidualMentions("see DEPLOY.md here", "DEPLOY.md", "N.md")).toEqual(["see DEPLOY.md here"]);
  });
  it("ignores lines already carrying the new path", () => {
    expect(findResidualMentions("[a](N.md)", "DEPLOY.md", "N.md")).toEqual([]);
  });
  it("returns empty when the path is absent", () => {
    expect(findResidualMentions("nothing here", "DEPLOY.md", "N.md")).toEqual([]);
  });
});

describe("stub registry", () => {
  const rows = [
    { oldPath: "DEPLOY.md", note: "deploy", created: "2026-07-18" },
    { oldPath: "docs/PRICING.md", note: "pricing", created: "2026-07-19" },
  ];
  it("round-trips through render and parse", () => {
    expect(parseStubRegistry(renderStubRegistry(rows))).toEqual(
      [...rows].sort((a, b) => a.oldPath.localeCompare(b.oldPath)),
    );
  });
  it("sorts by old path for a stable diff", () => {
    const out = renderStubRegistry([rows[1], rows[0]]);
    expect(out.indexOf("DEPLOY.md")).toBeLessThan(out.indexOf("PRICING.md"));
  });
  it("ignores non-table lines", () => {
    expect(parseStubRegistry("# Heading\n\nprose\n")).toEqual([]);
  });
  it("upsert replaces an existing row rather than duplicating it", () => {
    const next = upsertStubRow(rows, { oldPath: "DEPLOY.md", note: "deploy-v2", created: "2026-07-20" });
    expect(next.filter((r) => r.oldPath === "DEPLOY.md")).toHaveLength(1);
    expect(next.find((r) => r.oldPath === "DEPLOY.md").note).toBe("deploy-v2");
  });
});
