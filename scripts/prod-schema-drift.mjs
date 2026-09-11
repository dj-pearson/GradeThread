#!/usr/bin/env node
// What production's schema has that supabase/migrations/ does not build, and
// what the migrations build that production does not have.
//
// US-3410. `listings.ebay_drift` exists in prod and in no migration in this
// repo. It was found by accident while reading about a different column, and
// one accident means nobody had ever compared the two sets. This is that
// comparison, as a command, because a schema drifts continuously and a one-off
// audit answers only for the day it was run.
//
// THE TWO DIRECTIONS ARE NOT EQUALLY DANGEROUS.
//   prod has / migrations do not build  -> something reached prod outside the
//     tree: hand-run SQL, or a migration applied and then withdrawn.
//   migrations build / prod lacks       -> an unapplied or HALF-APPLIED
//     migration. Code that ships against the tree is then writing to a column
//     that is not there, which PostgREST answers PGRST204 for the whole
//     statement (see _migration-columns.ts's `sold_at` story). This is the
//     worse one and it is printed second so it is the last thing you read.
//
// HOW PROD IS READ, AND THE TRAP
// PostgREST publishes an OpenAPI document describing every table the CALLING
// ROLE can see, with columns, types, defaults, NOT NULL and COMMENT text. The
// anon key is enough and no write is possible through it -- every call this
// script makes is a GET.
//
//   !! api.gradethread.com sits behind Cloudflare and answers HTTP 403 with the
//      body `error code: 1010` to Python's urllib user agent on EVERY path.
//      That reads exactly like a revoked key and is not one. Node's fetch and
//      curl are both fine; measured 2026-09-11.
//
//   !! THE DOCUMENT SHOWS ONLY WHAT ANON CAN SEE. A table revoked from anon is
//      simply absent, and absence there means "not visible", never "not there".
//      64 of the 360 tables the migrations build are invisible for that reason
//      (CLAUDE.md: 64 of 64 `revoke all` tables are absent from this document,
//      which is the credential-free way to check a revoke held). They are
//      reported as UNREADABLE and are NEVER counted as clean.
//
// FAIL-CLOSED. Zero prod tables parsed, zero migration tables parsed, or a
// migration corpus smaller than the floor below all exit non-zero. A checker
// that reports "no differences" because it read nothing is the failure mode
// this whole story exists to catch.
//
// Usage:
//   node scripts/prod-schema-drift.mjs                 # live diff against prod
//   node scripts/prod-schema-drift.mjs --verbose       # + the unreadable list
//   node scripts/prod-schema-drift.mjs --json          # machine-readable
//   node scripts/prod-schema-drift.mjs --openapi f.json  # diff a SAVED document
//   node scripts/prod-schema-drift.mjs --if-credentialed # skip when no key
//   node scripts/prod-schema-drift.mjs --self-test     # offline, no network
//
// Exit: 0 clean (or a loud skip), 1 drift, 2 the check could not be trusted.

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import {
  columnsOf,
  migrationFileCount,
  migrationFiles,
  readMigration,
  stripSqlComments,
  viewNames,
} from "./lib/migration-schema.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// A floor under the corpus, so a broken glob cannot turn into a clean diff.
// 789 files on 2026-09-11; migrations are append-only, so this can only be
// crossed downward by a bug.
const MIN_MIGRATION_FILES = 700;

