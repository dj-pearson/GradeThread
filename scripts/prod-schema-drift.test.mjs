// US-3410. The self-check for scripts/prod-schema-drift.mjs.
//
// The script's own `--self-test` proves the differ reports a planted difference
// and fails closed; this suite proves the things a synthetic fixture cannot:
// that the derivation runs against the REAL migration corpus, that the KNOWN
// list is the shape the judge expects, and that the two lanes still invoke it.
// A guard nobody runs is the failure mode this repo keeps re-learning.

import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import {
  KNOWN,
  MIN_MIGRATION_FILES,
  diffSchemas,
  judge,
  migrationDdlEvents,
  migrationSchema,
  prodSchema,
} from "./prod-schema-drift.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CLASSES = new Set(["hand-run", "withdrawn", "half-applied", "parser"]);

describe("the schema the migrations build", () => {
  const schema = migrationSchema();

  it("resolves the real corpus, not an empty one", () => {
    expect(schema.size).toBeGreaterThan(300);
    let columns = 0;
    for (const cols of schema.values()) columns += cols.size;
    expect(columns).toBeGreaterThan(3000);
  });

  it("holds columns a hand check can confirm", () => {
    expect(schema.get("listings")).toContain("id");
    expect(schema.get("listings")).toContain("user_id");
    expect(schema.get("listings")).toContain("listing_status");
  });

  it("does NOT build listings.ebay_drift, which is the whole story", () => {
    expect(schema.get("listings")).not.toContain("ebay_drift");
  });

  it("drops a table a migration dropped", () => {
    // 00638 cleans up after the withdrawn 00636/00637.
    expect(migrationDdlEvents().droppedTables).toContain("lulufanatics_catalog_jobs");
    expect(schema.has("lulufanatics_catalog_jobs")).toBe(false);
  });
});

describe("the ordered replay of column events", () => {
  // Both event kinds are empty across the real corpus, so they are only ever
  // exercised here. An order-insensitive subtraction passes the first case and
  // fails the second, which is the bug this is aimed at.
  const base = {
    createdTables: new Set(["t"]),
    droppedTables: new Set(),
    renamedTables: new Map(),
  };

  it("subtracts a dropped column", () => {
    const s = migrationSchema({
      ...base,
      columnEvents: [
        { table: "t", kind: "add", column: "gone" },
        { table: "t", kind: "add", column: "kept" },
        { table: "t", kind: "remove", column: "gone" },
      ],
    });
    expect([...s.get("t")]).toEqual(["kept"]);
  });

  it("keeps a column dropped and then re-added later", () => {
    const s = migrationSchema({
      ...base,
      columnEvents: [
        { table: "t", kind: "add", column: "c" },
        { table: "t", kind: "remove", column: "c" },
        { table: "t", kind: "add", column: "c" },
      ],
    });
    expect([...s.get("t")]).toEqual(["c"]);
  });

  it("follows a rename to the new name only", () => {
    const s = migrationSchema({
      ...base,
      columnEvents: [
        { table: "t", kind: "add", column: "old" },
        { table: "t", kind: "remove", column: "old" },
        { table: "t", kind: "add", column: "new" },
      ],
    });
    expect([...s.get("t")]).toEqual(["new"]);
  });
});

describe("reading a PostgREST OpenAPI document", () => {
  it("takes columns off definitions", () => {
    const s = prodSchema({ definitions: { t: { properties: { a: {}, b: {} } } } });
    expect([...s.get("t")]).toEqual(["a", "b"]);
  });

  it("refuses a document with no definitions rather than reading it as empty", () => {
    expect(() => prodSchema({})).toThrow(/no `definitions`/);
    expect(() => prodSchema(null)).toThrow(/no `definitions`/);
  });
});

