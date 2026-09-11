// US-2050 / US-3402: coverage for the .agents mirror guard (Node env, see
// vitest.scripts.config.mjs). Most trees are injected, so no fixture files on
// disk; the last block deliberately runs against the REAL repo, because that is
// the assertion that stops the first-party copies coming back.
import { describe, expect, it } from "vitest";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  auditMirrorRoot,
  compareTrees,
  firstPartySkills,
  listDirs,
  MIRROR,
  MIRROR_ROOT,
  MIRRORED_SKILLS,
  normalizeEol,
  PRIMARY,
  walkFiles,
} from "./skills-sync.mjs";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");

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
    expect(compareTrees(".", "s", io)).toEqual({ errors: [], warnings: [] });
  });

  it("fails when file CONTENT differs, the update-one-forget-the-other case", () => {
    const io = both({ "SKILL.md": "v2" }, { "SKILL.md": "v1" });
    const { errors } = compareTrees(".", "s", io);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/content differs: SKILL\.md/);
  });

  it("names the copy command in the content-drift message, not just the fact", () => {
    const io = both({ "SKILL.md": "v2" }, { "SKILL.md": "v1" });
    // US-3402: the old summary line said "copy the newer over the older" for
    // EVERY failure, including first-party ones where copying is the wrong fix.
    // The remedy now travels with the finding it applies to.
    expect(compareTrees(".", "s", io).errors[0]).toContain(`cp -r ${PRIMARY}/s/. ${MIRROR}/s/`);
  });

  it("reports a file present only in the primary tree", () => {
    const io = both({ "SKILL.md": "x", "new.md": "n" }, { "SKILL.md": "x" });
    expect(compareTrees(".", "s", io).errors[0]).toMatch(/only in \.claude\/skills: new\.md/);
  });

  it("reports a file present only in the mirror", () => {
    const io = both({ "SKILL.md": "x" }, { "SKILL.md": "x", "stale.md": "s" });
    expect(compareTrees(".", "s", io).errors[0]).toMatch(/only in \.agents\/skills: stale\.md/);
  });

  it("reports a missing mirror tree with actionable wording", () => {
    const io = fake({ [`${PRIMARY}/s`]: { "SKILL.md": "x" } });
    expect(compareTrees(".", "s", io).errors[0]).toMatch(/missing: restore it or drop the skill/);
  });

  it("reports a missing primary tree", () => {
    const io = fake({ [`${MIRROR}/s`]: { "SKILL.md": "x" } });
    expect(compareTrees(".", "s", io).errors[0]).toMatch(/\.claude\/skills\/s is missing/);
  });

  it("collects every difference rather than stopping at the first", () => {
    const io = both({ "a.md": "1", "b.md": "2" }, { "a.md": "X", "b.md": "Y" });
    expect(compareTrees(".", "s", io).errors).toHaveLength(2);
  });
});

describe("line endings are not content", () => {
  // Every blob in both trees is LF and core.autocrlf=true, so both sides check
  // out the same way today. They stop doing so the moment one side is rewritten
  // by a tool that emits LF: that is how .claude/skills/migrations/SKILL.md and
  // .claude/skills/grading-engine/SKILL.md came to sit LF in a CRLF tree. A raw
  // compare would then fail here and pass on Linux CI over zero content
  // difference, which is the false alarm .gitattributes documents five times.
  it("treats a CRLF/LF-only difference as a warning, never an error", () => {
    const io = both({ "SKILL.md": "a\r\nb\r\n" }, { "SKILL.md": "a\nb\n" });
    const { errors, warnings } = compareTrees(".", "s", io);
    expect(errors).toEqual([]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/differs only in line endings/);
  });

  it("still fails when the content differs AND the line endings do", () => {
    const io = both({ "SKILL.md": "a\r\nCAP\r\n" }, { "SKILL.md": "a\n" });
    expect(compareTrees(".", "s", io).errors[0]).toMatch(/content differs/);
  });

  it("normalizeEol drops CR only before LF, leaving a lone CR alone", () => {
    expect(normalizeEol(Buffer.from("a\r\nb\rc\n")).toString()).toBe("a\nb\rc\n");
  });
});