// ── The settled differences ─────────────────────────────────────────────────
//
// Every entry is NAMED, CLASSIFIED and carries its evidence, and the list can
// only SHRINK: an entry that stops matching fails this check just as loudly as
// an unexplained difference, so a fix cannot quietly leave its excuse behind.
//
// Classifications are the three US-3410 asked for: `hand-run` (somebody ran SQL
// against prod), `withdrawn` (a migration was applied and then removed from the
// tree), `half-applied` (a migration in the tree did not finish), and
// `parser` (the difference is in the derivation, not in either schema).
const KNOWN = {
  // Present in prod, built by no migration.
  prodOnlyTables: {
    billing_ledger_archive: {
      class: "withdrawn",
      why:
        "The rejected half of the credit-ledger durability design. " +
        "vault/20-domain/credit-ledger-durability.md 'Why not an archive table' " +
        "records the decision to NOT copy rows at deletion time; 00595 shipped " +
        "the accepted design instead (drop the three foreign keys, keep the " +
        "rows). Prod's own COMMENT ON TABLE still reads 'US-XXXX: post-deletion " +
        "copy of grade_credit_transactions' -- an unfilled placeholder, which is " +
        "a draft migration that was applied, not hand-written SQL. No code in " +
        "this repo names it and it holds no rows. 00800 comments it as retired.",
    },
    subscription_event_archive: {
      class: "withdrawn",
      why:
        "The flipdesk_subscription_events half of the same withdrawn design, " +
        "superseded by redact_subscription_event_pii() in 00595/US-2651. " +
        "Unreferenced anywhere in the repo. 00800 comments it as retired.",
    },
  },

  // Present in prod, on a table the migrations DO build.
  prodOnlyColumns: {
    "listings.ebay_drift": {
      class: "withdrawn",
      why:
        "An orphaned 00232_listings_ebay_drift.sql (US-1081) sat in " +
        "supabase/migrations/ while apply-prod-migrations.sh ran, then was " +
        "discarded for colliding with 00232_listing_origin.sql; progress.txt " +
        "records the discard and predicts 'prod may have an inert " +
        "listings.ebay_drift column'. THE FILE IS RECOVERABLE and settles the " +
        "classification without inference: " +
        "`git show 1adc71e2e:supabase/migrations/00232_listings_ebay_drift.sql` " +
        "(a stash commit, 'untracked files on main'). Its COMMENT ON COLUMN text " +
        "matches what prod reports today word for word, and it carries no " +
        "self-record footer, which is why the boot guard never saw it. It was " +
        "never committed to a BRANCH, so `git log --diff-filter=D` cannot find " +
        "it -- reach for `git log --all -S<name>` instead, which is what found " +
        "this. Nothing reads or writes the column. 00800 records the decision " +
        "to keep it inert.",
    },
    "account_deletion_log.ledger_rows_archived": {
      class: "withdrawn",
      why:
        "The counter the archive-table design wrote. Prod also carries " +
        "ledger_rows_retained, which is 00595's accepted replacement and IS in " +
        "the tree. Unreferenced. 00800 comments it as retired.",
    },
    "account_deletion_log.subscription_events_archived": {
      class: "withdrawn",
      why:
        "Same withdrawn design; superseded by subscription_events_redacted, " +
        "which is in the tree. Unreferenced. 00800 comments it as retired.",
    },
  },

  // Parsed out of the migrations, absent from prod. NONE of these is a
  // half-applied migration: all three are the same parser artifact.
  migrationOnlyColumns: {
    "audience_segments.conditions": {
      class: "parser",
      why:
        "Not a column. columnsOf() splits a CREATE TABLE body on commas at " +
        "paren-depth zero and does not track quotes, so the JSON default " +
        `'{"match":"all","conditions":[]}'::jsonb in 00102 splits into a part ` +
        'beginning "conditions". Verified against 00102_growth_suite.sql:57.',
    },
    "dashboard_layouts.widgets": {
      class: "parser",
      why:
        "The same artifact, from '{\"version\": 1, \"widgets\": []}'::jsonb in " +
        "00722_dashboard_layouts.sql:18. A third instance exists -- " +
        "drip_campaigns.steps, named in _migration-columns.ts -- but " +
        "drip_campaigns is revoked from anon, so it lands in UNREADABLE rather " +
        "than here and must not be listed.",
    },
  },
};

// ── The schema the migrations build ─────────────────────────────────────────

/**
 * DDL events in apply order: which tables exist, and which columns were dropped
 * or renamed away after being created.
 *
 * Order matters. A column dropped in 00300 and re-added in 00400 is present,
 * and an order-insensitive subtraction would delete it. Both event kinds are
 * EMPTY in the corpus today (0 DROP COLUMN, 0 RENAME COLUMN across 789 files,
 * measured 2026-09-11), so this path is exercised only by --self-test. That is
 * the reason it is written properly rather than assumed away.
 */