describe("fail-closed", () => {
  const views = new Set();
  const one = new Map([["t", new Set(["id"])]]);

  it("will not call a zero-table read clean", () => {
    expect(() => diffSchemas(one, new Map(), views, MIN_MIGRATION_FILES)).toThrow(/ZERO tables/);
    expect(() => diffSchemas(new Map(), one, views, MIN_MIGRATION_FILES)).toThrow(/ZERO tables/);
  });

  it("will not run against a shrunken migration corpus", () => {
    expect(() => diffSchemas(one, one, views, MIN_MIGRATION_FILES - 1)).toThrow(/floor/);
  });

  it("counts a table it could not parse as unparsed, not as clean", () => {
    const d = diffSchemas(
      new Map([["t", new Set(["id"])], ["mystery", new Set()]]),
      new Map([["t", new Set(["id"])], ["mystery", new Set(["a", "b"])]]),
      views,
      MIN_MIGRATION_FILES,
    );
    expect(d.unparsed).toEqual(["mystery"]);
    expect(d.prodOnlyColumns).toEqual([]);
  });

  it("reports a table revoked from anon as unreadable, never as missing", () => {
    const d = diffSchemas(
      new Map([["visible", new Set(["id"])], ["revoked", new Set(["id"])]]),
      new Map([["visible", new Set(["id"])]]),
      views,
      MIN_MIGRATION_FILES,
    );
    expect(d.unreadable).toEqual(["revoked"]);
    expect(d.migrationOnlyColumns).toEqual([]);
  });
});

describe("the KNOWN list", () => {
  it("classifies every entry with one of the four verdicts and real evidence", () => {
    for (const bucket of ["prodOnlyTables", "prodOnlyColumns", "migrationOnlyColumns"]) {
      for (const [name, entry] of Object.entries(KNOWN[bucket])) {
        expect(CLASSES, `${bucket}.${name}`).toContain(entry.class);
        expect(entry.why.length, `${bucket}.${name} needs evidence`).toBeGreaterThan(60);
      }
    }
  });

  it("can only shrink: an entry that stops matching fails", () => {
    const v = judge(
      { prodOnlyTables: [], prodOnlyColumns: [], migrationOnlyColumns: [] },
      { prodOnlyTables: { settled: { class: "withdrawn", why: "x" } }, prodOnlyColumns: {}, migrationOnlyColumns: {} },
    );
    expect(v.ok).toBe(false);
    expect(v.stale).toEqual([{ bucket: "prodOnlyTables", name: "settled" }]);
  });

  it("names anything it does not cover", () => {
    const v = judge(
      { prodOnlyTables: ["surprise"], prodOnlyColumns: [], migrationOnlyColumns: [] },
      { prodOnlyTables: {}, prodOnlyColumns: {}, migrationOnlyColumns: {} },
    );
    expect(v.ok).toBe(false);
    expect(v.unexplained).toEqual([{ bucket: "prodOnlyTables", name: "surprise" }]);
  });
});

describe("the script itself", () => {
  it("passes its own --self-test", () => {
    const r = spawnSync(process.execPath, [resolve(ROOT, "scripts/prod-schema-drift.mjs"), "--self-test"], {
      encoding: "utf8",
    });
    expect(r.stdout + r.stderr).toContain("self-test ok");
    expect(r.status).toBe(0);
  });

  it("refuses --openapi with no path rather than falling through to a live read", () => {
    const r = spawnSync(process.execPath, [resolve(ROOT, "scripts/prod-schema-drift.mjs"), "--openapi"], {
      encoding: "utf8",
    });
    expect(r.status).toBe(2);
  });
});

describe("both lanes still run it", () => {
  it("is wired into scripts/verify.mjs", () => {
    expect(readFileSync(resolve(ROOT, "scripts/verify.mjs"), "utf8")).toContain(
      "prod-schema-drift.mjs --self-test",
    );
  });

  it("is wired into .github/workflows/ci.yml", () => {
    expect(readFileSync(resolve(ROOT, ".github/workflows/ci.yml"), "utf8")).toContain(
      "prod-schema-drift.mjs --self-test",
    );
  });
});
