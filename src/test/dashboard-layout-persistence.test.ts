import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

// US-3073 AC1 + AC4: the persistence contract, checked at the source.
//
// The hook itself needs a React renderer this repo deliberately does not carry
// (see the coverage note in vitest.config.ts), so the three properties that
// would silently rot are pinned here instead: the mirror key, the tolerant
// read, and the fact that no edge route touches this table.

const HOOK = readFileSync("src/hooks/use-dashboard-layout.ts", "utf8");
const MIGRATION = readFileSync(
  "supabase/migrations/00722_dashboard_layouts.sql",
  "utf8",
);

describe("dashboard layout persistence", () => {
  it("mirrors the layout under gt:dashboard-layout:<surface>", () => {
    expect(HOOK).toContain('const MIRROR_PREFIX = "gt:dashboard-layout:"');
    expect(HOOK).toContain("`${MIRROR_PREFIX}${surface}`");
  });

  it("normalizes the mirrored copy instead of trusting it", () => {
    expect(HOOK).toMatch(/readMirrorDocument\(surface\);\s*\n\s*if \(mirrored\) return normalize\(/);
  });

  it("resolves a read error to a layout rather than an error state", () => {
    expect(HOOK).toContain(
      "if (error) return fallbackLayout(surface, registry, persona, {});",
    );
    // The one place that rethrows is the SAVE, which must fail loudly. It has
    // to sit after mutationFn, i.e. below the read.
    const thrown = HOOK.indexOf("if (error) throw error;");
    expect(thrown).toBeGreaterThan(HOOK.indexOf("mutationFn:"));
    expect(HOOK.indexOf("if (error) throw error;", thrown + 1)).toBe(-1);
  });

  it("reads and writes through supabase-js under RLS, with no edge route", () => {
    expect(HOOK).toContain('from(TABLE)');
    const edgeHits = filesContaining("services/edge-functions/src", "dashboard_layouts");
    expect(edgeHits, `edge code must not touch dashboard_layouts: ${edgeHits.join(", ")}`)
      .toEqual([]);
  });

  it("keys the table by (user_id, surface) and checks the surface", () => {
    expect(MIGRATION).toContain("PRIMARY KEY (user_id, surface)");
    expect(MIGRATION).toContain("CHECK (surface IN ('grading', 'flipdesk', 'ios-home'))");
  });

  it("gives the table owner-only RLS on all four verbs", () => {
    expect(MIGRATION).toContain("ENABLE ROW LEVEL SECURITY");
    for (const verb of ["SELECT", "INSERT", "UPDATE", "DELETE"]) {
      expect(MIGRATION, `missing a ${verb} policy`).toContain(`FOR ${verb}`);
    }
    const clauses = MIGRATION.match(/\(select auth\.uid\(\)\) = user_id/g) ?? [];
    // select + insert + update (using and with check) + delete
    expect(clauses.length).toBe(5);
  });

  it("records its own version, per the US-1108 triple", () => {
    expect(MIGRATION.trimEnd().endsWith(
      "insert into public.applied_migrations (version) values ('00722') on conflict do nothing;",
    )).toBe(true);
  });
});

function filesContaining(root: string, needle: string): string[] {
  const hits: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) {
        walk(path);
        continue;
      }
      if (!/\.ts$/.test(entry)) continue;
      if (readFileSync(path, "utf8").includes(needle)) hits.push(path);
    }
  };
  walk(root);
  return hits;
}