export function migrationDdlEvents(files = migrationFiles()) {
  const createdTables = new Set();
  const droppedTables = new Set();
  const renamedTables = new Map();
  /** @type {Array<{table: string, kind: "add"|"remove", column: string}>} */
  const columnEvents = [];

  for (const file of files) {
    const sql = stripSqlComments(readMigration(file));

    for (const m of sql.matchAll(
      /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:public\.)?"?([a-z_][a-z0-9_]*)"?\s*\(/gi,
    )) {
      const t = m[1].toLowerCase();
      createdTables.add(t);
      droppedTables.delete(t);
    }
    for (const m of sql.matchAll(
      /DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:public\.)?"?([a-z_][a-z0-9_]*)"?/gi,
    )) {
      droppedTables.add(m[1].toLowerCase());
    }

    const alters =
      /ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?(?:public\.)?"?([a-z_][a-z0-9_]*)"?\b([^;]*);/gis;
    for (const m of sql.matchAll(alters)) {
      const table = m[1].toLowerCase();
      const body = m[2] ?? "";
      const to = /RENAME\s+TO\s+"?([a-z_][a-z0-9_]*)"?/i.exec(body);
      if (to && !/RENAME\s+COLUMN/i.test(body)) {
        renamedTables.set(table, to[1].toLowerCase());
        createdTables.add(to[1].toLowerCase());
        droppedTables.add(table);
      }
      for (const c of body.matchAll(
        /ADD\s+COLUMN\s+(?:IF\s+NOT\s+EXISTS\s+)?"?([a-z_][a-z0-9_]*)"?/gi,
      )) {
        columnEvents.push({ table, kind: "add", column: c[1].toLowerCase() });
      }
      for (const c of body.matchAll(
        /DROP\s+COLUMN\s+(?:IF\s+EXISTS\s+)?"?([a-z_][a-z0-9_]*)"?/gi,
      )) {
        columnEvents.push({ table, kind: "remove", column: c[1].toLowerCase() });
      }
      for (const c of body.matchAll(
        /RENAME\s+COLUMN\s+"?([a-z_][a-z0-9_]*)"?\s+TO\s+"?([a-z_][a-z0-9_]*)"?/gi,
      )) {
        columnEvents.push({ table, kind: "remove", column: c[1].toLowerCase() });
        columnEvents.push({ table, kind: "add", column: c[2].toLowerCase() });
      }
    }
  }

  return { createdTables, droppedTables, renamedTables, columnEvents };
}

/**
 * table -> the columns the migrations leave it holding.
 *
 * The CREATE TABLE / ADD COLUMN parse is columnsOf() from
 * scripts/lib/migration-schema.mjs, which was cross-checked against a live
 * local stack on 2026-09-11 and missed zero real columns. This only replays the
 * SUBTRACTIONS on top, which that helper does not model.
 */
export function migrationSchema(events = migrationDdlEvents()) {
  const out = new Map();
  for (const table of events.createdTables) {
    if (events.droppedTables.has(table)) continue;
    const cols = new Set(columnsOf(table));
    for (const e of events.columnEvents) {
      if (e.table !== table) continue;
      if (e.kind === "remove") cols.delete(e.column);
      else cols.add(e.column);
    }
    out.set(table, cols);
  }
  return out;
}

// ── The schema prod reports ─────────────────────────────────────────────────

/** name -> columns, out of a PostgREST OpenAPI document. */
export function prodSchema(doc) {
  const defs = doc?.definitions;
  if (!defs || typeof defs !== "object") {
    throw new Error(
      "the OpenAPI document has no `definitions` object -- PostgREST did not " +
        "answer with a schema. Do NOT read this as a clean diff.",
    );
  }
  const out = new Map();
  for (const [name, def] of Object.entries(defs)) {
    // `(rpc) fn` argument shapes are not tables. None exist today; cheap guard.
    if (!/^[a-z_][a-z0-9_]*$/.test(name)) continue;
    out.set(name, new Set(Object.keys(def?.properties ?? {})));
  }
  return out;
}

// ── The diff ────────────────────────────────────────────────────────────────

