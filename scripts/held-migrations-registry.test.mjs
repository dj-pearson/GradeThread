// Platform plan action 6: held-migration state is a registry, not prose.
//
// scripts/held-migration-gate.mjs used to find held migrations with a regex
// over PENDING_MIGRATIONS.md headings, and its own header records seven times
// that regex matched nothing and printed "OK" while a migration was held
// (filename optional, PENDING vs HELD, a date before the colon, several
// versions on one heading, ...). The gate now reads supabase/held-migrations.json
// and nothing else.
//
// The headings still exist, because they are what the owner reads. So this
// file holds the two together in BOTH directions: a HELD heading with no
// registry entry would be the old bypass in a new place (the gate would say
// OK), and a registry entry with no heading is a block nobody can explain.

import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { heldFromRegistry, heldMigrations, REGISTRY } from "./held-migration-gate.mjs";

const ROOT = resolve(import.meta.dirname, "..");
const registryText = readFileSync(resolve(ROOT, REGISTRY), "utf8");
const registry = JSON.parse(registryText);
const doc = readFileSync(resolve(ROOT, "PENDING_MIGRATIONS.md"), "utf8");

describe("heldFromRegistry", () => {
  const all = () => true;

  it("reads a well-formed list", () => {
    const { held, errors } = heldFromRegistry(
      JSON.stringify({ held: [{ version: "00900", file: "00900_x.sql" }] }),
      all,
    );
    expect(errors).toEqual([]);
    expect(held.map((h) => h.file)).toEqual(["supabase/migrations/00900_x.sql"]);
  });

  it("an empty list is written as an empty array and reads as nothing held", () => {
    expect(heldFromRegistry('{"held": []}', all)).toEqual({ held: [], errors: [] });
  });

  it("refuses text that is not JSON instead of reading it as empty", () => {
    const { held, errors } = heldFromRegistry("{ held: [", all);
    expect(held).toEqual([]);
    expect(errors.join()).toMatch(/not valid JSON/);
  });

  it("refuses a file with no held array", () => {
    expect(heldFromRegistry('{"hold": []}', all).errors.join()).toMatch(/no "held" array/);
  });

  it("refuses an entry whose file does not start with its own version", () => {
    const { errors } = heldFromRegistry(
      JSON.stringify({ held: [{ version: "00900", file: "00901_x.sql" }] }),
      all,
    );
    expect(errors.join()).toMatch(/00900/);
  });

  it("refuses a version that is not five digits", () => {
    const { errors } = heldFromRegistry(
      JSON.stringify({ held: [{ version: "900", file: "900_x.sql" }] }),
      all,
    );
    expect(errors.length).toBe(1);
  });

  it("refuses the same version twice", () => {
    const e = { version: "00900", file: "00900_x.sql" };
    expect(heldFromRegistry(JSON.stringify({ held: [e, e] }), all).errors.join()).toMatch(
      /second time/,
    );
  });

  it("reports an entry whose file is not on disk as null, not a guessed path", () => {
    const { held } = heldFromRegistry(
      JSON.stringify({ held: [{ version: "00900", file: "00900_x.sql" }] }),
      () => false,
    );
    expect(held[0].file).toBeNull();
    expect(held[0].named).toBe("supabase/migrations/00900_x.sql");
  });
});

describe("the gate fails closed on its input", () => {
  const gate = resolve(ROOT, "scripts/held-migration-gate.mjs");

  function runIn(dir) {
    try {
      execFileSync(process.execPath, [gate, "--ci"], { cwd: dir, stdio: "pipe" });
      return 0;
    } catch (e) {
      return e.status;
    }
  }

  it("blocks when the registry is missing, where the old input skipped", () => {
    const dir = mkdtempSync(join(tmpdir(), "held-gate-"));
    try {
      expect(runIn(dir)).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("blocks when the registry does not parse", () => {
    const dir = mkdtempSync(join(tmpdir(), "held-gate-"));
    try {
      mkdirSync(join(dir, "supabase"));
      writeFileSync(join(dir, REGISTRY), "{ not json");
      expect(runIn(dir)).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("blocks on a held file that is present, and passes when the list is empty", () => {
    const dir = mkdtempSync(join(tmpdir(), "held-gate-"));
    try {
      mkdirSync(join(dir, "supabase/migrations"), { recursive: true });
      writeFileSync(join(dir, "supabase/migrations/00900_x.sql"), "select 1;");
      writeFileSync(
        join(dir, REGISTRY),
        JSON.stringify({ held: [{ version: "00900", file: "00900_x.sql" }] }),
      );
      expect(runIn(dir)).toBe(1);
      writeFileSync(join(dir, REGISTRY), JSON.stringify({ held: [] }));
      expect(runIn(dir)).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("the committed registry", () => {
  it("parses with no errors", () => {
    expect(heldFromRegistry(registryText).errors).toEqual([]);
  });

  it("names only files that exist", () => {
    for (const h of heldFromRegistry(registryText).held) {
      expect(h.file, `${REGISTRY} holds ${h.named}, which is not on disk`).not.toBeNull();
    }
  });

  it("every parked entry names a branch and a migration that is NOT in this tree", () => {
    // Parked means "finished, on a side branch only". A parked version that has
    // landed in the tree belongs in `held` (or nowhere, once applied).
    expect(Array.isArray(registry.parked)).toBe(true);
    for (const p of registry.parked) {
      expect(p.branch, `parked ${p.version} names no branch`).toMatch(/^held(-v\d+)?\//);
      const inTree = readdirSync(resolve(ROOT, "supabase/migrations")).some((n) =>
        n.startsWith(`${p.version}_`),
      );
      expect(inTree, `parked ${p.version} is in the tree now; move or delete the entry`).toBe(
        false,
      );
    }
  });
});

describe("PENDING_MIGRATIONS.md headings and the registry agree (transition guard)", () => {
  const headings = heldMigrations(doc).map((h) => h.version).sort();
  const listed = registry.held.map((h) => h.version).sort();

  it("the heading parser still finds the held headings, so the check is not vacuous", () => {
    // If the registry is non-empty and the parser finds nothing, the two cases
    // below would compare an empty list against itself only by accident.
    if (listed.length > 0) expect(headings.length).toBeGreaterThan(0);
  });

  it("every HELD heading has a registry entry", () => {
    expect(
      headings.filter((v) => !listed.includes(v)),
      `a heading says HELD and ${REGISTRY} does not, so the gate would pass it. ` +
        "Add the entry.",
    ).toEqual([]);
  });

  it("every registry entry has a HELD heading", () => {
    expect(
      listed.filter((v) => !headings.includes(v)),
      `${REGISTRY} holds a migration PENDING_MIGRATIONS.md does not explain. ` +
        "Either it was applied (delete the entry) or its heading is missing.",
    ).toEqual([]);
  });
});
