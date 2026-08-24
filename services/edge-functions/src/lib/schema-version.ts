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
import { edgeEnv, isProductionEnv } from "./env.ts";
import { EXPECTED_MIGRATIONS, FOOTER_ERA_START } from "./migration-manifest.ts";

// Bump this in the SAME commit that adds a migration. = highest NNNNN in
// supabase/migrations/. (00634_listings_listed_at_nullable.sql)
//
// ⚠ 00527 IS SKIPPED HERE ON PURPOSE. 00527_revoke_public_function_execute.sql
// carries a .BLOCKED suffix (US-2403: denying a function to a supautils hint
// role segfaults Postgres), so it is invisible to the *.sql glob the manifest
// and the apply script use. Its number stays reserved for when it unblocks.
//
// ⚠ 00636 AND 00637 ARE SKIPPED, and are NOT phantoms. They created a
// lulufanatics.com crawler and were applied to production before their files
// were deleted. 00638 drops what they built AND removes their applied_migrations
// rows, so the applied set matches the shipped set exactly and the phantom list
// below does not have to grow. Numbering continues at 00639: the numbers are
// safe to reuse once the rows are gone, and reusing them would still be
// confusing to anyone reading the history.
//
// ⚠ 00479 IS DELIBERATELY SKIPPED. On 2026-07-19 /health/ready reported
// applied="00479" while no 00479 file has ever existed in this repo (no file, no
// git history, no branch). Reusing that number would let the boot guard read
// "match" off prod's pre-existing row even if this migration never applied —
// exactly the failure the guard exists to catch. See PENDING_MIGRATIONS.md.
export const EXPECTED_SCHEMA_VERSION = "00666";

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
  if (cmp === "behind" && isProductionEnv(d.env) && d.graceAttempts > 0) {
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
      if (isProductionEnv(d.env)) {
        d.onFatal(`${message} Refusing to start (after grace window).`);
      } else {
        console.warn(`${message} (non-production: proceeding)`);
      }
      return "behind";
    }
  }
}

// ── US-2009: completeness, not just a watermark ─────────────────────
//
// Everything above compares ONE NUMBER. That proves the head landed and proves
// nothing beneath it: apply-prod-migrations.sh skips any file whose prefix is
// <= current, and the watermark only moves forward, so a migration that failed
// or was skipped in the MIDDLE of the range is never re-applied and never seen
// again. This has already happened once in this repo's history.
//
// So: compare the whole SET. Two distinct findings fall out, and they mean
// opposite things.

export interface SchemaCompleteness {
  /** In the manifest, absent from applied_migrations — a real gap. */
  missing: string[];
  /** Applied, but no such migration file exists in this build — a phantom. */
  unexpected: string[];
  /** False when the applied set could not be read (never treat as "clean"). */
  checked: boolean;
}

/**
 * Compare the shipped manifest against what the DB says it has applied.
 *
 * Pure, so both directions are unit-testable. Only versions at or above
 * FOOTER_ERA_START participate: below that the self-recording footer did not
 * exist, so absence is expected and carries no signal.
 */
/**
 * Versions production is KNOWN to record with no file behind them.
 *
 * US-2606: the first read from the live database returned
 * `unexpected: ["00479"]`, and 00479 is not a discovery — it is documented in
 * two places (`scripts/prod-diagnostics.sql` §2, `scripts/migrations-lint.mjs`
 * `KNOWN_GAPS`) as never authored, and it is the reason 00480 onward were
 * numbered around it rather than reusing the number. Reporting it forever would
 * put a permanent entry in a field whose only job is to be empty, and a field
 * that is never empty is a field nobody reads.
 *
 * DELIBERATELY NOT DERIVED FROM `KNOWN_GAPS`, which would look tidier and be
 * wrong. That list is about holes in the FILE sequence, and it also contains
 * 00527 — the security migration parked as `.BLOCKED` behind US-2403. If 00527
 * ever shows up as applied, that is precisely the thing this field should
 * scream about. Excluding "all known gaps" would silence it. So: one entry,
 * named, with its reason, and a test asserting 00527 is not in here.
 */
export const KNOWN_PHANTOM_VERSIONS: readonly string[] = ["00479"];

export function compareSchemaSets(
  expected: readonly string[],
  applied: readonly string[],
  footerEraStart: string,
  knownPhantoms: readonly string[] = KNOWN_PHANTOM_VERSIONS,
): Omit<SchemaCompleteness, "checked"> {
  const appliedSet = new Set(applied);
  const expectedSet = new Set(expected);
  const phantomSet = new Set(knownPhantoms);
  return {
    missing: expected.filter((v) => !appliedSet.has(v)).sort(),
    // Only flag phantoms inside the footer era. An older recorded version is
    // just history the manifest deliberately does not cover.
    unexpected: applied
      .filter((v) => v >= footerEraStart && !expectedSet.has(v) && !phantomSet.has(v))
      .sort(),
  };
}

/**
 * Read every recorded version and report gaps and phantoms.
 *
 * DELIBERATELY NOT FATAL, unlike the behind-max check. This is a brand-new
 * assertion over ~231 historical migrations that has never run against prod: if
 * any one of them failed to self-record years ago, making it fatal would refuse
 * to boot the whole service on the first deploy that includes this code —
 * converting an unknown into an outage. It logs at ERROR and surfaces on
 * /health/ready instead.
 *
 * PROMOTE IT TO FATAL once prod has been observed clean. That is a deliberate
 * follow-up, recorded in US-2009, not an oversight.
 *
 * "Surfaces on /health/ready" became true in US-2603 — this docstring asserted
 * it for a while before the endpoint actually read the result, so the only
 * consumer was a container log. `routes/health.ts` → `cachedSchemaCompleteness`
 * now publishes it as `schema.missing` / `schema.unexpected` / `complete`.
 *
 * Fails CLOSED on a read error in the sense that matters: `checked:false` means
 * "we do not know", which must never be rendered as "clean".
 */
export async function checkSchemaCompleteness(
  deps: {
    expected?: readonly string[];
    footerEraStart?: string;
    getApplied?: () => Promise<string[] | null>;
  } = {},
): Promise<SchemaCompleteness> {
  const expected = deps.expected ?? EXPECTED_MIGRATIONS;
  const footerEraStart = deps.footerEraStart ?? FOOTER_ERA_START;
  const getApplied = deps.getApplied ?? (async () => {
    const { data, error } = await supabaseAdmin
      .from("applied_migrations")
      .select("version");
    if (error) {
      console.warn(`[schema-version] completeness read failed: ${error.message}`);
      return null;
    }
    return ((data ?? []) as Array<{ version: string }>).map((r) => r.version);
  });

  let applied: string[] | null;
  try {
    applied = await getApplied();
  } catch (err) {
    console.warn(
      `[schema-version] completeness read threw: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    applied = null;
  }
  if (applied === null) return { missing: [], unexpected: [], checked: false };

  const { missing, unexpected } = compareSchemaSets(expected, applied, footerEraStart);

  if (missing.length > 0) {
    console.error(
      `[schema-version] ${missing.length} MIGRATION(S) NEVER APPLIED: ${
        missing.join(", ")
      } — the max-version check cannot see these because the watermark is past them.`,
    );
  }
  if (unexpected.length > 0) {
    console.error(
      `[schema-version] ${unexpected.length} version(s) recorded in applied_migrations with NO migration file in this build: ${
        unexpected.join(", ")
      } — either the file was never committed, or a row was inserted by hand. ` +
        `Reusing one of these numbers would satisfy the boot guard off a stale row.`,
    );
  }
  return { missing, unexpected, checked: true };
}
