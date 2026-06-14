// Schema-version assertion at edge boot (US-778).
//
// A deploy that ships edge code expecting migration NNNNN against a DB still at
// NNNNN-k will fail in subtle, data-corrupting ways (a handler writes a column
// that doesn't exist yet, or reads one that's null because the backfill hasn't
// run). This asserts, at boot, that the DB is at least at the version this build
// expects:
//   • CONFIRMED BEHIND in production → log expected-vs-actual + exit non-zero so
//     Coolify's restart loop makes the failure loud and the deploy visibly fails.
//   • BEHIND in dev → warn only (local DBs lag during development).
//   • UNKNOWN (migrations table unreadable / not recorded) → warn + proceed
//     (fail-OPEN on a read gap; only a CONFIRMED mismatch is fatal).
//   • AHEAD (DB newer than this build expects) → warn; a newer DB generally still
//     serves an older edge, and blocking it would break a rolling deploy.
//
// EXPECTED_SCHEMA_VERSION MUST equal the highest migration file's NNNNN prefix.
// A CI sync-check (schema-version_test.ts) fails the build if they drift.

import { supabaseAdmin } from "./supabase.ts";
import { edgeEnv } from "./env.ts";

// Bump this in the SAME commit that adds a migration. = highest NNNNN in
// supabase/migrations/. (00229_funnel_retention_analytics.sql)
export const EXPECTED_SCHEMA_VERSION = "00229";

export type SchemaVersionComparison = "match" | "behind" | "ahead" | "unknown";

// Extract the leading numeric run from a version token ("00126_foo" → 126).
function versionNumber(v: string | null | undefined): number | null {
  if (!v) return null;
  const m = String(v).match(/^\d+/);
  if (!m) return null;
  const n = Number.parseInt(m[0], 10);
  return Number.isFinite(n) ? n : null;
}

// Pure comparison (unit-tested). `latest` is the DB's highest applied version.
export function compareSchemaVersion(
  expected: string,
  latest: string | null,
): SchemaVersionComparison {
  const e = versionNumber(expected);
  const a = versionNumber(latest);
  if (e === null || a === null) return "unknown";
  if (a === e) return "match";
  return a < e ? "behind" : "ahead";
}

export interface SchemaVersionDeps {
  getLatest: () => Promise<string | null>;
  env: string;
  // Called on a fatal (confirmed-behind in prod) instead of Deno.exit directly,
  // so the assertion is testable.
  onFatal: (message: string) => void;
}

const defaultDeps: SchemaVersionDeps = {
  getLatest: async () => {
    const { data, error } = await supabaseAdmin.rpc("latest_schema_migration");
    if (error) {
      console.warn(`[schema-version] could not read migrations table: ${error.message}`);
      return null;
    }
    return typeof data === "string" ? data : null;
  },
  env: edgeEnv(),
  onFatal: (message) => {
    console.error(message);
    Deno.exit(1);
  },
};

// Assert the DB schema is current. Returns the comparison result (for logging/
// tests); triggers onFatal only on a confirmed behind-version in production.
export async function assertSchemaVersion(
  deps: Partial<SchemaVersionDeps> = {},
): Promise<SchemaVersionComparison> {
  const d = { ...defaultDeps, ...deps };
  let latest: string | null;
  try {
    latest = await d.getLatest();
  } catch (err) {
    console.warn(
      `[schema-version] read failed, proceeding (fail-open): ${err instanceof Error ? err.message : String(err)}`,
    );
    return "unknown";
  }

  const cmp = compareSchemaVersion(EXPECTED_SCHEMA_VERSION, latest);
  switch (cmp) {
    case "match":
      console.log(`[schema-version] OK — DB at ${latest} matches expected ${EXPECTED_SCHEMA_VERSION}`);
      return "match";
    case "ahead":
      console.warn(
        `[schema-version] DB (${latest}) is AHEAD of this build's expected ${EXPECTED_SCHEMA_VERSION} — proceeding`,
      );
      return "ahead";
    case "unknown":
      console.warn(
        `[schema-version] could not determine DB version (got ${JSON.stringify(latest)}) — ` +
          `proceeding (fail-open). Ensure prod records supabase_migrations.schema_migrations.`,
      );
      return "unknown";
    case "behind": {
      const message =
        `[schema-version] DB is STALE: applied=${latest}, this build expects ${EXPECTED_SCHEMA_VERSION}. ` +
        `Apply pending migrations before deploying this edge build.`;
      if (d.env === "production") {
        d.onFatal(`${message} Refusing to start.`);
      } else {
        console.warn(`${message} (non-production: proceeding)`);
      }
      return "behind";
    }
  }
}