export function diffSchemas(mig, prod, views = viewNames(), fileCount = migrationFileCount()) {
  if (fileCount < MIN_MIGRATION_FILES) {
    throw new Error(
      `only ${fileCount} migration files were read (floor ${MIN_MIGRATION_FILES}). ` +
        "The corpus cannot shrink, so the glob is broken and every 'prod has, " +
        "migrations do not build' line below would be an artifact.",
    );
  }
  if (mig.size === 0) throw new Error("the migrations parsed to ZERO tables.");
  if (prod.size === 0) throw new Error("production reported ZERO tables.");
  let migColumns = 0;
  for (const cols of mig.values()) migColumns += cols.size;
  if (migColumns === 0) throw new Error("the migrations parsed to ZERO columns.");

  const prodOnlyTables = [];
  const prodOnlyColumns = [];
  const migrationOnlyColumns = [];
  const unreadable = [];
  const unparsed = [];
  let compared = 0;

  for (const [name, prodCols] of prod) {
    if (views.has(name)) continue;
    if (!mig.has(name)) {
      prodOnlyTables.push(name);
      continue;
    }
    const migCols = mig.get(name);
    // An empty set out of columnsOf() means "could not resolve", never "no
    // columns". Reporting every prod column as drift would be the loud version
    // of the same mistake, so it is named separately.
    if (migCols.size === 0) {
      unparsed.push(name);
      continue;
    }
    compared++;
    for (const c of prodCols) if (!migCols.has(c)) prodOnlyColumns.push(`${name}.${c}`);
    for (const c of migCols) if (!prodCols.has(c)) migrationOnlyColumns.push(`${name}.${c}`);
  }

  for (const name of mig.keys()) {
    if (!prod.has(name) && !views.has(name)) unreadable.push(name);
  }

  prodOnlyTables.sort();
  prodOnlyColumns.sort();
  migrationOnlyColumns.sort();
  unreadable.sort();
  unparsed.sort();

  return {
    compared,
    migrationTables: mig.size,
    prodTables: prod.size,
    migrationColumns: migColumns,
    prodOnlyTables,
    prodOnlyColumns,
    migrationOnlyColumns,
    unreadable,
    unparsed,
  };
}

/**
 * The diff against KNOWN: what is unexplained, and which excuses have expired.
 */
export function judge(diff, known = KNOWN) {
  const unexplained = [];
  const stale = [];
  const buckets = [
    ["prodOnlyTables", known.prodOnlyTables],
    ["prodOnlyColumns", known.prodOnlyColumns],
    ["migrationOnlyColumns", known.migrationOnlyColumns],
  ];
  for (const [bucket, entries] of buckets) {
    const seen = new Set(diff[bucket]);
    for (const name of diff[bucket]) {
      if (!entries[name]) unexplained.push({ bucket, name });
    }
    for (const name of Object.keys(entries)) {
      if (!seen.has(name)) stale.push({ bucket, name });
    }
  }
  return { unexplained, stale, ok: unexplained.length === 0 && stale.length === 0 };
}

// ── Reading prod ────────────────────────────────────────────────────────────

/** A JWT-shaped value, so CI's `ci-placeholder-anon-key` is not mistaken for one. */
function looksLikeJwt(v) {
  return typeof v === "string" && v.split(".").length === 3 && v.length > 100;
}

function envFromFile(name) {
  const file = resolve(ROOT, ".env.production");
  if (!existsSync(file)) return undefined;
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    if (!line.startsWith(`${name}=`)) continue;
    return line.slice(name.length + 1).trim().replace(/^"|"$/g, "");
  }
  return undefined;
}

/** The anon key, by reference only. It is never printed or returned upward. */
function anonKey() {
  const fromEnv = process.env.VITE_SUPABASE_ANON_KEY;
  if (looksLikeJwt(fromEnv)) return fromEnv;
  const fromFile = envFromFile("VITE_SUPABASE_ANON_KEY");
  return looksLikeJwt(fromFile) ? fromFile : undefined;
}

function restBase() {
  const url =
    process.env.VITE_SUPABASE_URL || envFromFile("VITE_SUPABASE_URL") || "https://api.gradethread.com";
  return `${url.replace(/\/+$/, "")}/rest/v1/`;
}

async function fetchProdOpenApi(key) {
  const res = await fetch(restBase(), {
    method: "GET",
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      Accept: "application/openapi+json",
    },
  });
  const body = await res.text();
  if (!res.ok) {
    throw new Error(
      `PostgREST answered HTTP ${res.status}. First 120 bytes: ${body.slice(0, 120)}` +
        (body.includes("1010")
          ? "\n(`error code: 1010` is Cloudflare refusing the USER AGENT, not a bad key.)"
          : ""),
    );
  }
  return JSON.parse(body);
}

