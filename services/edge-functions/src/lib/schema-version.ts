// Schema-version assertion at edge boot (US-778).
//
// A deploy that ships edge code expecting migration NNNNN against a DB still at
// NNNNN-k will fail in subtle, data-corrupting ways (a handler writes a column
// that doesn't exist yet, or reads one that's null because the backfill hasn't
// run). This asserts, at boot, that the DB is at least at the version this build
// expects:
//   • CONFIRMED BEHIND in production → re-check across a short GRACE WINDOW (see
//     below); if STILL behind after it, log expected-vs-actual + exit non-zero so
//     Coolify's restart loop makes the failure loud and the deploy visibly fails.
//   • BEHIND in dev → warn only (local DBs lag during development).
//   • UNKNOWN (migrations table unreadable / not recorded) → warn + proceed
//     (fail-OPEN on a read gap; only a CONFIRMED mismatch is fatal).
//   • AHEAD (DB newer than this build expects) → warn; a newer DB generally still
//     serves an older edge, and blocking it would break a rolling deploy.
//
// GRACE WINDOW (B — blast-radius reduction): the bump to EXPECTED_SCHEMA_VERSION
// ships in the edge image, but prod migrations apply as a SEPARATE step (the
// Coolify pre-deploy command / apply-prod-migrations.sh). If the edge container
// boots a few seconds before that step records the new version, an instant exit
// would crash-loop the WHOLE service (Traefik "no available server" 503 on every
// route) until a human intervenes. Instead, on a confirmed behind-version in
// production we re-poll the migrations table a handful of times before giving up,
// turning that race into a brief delayed start. A genuinely-forgotten migration
// still ends in the same loud fatal — just after the window, not before it.
// Tunable without a redeploy via SCHEMA_GUARD_GRACE_ATTEMPTS / _DELAY_MS.
//
// The durable fix for the ordering itself is to apply migrations BEFORE the edge
// rolls (A — Coolify pre-deployment command, see COOLIFY.md); the grace window is
// the safety net for the residual race / a missed step.
//
// EXPECTED_SCHEMA_VERSION MUST equal the highest migration file's NNNNN prefix.
// A CI sync-check (schema-version_test.ts) fails the build if they drift.

import { supabaseAdmin } from "./supabase.ts";
import { edgeEnv } from "./env.ts";

// Bump this in the SAME commit that adds a migration. = highest NNNNN in
// supabase/migrations/. (00388_content_safety_flagged_status.sql)
export const EXPECTED_SCHEMA_VERSION = "00426";

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
  // Called on a fatal (confirmed-behind in prod, AFTER the grace window) instead
  // of Deno.exit directly, so the assertion is testable.
  onFatal: (message: string) => void;
  // Grace window (B): on a confirmed behind-version in production, re-poll the DB
  // up to `graceAttempts` times, sleeping `graceDelayMs` between tries, before
  // declaring it fatal. Defaults give ~40s — long enough to absorb the
  // deploy/migrate race, short enough to fit inside the healthcheck start window.
  // 0 attempts → original instant-fatal behavior (used by tests).
  graceAttempts: number;
  graceDelayMs: number;
  sleep: (ms: number) => Promise<void>;
}

// Parse a non-negative integer env override; fall back to `dflt` on unset/garbage.
function envInt(name: string, dflt: number): number {
  const raw = Deno.env.get(name);
  if (!raw) return dflt;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : dflt;
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
  graceAttempts: envInt("SCHEMA_GUARD_GRACE_ATTEMPTS", 8),
  graceDelayMs: envInt("SCHEMA_GUARD_GRACE_DELAY_MS", 5000),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
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

  let cmp = compareSchemaVersion(EXPECTED_SCHEMA_VERSION, latest);

  // Grace window (B): a confirmed behind-version in production may just be the
  // deploy/migrate race — the migration lands seconds after the edge boots. Give
  // it a chance to land before crash-looping the whole service. Outside
  // production, or for any non-"behind" result, this loop never runs.
  if (cmp === "behind" && d.env === "production" && d.graceAttempts > 0) {
    for (let attempt = 1; attempt <= d.graceAttempts; attempt++) {
      console.warn(
        `[schema-version] DB behind (applied=${latest}, expected ${EXPECTED_SCHEMA_VERSION}); ` +
          `waiting ${d.graceDelayMs}ms for pending migration — attempt ${attempt}/${d.graceAttempts}`,
      );
      await d.sleep(d.graceDelayMs);
      try {
        latest = await d.getLatest();
      } catch (err) {
        // A transient read error inside the window is not, by itself, fatal —
        // fall through and let the next poll (or the final compare) decide.
        console.warn(
          `[schema-version] grace re-poll failed: ${err instanceof Error ? err.message : String(err)}`,
        );
        continue;
      }
      cmp = compareSchemaVersion(EXPECTED_SCHEMA_VERSION, latest);
      if (cmp !== "behind") {
        console.log(`[schema-version] recovered during grace window — DB now at ${latest}`);
        break;
      }
    }
  }

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
        d.onFatal(`${message} Refusing to start (after grace window).`);
      } else {
        console.warn(`${message} (non-production: proceeding)`);
      }
      return "behind";
    }
  }
}
