// US-3113: decision functions for applying migrations to the self-hosted prod
// Postgres over ssh.
//
// Nothing about the target lives in this file. The host comes from the
// environment; the container is discovered by asking each Supabase stack on the
// host whether it carries our marker tables. `scripts/migrate-prod.test.mjs`
// fails if an IP or a container id ever appears here.
//
// The one behavioural difference from `apply-prod-migrations.sh`: pending is
// computed by MEMBERSHIP in `applied_migrations`, not by comparing against the
// highest recorded version. The shell script skips everything at or below the
// maximum, so a gap below it is never re-applied — that is how
// `listings.draft_id` from 00134 stayed missing in prod for months
// (US-2726, US-2832).

import { parseEnv } from "node:util";

export class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = "ConfigError";
  }
}

const DEFAULT_MARKER_TABLES = "grade_reports,applied_migrations";
const DEFAULT_CONTAINER_FILTER = "supabase-db-";

// ---------------------------------------------------------------------------
// config
// ---------------------------------------------------------------------------

// Layers a .env file UNDER the real environment, so an explicitly exported
// variable still wins and a stray unparseable line cannot take the tool down.
// An empty or whitespace-only variable counts as unset.
export function mergeEnvFile(env, fileText) {
  if (!fileText || !String(fileText).trim()) return { ...env };
  let parsed = {};
  try {
    parsed = parseEnv(String(fileText));
  } catch {
    return { ...env };
  }
  const merged = { ...env };
  for (const [key, value] of Object.entries(parsed)) {
    if (!String(merged[key] ?? "").trim()) merged[key] = value;
  }
  return merged;
}

export function readConfig(env = {}) {
  const host = (env.PROD_SSH_HOST ?? "").trim();
  if (!host) {
    throw new ConfigError(
      "PROD_SSH_HOST is not set. Set it to the ssh target for the database host " +
        '(an alias from ~/.ssh/config, or "user@host"). Nothing is assumed.',
    );
  }

  const markerTables = (env.PROD_DB_MARKER_TABLES ?? DEFAULT_MARKER_TABLES)
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);

  if (markerTables.length === 0) {
    throw new ConfigError("PROD_DB_MARKER_TABLES is set but empty; discovery needs at least one table.");
  }

  return {
    host,
    container: (env.PROD_DB_CONTAINER ?? "").trim() || null,
    user: (env.PROD_DB_USER ?? "").trim() || "postgres",
    database: (env.PROD_DB_NAME ?? "").trim() || "postgres",
    markerTables,
    containerFilter: (env.PROD_DB_CONTAINER_FILTER ?? "").trim() || DEFAULT_CONTAINER_FILTER,
    backupDir: (env.PROD_BACKUP_DIR ?? "").trim() || "~/gradethread-db-backups",
  };
}

// ---------------------------------------------------------------------------
// quoting
// ---------------------------------------------------------------------------

// For the REMOTE shell. ssh hands the command to `sh -c`, so the whole thing is
// re-parsed on the far side and every argument needs its own quoting.
export function shQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

// For a SQL string literal.
function sqlQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

// ---------------------------------------------------------------------------
// commands
// ---------------------------------------------------------------------------

export function psqlCommand(config, { query, stdin } = {}) {
  const base = `docker exec${stdin ? " -i" : ""} ${shQuote(config.container)} psql -U ${config.user} -d ${config.database}`;
  if (stdin) return `${base} -v ON_ERROR_STOP=1 -f -`;
  return `${base} -tAX -c ${shQuote(query)}`;
}

export function containerProbeSql(markerTables) {
  const list = markerTables.map(sqlQuote).join(", ");
  return (
    "select count(*) from information_schema.tables " +
    `where table_schema = 'public' and table_name in (${list});`
  );
}

export function listContainersCommand(config) {
  return `docker ps --format '{{.Names}}' | grep ${shQuote(config.containerFilter)} || true`;
}