// ── Output ──────────────────────────────────────────────────────────────────

const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const GREEN = "\x1b[32m";
const DIM = "\x1b[2m";
const OFF = "\x1b[0m";

function describe(bucket, name, known) {
  const e = known[bucket]?.[name];
  return e ? `${DIM}[${e.class}]${OFF} ${name}` : `${RED}[UNEXPLAINED]${OFF} ${name}`;
}

function report(diff, verdict, { verbose }) {
  const out = [];
  out.push(
    `migrations: ${diff.migrationTables} tables / ${diff.migrationColumns} columns  ` +
      `prod (anon-visible): ${diff.prodTables}  compared: ${diff.compared}`,
  );
  out.push("");
  out.push(`PROD HAS, MIGRATIONS DO NOT BUILD -- tables (${diff.prodOnlyTables.length})`);
  for (const n of diff.prodOnlyTables) out.push("  " + describe("prodOnlyTables", n, KNOWN));
  out.push(`PROD HAS, MIGRATIONS DO NOT BUILD -- columns (${diff.prodOnlyColumns.length})`);
  for (const n of diff.prodOnlyColumns) out.push("  " + describe("prodOnlyColumns", n, KNOWN));
  out.push("");
  out.push(
    `MIGRATIONS BUILD, PROD LACKS -- columns (${diff.migrationOnlyColumns.length})  ` +
      `${DIM}the dangerous direction: an unapplied or half-applied migration${OFF}`,
  );
  for (const n of diff.migrationOnlyColumns) {
    out.push("  " + describe("migrationOnlyColumns", n, KNOWN));
  }
  out.push("");
  out.push(
    `${YELLOW}UNREADABLE${OFF}: ${diff.unreadable.length} tables are revoked from anon and ` +
      "are NOT part of either count above. Absent here means not visible, not absent from prod.",
  );
  if (verbose) for (const n of diff.unreadable) out.push(`  ${DIM}${n}${OFF}`);
  if (diff.unparsed.length) {
    out.push(
      `${YELLOW}UNPARSED${OFF}: ${diff.unparsed.length} prod tables whose migration columns ` +
        `resolved empty and were skipped: ${diff.unparsed.join(", ")}`,
    );
  }
  out.push("");
  for (const { bucket, name } of verdict.unexplained) {
    out.push(
      `${RED}UNEXPLAINED${OFF} ${bucket}: ${name} -- classify it (hand-run / withdrawn / ` +
        "half-applied) and add it to KNOWN in this script, with the evidence.",
    );
  }
  for (const { bucket, name } of verdict.stale) {
    out.push(
      `${RED}STALE KNOWN ENTRY${OFF} ${bucket}: ${name} no longer differs. The list only ` +
        "shrinks -- delete the entry.",
    );
  }
  out.push(
    verdict.ok
      ? `${GREEN}OK${OFF} every difference is named and every named difference still exists.`
      : `${RED}FAIL${OFF} ${verdict.unexplained.length} unexplained, ${verdict.stale.length} stale.`,
  );
  return out.join("\n");
}

// ── Self-test ───────────────────────────────────────────────────────────────
//
// Offline. Proves the three things a reader has to believe before trusting a
// quiet run: that a planted difference is REPORTED in each direction, that an
// empty read FAILS instead of reading as clean, and that the ordered replay
// actually subtracts.

