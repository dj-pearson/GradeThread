#!/usr/bin/env node
// US-3113: apply pending migrations to the self-hosted prod Postgres over ssh,
// and say immediately what happened. Replaces the copy-paste-into-Studio loop.
//
//   PROD_SSH_HOST=<alias|user@host> node scripts/migrate-prod.mjs            # dry run
//   PROD_SSH_HOST=<alias|user@host> node scripts/migrate-prod.mjs --apply --yes
//
// Nothing about the target is baked in. The host comes from PROD_SSH_HOST; the
// container is discovered by asking each Supabase stack on that host whether it
// carries our marker tables. See scripts/lib/prod-db.mjs.
//
// Reads pending by MEMBERSHIP in applied_migrations, not by highest version, so
// a gap below the maximum is caught rather than skipped.

import { execFile } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ConfigError,
  applyPending,
  computePending,
  containerProbeSql,
  decideAction,
  listContainersCommand,
  mergeEnvFile,
  parseRows,
  pickContainer,
  psqlCommand,
  readConfig,
  recordedVersion,
  shQuote,
} from "./lib/prod-db.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MIGRATIONS_DIR = join(REPO_ROOT, "supabase", "migrations");
const ENV_FILE = join(REPO_ROOT, ".env");
const SSH_OPTIONS = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=15"];

const USAGE = `apply pending migrations to prod over ssh

  node scripts/migrate-prod.mjs                 show what is pending (default, read-only)
  node scripts/migrate-prod.mjs --check         same, but exit 1 if anything is pending
  node scripts/migrate-prod.mjs --apply --yes   take a backup, then apply in order
  node scripts/migrate-prod.mjs --apply --yes --no-backup

environment (read from the shell, or from the repo-root .env; the shell wins)
  PROD_SSH_HOST             required. ssh target for the database host.
  PROD_DB_CONTAINER         skip discovery and name the container directly.
  PROD_DB_USER              default postgres
  PROD_DB_NAME              default postgres
  PROD_DB_MARKER_TABLES     default grade_reports,applied_migrations
  PROD_DB_CONTAINER_FILTER  default supabase-db-
  PROD_BACKUP_DIR           default ~/gradethread-db-backups
`;

// ---------------------------------------------------------------------------
// ssh transport
// ---------------------------------------------------------------------------

function ssh(host, command, { input } = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = execFile(
      "ssh",
      [...SSH_OPTIONS, host, command],
      { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          const detail = (stderr || stdout || error.message).trim();
          rejectPromise(new Error(detail));
          return;
        }
        resolvePromise({ stdout, stderr });
      },
    );
    child.stdin.end(input ?? "");
  });
}

// ---------------------------------------------------------------------------
// reads
// ---------------------------------------------------------------------------

function readEnvFile() {
  try {
    return readFileSync(ENV_FILE, "utf8");
  } catch {
    return "";
  }
}

export function readLocalMigrations(dir = MIGRATIONS_DIR) {
  return readdirSync(dir)
    .filter((name) => name.endsWith(".sql"))
    .sort()
    .map((file) => {
      const path = join(dir, file);
      return { version: recordedVersion(readFileSync(path, "utf8"), file), file, path };
    });
}

async function fetchApplied(config) {
  try {
    const { stdout } = await ssh(
      config.host,
      psqlCommand(config, { query: "select version from public.applied_migrations order by 1;" }),
    );
    return parseRows(stdout);
  } catch (error) {
    // A database that has never had 00254 applied has no tracker table yet.
    if (/applied_migrations.*does not exist|relation .* does not exist/i.test(error.message)) return [];
    throw error;
  }
}

async function discoverContainer(config) {
  const { stdout } = await ssh(config.host, listContainersCommand(config));
  const candidates = parseRows(stdout);
  const probe = containerProbeSql(config.markerTables);
  const matches = [];
  for (const container of candidates) {
    try {
      const { stdout: count } = await ssh(config.host, psqlCommand({ ...config, container }, { query: probe }));
      if (Number(parseRows(count)[0]) === config.markerTables.length) matches.push(container);
    } catch {
      // A stack that refuses the query is simply not ours.
    }
  }
  return pickContainer(matches, { searched: candidates.length });
}

// ---------------------------------------------------------------------------
// writes
// ---------------------------------------------------------------------------

