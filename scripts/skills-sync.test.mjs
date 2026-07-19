// US-2050: vitest coverage for the vendor-skill mirror guard (Node env — see
// vitest.scripts.config.mjs). Trees are injected, so no fixture files on disk.
import { describe, expect, it } from "vitest";
import { compareTrees, MIRRORED_SKILLS, MIRROR, PRIMARY } from "./skills-sync.mjs";

// Build injectable list/read fns from a plain { "<dir>": { file: contents } } map.
const fake = (trees) => ({
  list: (_root, dir) => (trees[dir] ? Object.keys(trees[dir]).sort() : null),
  read: (abs) => {
    const p = String(abs).replace(/\\/g, "/");
    for (const [dir, files] of Object.entries(trees)) {
      for (const [f, content] of Object.entries(files)) {
        if (p.endsWith(`${dir}/${f}`)) return Buffer.from(content);
      }
    }
    throw new Error(`no fixture for ${p}`);
  },
});

const both = (a, b) => fake({ [`${PRIMARY}/s`]: a, [`${MIRROR}/s`]: b });

describe("compareTrees", () => {
  it("passes when the trees are identical", () => {
    const io = both({ "SKILL.md": "x", "refs/a.md": "y" }, { "SKILL.md": "x", "refs/a.md": "y" });
    expect(compareTrees(".", "s", io)).toEqual([]);
  });

  it("fails when file CONTENT differs — the update-one-forget-the-other case", () => {
    const io = both({ "SKILL.md": "v2" }, { "SKILL.md": "v1" });
    const errs = compareTrees(".", "s", io);
    expect(errs).toHaveLength(1);
    expect(errs[0]).toMatch(/content differs — SKILL\.md/);
  });

  it("reports a file present only in the primary tree", () => {
    const io = both({ "SKILL.md": "x", "new.md": "n" }, { "SKILL.md": "x" });
    expect(compareTrees(".", "s", io)[0]).toMatch(/only in \.claude\/skills — new\.md/);
  });

  it("reports a file present only in the mirror", () => {
    const io = both({ "SKILL.md": "x" }, { "SKILL.md": "x", "stale.md": "s" });
    expect(compareTrees(".", "s", io)[0]).toMatch(/only in \.agents\/skills — stale\.md/);
  });

  it("reports a missing mirror tree with actionable wording", () => {
    const io = fake({ [`${PRIMARY}/s`]: { "SKILL.md": "x" } });
    expect(compareTrees(".", "s", io)[0]).toMatch(/missing — restore it or drop the skill/);
  });

  it("reports a missing primary tree", () => {
    const io = fake({ [`${MIRROR}/s`]: { "SKILL.md": "x" } });
    expect(compareTrees(".", "s", io)[0]).toMatch(/\.claude\/skills\/s is missing/);
  });

  it("collects every difference rather than stopping at the first", () => {
    const io = both({ "a.md": "1", "b.md": "2" }, { "a.md": "X", "b.md": "Y" });
    expect(compareTrees(".", "s", io)).toHaveLength(2);
  });
});

describe("MIRRORED_SKILLS", () => {
  it("lists only vendor skills — first-party skills must have exactly one home", () => {
    for (const first of ["durable-jobs", "grading-engine", "migrations", "tenant-isolation", "vault"]) {
      expect(MIRRORED_SKILLS).not.toContain(first);
    }
    expect(MIRRORED_SKILLS).toEqual(["supabase", "supabase-postgres-best-practices"]);
  });
});