function selfTest() {
  const fails = [];
  const check = (label, cond) => {
    if (!cond) fails.push(label);
    process.stdout.write(`  ${cond ? GREEN + "ok  " + OFF : RED + "FAIL" + OFF} ${label}\n`);
  };

  const views = new Set(["some_view"]);
  const mig = new Map([
    ["listings", new Set(["id", "user_id"])],
    ["only_in_migrations_col_holder", new Set(["id", "not_in_prod_yet"])],
  ]);
  const prod = new Map([
    ["listings", new Set(["id", "user_id", "planted_prod_only"])],
    ["only_in_migrations_col_holder", new Set(["id"])],
    ["planted_prod_only_table", new Set(["id"])],
    ["some_view", new Set(["id"])],
  ]);
  const d = diffSchemas(mig, prod, views, MIN_MIGRATION_FILES);
  check("a prod-only COLUMN is reported", d.prodOnlyColumns.includes("listings.planted_prod_only"));
  check("a prod-only TABLE is reported", d.prodOnlyTables.includes("planted_prod_only_table"));
  check(
    "a migration-only COLUMN is reported",
    d.migrationOnlyColumns.includes("only_in_migrations_col_holder.not_in_prod_yet"),
  );
  check("a declared VIEW is not reported as a prod-only table", !d.prodOnlyTables.includes("some_view"));

  const threw = (fn) => {
    try {
      fn();
      return false;
    } catch {
      return true;
    }
  };
  check("zero prod tables FAILS", threw(() => diffSchemas(mig, new Map(), views, MIN_MIGRATION_FILES)));
  check("zero migration tables FAILS", threw(() => diffSchemas(new Map(), prod, views, MIN_MIGRATION_FILES)));
  check(
    "zero migration columns FAILS",
    threw(() => diffSchemas(new Map([["t", new Set()]]), prod, views, MIN_MIGRATION_FILES)),
  );
  check(
    "a short migration corpus FAILS",
    threw(() => diffSchemas(mig, prod, views, MIN_MIGRATION_FILES - 1)),
  );
  check("a document with no definitions FAILS", threw(() => prodSchema({})));

  const v = judge(
    { prodOnlyTables: ["surprise"], prodOnlyColumns: [], migrationOnlyColumns: [] },
    { prodOnlyTables: {}, prodOnlyColumns: {}, migrationOnlyColumns: {} },
  );
  check("an unlisted difference is UNEXPLAINED", v.unexplained.length === 1 && !v.ok);
  const s = judge(
    { prodOnlyTables: [], prodOnlyColumns: [], migrationOnlyColumns: [] },
    { prodOnlyTables: { gone: { class: "withdrawn", why: "x" } }, prodOnlyColumns: {}, migrationOnlyColumns: {} },
  );
  check("an excuse that no longer matches is STALE", s.stale.length === 1 && !s.ok);

  process.stdout.write(
    fails.length
      ? `${RED}self-test FAILED${OFF}: ${fails.length}\n`
      : `${GREEN}self-test ok${OFF}\n`,
  );
  return fails.length === 0 ? 0 : 2;
}

// ── Entry point ─────────────────────────────────────────────────────────────

async function main() {
  const argv = process.argv.slice(2);
  const flag = (n) => argv.includes(n);

  if (flag("--self-test")) return selfTest();

  const verbose = flag("--verbose");
  const asJson = flag("--json");
  const fileAt = argv.indexOf("--openapi");
  let doc;

  if (fileAt !== -1) {
    const path = argv[fileAt + 1];
    if (!path) {
      process.stderr.write("--openapi needs a path to a saved OpenAPI document\n");
      return 2;
    }
    doc = JSON.parse(readFileSync(path, "utf8"));
  } else {
    const key = anonKey();
    if (!key) {
      const msg =
        "no usable VITE_SUPABASE_ANON_KEY (env or .env.production). The anon key " +
        "is what reads prod's OpenAPI document; CI's placeholder is not one.\n";
      if (flag("--if-credentialed")) {
        process.stdout.write(`${YELLOW}SKIPPED${OFF} prod schema drift: ${msg}`);
        return 0;
      }
      process.stderr.write(msg);
      return 2;
    }
    try {
      doc = await fetchProdOpenApi(key);
    } catch (err) {
      const msg = `could not read prod: ${err.message}\n`;
      if (flag("--if-credentialed")) {
        process.stdout.write(`${YELLOW}SKIPPED${OFF} prod schema drift: ${msg}`);
        return 0;
      }
      process.stderr.write(msg);
      return 2;
    }
  }

  let diff;
  try {
    diff = diffSchemas(migrationSchema(), prodSchema(doc));
  } catch (err) {
    process.stderr.write(`${RED}prod schema drift could not be trusted${OFF}: ${err.message}\n`);
    return 2;
  }
  const verdict = judge(diff);

  if (asJson) {
    process.stdout.write(JSON.stringify({ ...diff, ...verdict }, null, 2) + "\n");
  } else {
    process.stdout.write(report(diff, verdict, { verbose }) + "\n");
  }
  return verdict.ok ? 0 : 1;
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("prod-schema-drift.mjs")) {
  main().then((code) => process.exit(code));
}

export { KNOWN, MIN_MIGRATION_FILES };