function makeExec(config, highestPending) {
  return {
    async backup() {
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const dir = config.backupDir;
      const path = `${dir}/pre-${highestPending}-${stamp}.dump`;
      const command =
        `mkdir -p ${shQuote(dir)} && ` +
        `docker exec ${shQuote(config.container)} pg_dump -U ${config.user} -Fc ${config.database} > ${shQuote(path)} && ` +
        `test "$(stat -c%s ${shQuote(path)})" -gt 1000 && echo ${shQuote(path)}`;
      const { stdout } = await ssh(config.host, command);
      const written = parseRows(stdout).pop();
      if (!written) throw new Error("backup produced no file");
      return written;
    },

    async applyFile(migration) {
      await ssh(config.host, psqlCommand(config, { stdin: true }), {
        input: readFileSync(migration.path, "utf8"),
      });
    },

    async reloadSchema() {
      await ssh(config.host, psqlCommand(config, { query: "NOTIFY pgrst, 'reload schema';" }));
    },
  };
}

// ---------------------------------------------------------------------------
// cli
// ---------------------------------------------------------------------------

async function main(argv) {
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(USAGE);
    return 0;
  }

  const apply = argv.includes("--apply");
  const confirmed = argv.includes("--yes");
  const backup = !argv.includes("--no-backup");
  const check = argv.includes("--check");

  // The repo-root .env is layered UNDER the real environment, so an exported
  // variable still wins. Only the PROD_* keys are ever read out of it.
  const config = readConfig(mergeEnvFile(process.env, readEnvFile()));
  if (!config.container) {
    process.stdout.write(`discovering the database container on ${config.host}...\n`);
    config.container = await discoverContainer(config);
  }
  process.stdout.write(`host      ${config.host}\ncontainer ${config.container}\n`);

  const local = readLocalMigrations();
  const applied = await fetchApplied(config);
  const { pending, unknown } = computePending({ local, applied });

  process.stdout.write(`local     ${local.length} migration file(s)\n`);
  process.stdout.write(`recorded  ${applied.length} version(s) on prod\n`);

  if (unknown.length > 0) {
    process.stdout.write(
      `\nrecorded on prod with no local file (${unknown.length}): ${unknown.join(", ")}\n` +
        "  These are not applied by this tool. They are usually renamed or squashed files.\n",
    );
  }

  const decision = decideAction({ pendingCount: pending.length, apply, confirmed, check });

  if (decision.action === "none") {
    process.stdout.write(
      "\nnothing pending. prod records every local migration.\n" +
        "Note: that is what prod RECORDS, not proof each one took effect. A file applied\n" +
        "without ON_ERROR_STOP can record its version after failing (00611 did, 2026-08-17).\n" +
        "Run scripts/prod-schema-audit.sql to ask whether the objects are actually there.\n",
    );
    return decision.exitCode;
  }

  process.stdout.write(`\npending (${pending.length}), in apply order:\n`);
  for (const migration of pending) process.stdout.write(`  ${migration.version}  ${migration.file}\n`);

  if (decision.action === "dry") {
    process.stdout.write("\ndry run. add --apply --yes to apply these.\n");
    return decision.exitCode;
  }

  if (decision.action === "refuse") {
    process.stdout.write("\n--apply needs --yes as well. Nothing was changed.\n");
    return decision.exitCode;
  }

  process.stdout.write(backup ? "\ntaking a backup first...\n" : "\nskipping backup (--no-backup)\n");

  const result = await applyPending({
    pending,
    backup,
    exec: makeExec(config, pending[pending.length - 1].version),
    log: (line) => process.stdout.write(`  ${line}\n`),
  });

  if (!result.ok) {
    const failed = result.results.find((r) => !r.ok);
    process.stdout.write("\nFAILED. Stopped before applying the rest.\n");
    if (result.backupPath) process.stdout.write(`backup: ${result.backupPath}\n`);
    if (failed) process.stdout.write(`\n${failed.file} failed:\n${failed.error}\n`);
    else if (result.error) process.stdout.write(`\n${result.error}\n`);
    const done = result.results.filter((r) => r.ok).length;
    process.stdout.write(`\napplied ${done} of ${pending.length} before stopping.\n`);
    return 1;
  }

  process.stdout.write(`\nOK. applied ${result.results.length} migration(s), schema reload sent.\n`);
  process.stdout.write("Redeploy the edge on Coolify next; its boot guard expects the new version.\n");
  return 0;
}

const invokedDirectly = process.argv[1] && basename(process.argv[1]) === "migrate-prod.mjs";

if (invokedDirectly) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((error) => {
      const isConfig = error instanceof ConfigError;
      process.stderr.write(`\n${isConfig ? "config" : "error"}: ${error.message}\n`);
      process.exit(isConfig ? 2 : 1);
    });
}
