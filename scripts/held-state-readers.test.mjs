// The readers of held-migration state outside the gate --
// scripts/operator-worklist.mjs (the "Start here" list) and the session
// banner hooks .claude/hooks/session-context.mjs and
// .codex/hooks/session-context.mjs -- read supabase/held-migrations.json, not
// PENDING_MIGRATIONS.md headings.
//
// Each script is copied into a throwaway root whose registry and headings
// DISAGREE on purpose: the registry holds 00901 and 00902, and the only HELD
// heading names 00900. A reader that went back to the headings would name 00900
// and miss the other two, which is what these cases catch.
import { describe, expect, it } from "vitest";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";

const ROOT = resolve(import.meta.dirname, "..");

const REGISTRY = {
  held: [
    { version: "00902", file: "00902_second_thing.sql", story: "money plan action 9", what: "the second thing" },
    { version: "00901", file: "00901_first_thing.sql", story: "US-9001", what: "the first thing" },
  ],
  parked: [],
};

const HOOKS = [".claude/hooks/session-context.mjs", ".codex/hooks/session-context.mjs"];

const PENDING = "# Pending\n\n## HELD: 00900_heading_only.sql (US-9000 - only the heading has this)\n";

function fixture({ registry = REGISTRY } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "held-readers-"));
  mkdirSync(join(dir, "scripts"));
  mkdirSync(join(dir, "docs"));
  mkdirSync(join(dir, "supabase", "migrations"), { recursive: true });
  copyFileSync(join(ROOT, "scripts/operator-worklist.mjs"), join(dir, "scripts/operator-worklist.mjs"));
  for (const hook of HOOKS) {
    mkdirSync(join(dir, hook, ".."), { recursive: true });
    copyFileSync(join(ROOT, hook), join(dir, hook));
  }
  writeFileSync(join(dir, "PENDING_MIGRATIONS.md"), PENDING);
  writeFileSync(join(dir, "prd.json"), JSON.stringify({ nextId: "US-9999", userStories: [] }));
  if (registry !== null) {
    writeFileSync(join(dir, "supabase/held-migrations.json"), JSON.stringify(registry));
  }
  return dir;
}

function run(dir, script) {
  return execFileSync(process.execPath, [join(dir, script)], {
    cwd: dir,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

describe("operator-worklist.mjs reads the registry", () => {
  it("lists the registry's held migrations oldest first, with story and what", () => {
    const dir = fixture();
    try {
      run(dir, "scripts/operator-worklist.mjs");
      const doc = readFileSync(join(dir, "docs/operator-worklist.md"), "utf8");
      const block = doc.slice(doc.indexOf("## Start here"), doc.indexOf("## Where the work happens"));
      expect(block).toContain("**1. Apply the 2 held migrations, oldest first.**");
      expect(block).toContain("- `00901_first_thing.sql` — US-9001 — the first thing");
      expect(block).toContain("- `00902_second_thing.sql` — money plan action 9 - the second thing");
      expect(block.indexOf("00901_")).toBeLessThan(block.indexOf("00902_"));
      expect(block, "a heading-only migration is not held").not.toContain("00900");
      // The sentence saying where the list comes from names the registry.
      expect(block).toContain("Computed from supabase/held-migrations.json and the criteria below");
      expect(block).not.toContain("Computed from PENDING_MIGRATIONS.md");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses to write a worklist when the registry is missing", () => {
    // Reading a missing registry as empty would tell the owner nothing is held.
    const dir = fixture({ registry: null });
    try {
      expect(() => run(dir, "scripts/operator-worklist.mjs")).toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe.each(HOOKS)("%s reads the registry", (hook) => {
  it("names the registry's held migrations newest first, and not the heading-only one", () => {
    const dir = fixture();
    try {
      const out = JSON.parse(run(dir, hook));
      const ctx = out.hookSpecificOutput.additionalContext;
      expect(ctx).toContain(
        "2 migration(s) HELD (not yet applied to prod): 00902_second_thing, 00901_first_thing.",
      );
      expect(ctx).not.toContain("00900");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("still exits 0 with no registry, and names nothing held", () => {
    // The hook's contract is that it never breaks a session.
    const dir = fixture({ registry: null });
    try {
      const out = run(dir, hook);
      expect(out).not.toMatch(/HELD/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