export function parseRows(stdout) {
  return String(stdout ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

// ---------------------------------------------------------------------------
// discovery
// ---------------------------------------------------------------------------

export function pickContainer(matches, { searched } = {}) {
  if (matches.length === 1) return matches[0];
  if (matches.length === 0) {
    throw new ConfigError(
      `No database container on the host carries all the marker tables (checked ${searched} container(s)). ` +
        "Set PROD_DB_CONTAINER to name it directly, or adjust PROD_DB_MARKER_TABLES.",
    );
  }
  throw new ConfigError(
    `More than one container carries the marker tables: ${matches.join(", ")}. ` +
      "Set PROD_DB_CONTAINER to pick one.",
  );
}

// ---------------------------------------------------------------------------
// which version a migration file records
// ---------------------------------------------------------------------------

const FOOTER =
  /insert\s+into\s+(?:public\.)?applied_migrations\s*\(\s*version\s*\)\s*values\s*\(\s*'([^']+)'\s*\)/gi;

// Prod records five digits. Three files (000355, 000375, 000385) are NAMED with
// six, and a plain string compare treats those as different migrations, which
// makes them look forever pending. Compare on this, not on the raw prefix.
export function canonicalVersion(version) {
  const raw = String(version ?? "").trim();
  if (!/^\d+$/.test(raw)) return raw;
  return raw.length > 5 && Number(raw) > 99999 ? raw : String(Number(raw)).padStart(5, "0");
}

// The filename prefix is authoritative, not the footer. 00254 is the backfill
// seed and carries an insert for every earlier version, so reading the last
// footer would make it report itself as some other migration entirely.
export function recordedVersion(sql, filename) {
  const prefix = (filename.match(/^(\d+)_/) ?? [])[1];
  if (prefix) return canonicalVersion(prefix);

  FOOTER.lastIndex = 0;
  let last = null;
  for (const match of String(sql ?? "").matchAll(FOOTER)) last = match[1].trim();
  return last ? canonicalVersion(last) : filename;
}

// ---------------------------------------------------------------------------
// pending
// ---------------------------------------------------------------------------

export function computePending({ local, applied }) {
  // Both sides are canonicalized before comparing, so a six-digit filename and
  // the five-digit version prod recorded for it are the same migration. The
  // `unknown` list still reports prod's own spelling.
  const appliedSet = new Set(applied.map(canonicalVersion));
  const localSet = new Set(local.map((m) => canonicalVersion(m.version)));
  return {
    pending: local.filter((m) => !appliedSet.has(canonicalVersion(m.version))),
    unknown: applied.filter((v) => !localSet.has(canonicalVersion(v))),
  };
}

// ---------------------------------------------------------------------------
// the flag gate
// ---------------------------------------------------------------------------

// Applying needs BOTH --apply and --yes. One flag is easy to leave in a shell
// history and re-run by accident; two is a decision.
export function decideAction({ pendingCount = 0, apply = false, confirmed = false, check = false } = {}) {
  if (pendingCount === 0) return { action: "none", exitCode: 0 };
  if (!apply) return { action: "dry", exitCode: check ? 1 : 0 };
  if (!confirmed) return { action: "refuse", exitCode: 1 };
  return { action: "apply", exitCode: 0 };
}

// ---------------------------------------------------------------------------
// apply
// ---------------------------------------------------------------------------

// `exec` is injected so the sequencing is testable without a database:
//   backup()             -> resolves to the remote dump path
//   applyFile(migration) -> resolves on success, throws on failure
//   reloadSchema()       -> tells PostgREST to re-read the schema
export async function applyPending({ pending, exec, backup = true, log = () => {} }) {
  if (pending.length === 0) {
    return { ok: true, backupPath: null, results: [], reloaded: false };
  }

  let backupPath = null;
  if (backup) {
    try {
      backupPath = await exec.backup();
      log(`backup: ${backupPath}`);
    } catch (error) {
      return { ok: false, backupPath: null, results: [], reloaded: false, error: String(error.message ?? error) };
    }
  }

  const results = [];
  for (const migration of pending) {
    try {
      await exec.applyFile(migration);
      results.push({ version: migration.version, file: migration.file, ok: true });
      log(`applied ${migration.file}`);
    } catch (error) {
      results.push({
        version: migration.version,
        file: migration.file,
        ok: false,
        error: String(error.message ?? error),
      });
      return { ok: false, backupPath, results, reloaded: false };
    }
  }

  await exec.reloadSchema();
  return { ok: true, backupPath, results, reloaded: true };
}