describe("auditMirrorRoot", () => {
  const walking = (paths) => ({ walk: () => paths, firstParty: ["migrations", "grading-engine"] });

  it("passes when .agents holds nothing but the vendor trees", () => {
    expect(
      auditMirrorRoot(".", walking(["skills/supabase/SKILL.md", "skills/supabase-postgres-best-practices/SKILL.md"])),
    ).toEqual([]);
  });

  it("reports a mirrored first-party skill and tells you to DELETE it", () => {
    const errs = auditMirrorRoot(".", walking(["skills/migrations/SKILL.md"]));
    expect(errs).toHaveLength(1);
    expect(errs[0]).toContain('first-party skill "migrations"');
    expect(errs[0]).toContain(`rm -rf ${MIRROR}/migrations`);
    // The wrong remedy must not appear: copying is what produced two spellings
    // of one runbook in the first place.
    expect(errs[0]).not.toContain("cp -r");
  });

  it("names the path that actually exists, not the skill's canonical path", () => {
    // First sabotage run printed `rm -rf .agents/skills/grading-engine` for a
    // copy that lived at .agents/skills/vendor-bundle/grading-engine. A remedy
    // that deletes nothing is worse than no remedy: it looks like it worked.
    const errs = auditMirrorRoot(".", walking(["skills/vendor-bundle/grading-engine/SKILL.md"]));
    expect(errs[0]).toContain(`rm -rf ${MIRROR}/vendor-bundle`);
  });

  it("groups a multi-file skill into ONE finding with a file count", () => {
    const errs = auditMirrorRoot(
      ".",
      walking([
        "skills/grading-engine/SKILL.md",
        "skills/grading-engine/references/rounding-sites.md",
        "skills/grading-engine/references/prompt-lifecycle.md",
      ]),
    );
    expect(errs).toHaveLength(1);
    expect(errs[0]).toContain("(3 file(s))");
  });

  it("names the SKILL even when it is nested below a directory of another name", () => {
    // The old guard did report `vendor-bundle` here (it was a direct child), but
    // only as an unknown name. It never said which skill was inside, which is
    // the part that tells you whether the copy can teach an agent a stale
    // contract.
    const errs = auditMirrorRoot(".", walking(["skills/vendor-bundle/migrations/SKILL.md"]));
    expect(errs[0]).toContain('first-party skill "migrations"');
  });

  it("catches a loose FILE sitting beside the vendor trees", () => {
    // Genuinely invisible to the old guard: it enumerated directories only, so
    // `.agents/skills/migrations.md` was zero findings, which reads clean.
    const errs = auditMirrorRoot(".", walking(["skills/README.md"]));
    expect(errs[0]).toContain("is not part of a vendor mirror");
  });

  it("catches anything under .agents outside skills/ entirely", () => {
    // Also invisible before: the old guard never looked above .agents/skills.
    const errs = auditMirrorRoot(".", walking(["commands/deploy.md"]));
    expect(errs[0]).toContain(`${MIRROR_ROOT}/commands is not part of a vendor mirror`);
  });

  it("does not treat a bare vendor-named entry as a valid mirror file", () => {
    // `skills/supabase` with nothing under it is not a mirrored file, it is a
    // file or empty directory wearing a vendor skill's name.
    expect(auditMirrorRoot(".", walking(["skills/supabase"]))[0]).toContain("not part of a vendor mirror");
  });
});

describe("firstPartySkills is derived, not remembered", () => {
  it("is whatever .claude/skills holds minus the vendor skills", () => {
    const io = { readdir: () => [
      { name: "migrations", isDirectory: () => true },
      { name: "supabase", isDirectory: () => true },
      { name: "a-skill-invented-tomorrow", isDirectory: () => true },
      { name: "README.md", isDirectory: () => false },
    ] };
    expect(firstPartySkills(".", io)).toEqual(["a-skill-invented-tomorrow", "migrations"]);
  });

  it("covers a brand-new skill without anyone editing this file", () => {
    const io = { readdir: () => [{ name: "brand-new", isDirectory: () => true }] };
    const errs = auditMirrorRoot(".", {
      ...io,
      walk: () => ["skills/brand-new/SKILL.md"],
      firstParty: firstPartySkills(".", io),
    });
    expect(errs[0]).toContain('first-party skill "brand-new"');
  });
});

describe("MIRRORED_SKILLS", () => {
  it("lists only vendor skills, first-party skills must have exactly one home", () => {
    for (const first of ["durable-jobs", "grading-engine", "migrations", "tenant-isolation", "vault"]) {
      expect(MIRRORED_SKILLS).not.toContain(first);
    }
    expect(MIRRORED_SKILLS).toEqual(["supabase", "supabase-postgres-best-practices"]);
  });
});

// -- The ratchet -------------------------------------------------------------
// US-3402: the five first-party skills were mirrored into .agents by commit
// f7d750e8d and the CLI guard reported them on every run for three days while
// nobody acted. These run against the real repo in `npm run test:scripts`, so
// the finding arrives as a named failing TEST rather than one more red line in
// a lane that was already red.
describe("the real .agents tree", () => {
  it("contains nothing but the two vendor mirrors", () => {
    expect(auditMirrorRoot(REPO)).toEqual([]);
  });

  it("has no first-party skill directory under it, by name", () => {
    const owned = firstPartySkills(REPO);
    expect(owned.length).toBeGreaterThan(0); // the derivation itself must work
    expect(listDirs(REPO, MIRROR) ?? []).toEqual([...MIRRORED_SKILLS].sort());
    for (const name of owned) {
      expect(walkFiles(REPO, MIRROR_ROOT).filter((p) => p.split("/").includes(name))).toEqual([]);
    }
  });

  it("keeps the two vendor mirrors identical in content", () => {
    for (const skill of MIRRORED_SKILLS) {
      expect(compareTrees(REPO, skill).errors, `${skill} drifted`).toEqual([]);
    }
  });
});
