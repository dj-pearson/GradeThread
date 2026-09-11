#!/usr/bin/env node
// The half of scripts/prod-schema-audit.sql that needs no database session.
//
// WHY (US-2832 AC7). 00134 was HALF-applied to production and nobody noticed for
// months, because `apply-prod-migrations.sh` skips by MAXIMUM rather than by
// membership: a hole beneath the watermark is never re-applied and never
// reported. `scripts/prod-schema-audit.sql` was written to answer "is anything
// ELSE missing" in one read-only pass - and it has sat unrun ever since, because
// running it needs a psql session against prod and that is a person's afternoon.
//
// Most of what it asks is answerable from a laptop. PostgREST publishes an
// OpenAPI document naming every exposed table, every column on it, every NOT
// NULL constraint and every RPC, and the anon key that reads it ships in the
// frontend bundle. So this takes the EXPECTED set out of that same .sql file -
// one source of truth, not a second copy - and diffs it against what production
// actually serves.
//
//   node scripts/prod-schema-probe.mjs                 # fetch and diff
//   node scripts/prod-schema-probe.mjs --openapi F     # diff a saved document
//   node scripts/prod-schema-probe.mjs --self-test     # no network
//
// WHAT IT SETTLES. A column expected on a table PostgREST can see and absent
// from the document is missing, and that is the `listings.draft_id` shape
// exactly. Nullability drift is the `listings.listed_at` shape, invisible to any
// existence check. An RPC absent from `paths` is a function that did not land.
//
// WHAT IT CANNOT, and the report says so rather than implying a clean bill:
//
//   - UNEXPOSED TABLES. Deny-all operator tables never appear. Their absence is
//     the normal state and proves nothing either way. Counted, listed, and never
//     reported as missing.
//   - INDEXES, TRIGGERS, DEFAULTS, CHECK CONSTRAINTS. None of them are in the
//     document. `idx_listings_draft_id` cannot be verified here.
//   - CACHE FRESHNESS. The document reflects PostgREST's schema cache. A
//     migration applied without `NOTIFY pgrst, 'reload schema'` is invisible
//     here while being perfectly present in the database - so a finding is a
//     lead, and `NOTIFY` then re-run is the first thing to try.
//
// So this NARROWS the operator step, it does not replace it. The .sql file is
// still the complete answer and still needs a session.

import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");
const API = process.env.PROBE_API_URL ?? "https://api.gradethread.com";
const TIMEOUT_MS = 60_000;

/**
 * The expected schema, parsed out of prod-schema-audit.sql's own VALUES blocks.
 *
 * Reading the .sql rather than keeping a second list is the whole point: a
 * second copy is a copy that goes stale, and a stale expectation makes a guard
 * fire at correct production (see the AASA checker, US-3108).
 */
export function expectedFromAuditSql(sql) {
  const columns = [...sql.matchAll(/^\('([a-z0-9_]+)','([a-z0-9_]+)','(YES|NO)'\),?$/gm)]
    .map((m) => ({ table: m[1], column: m[2], notNull: m[3] === "NO" }));
  const fnBlock = /exp_fn \(n\) AS \(VALUES([\s\S]*?)\n\),/.exec(sql);
  const functions = fnBlock
    ? [...fnBlock[1].matchAll(/^\('([a-z0-9_]+)'\),?$/gm)].map((m) => m[1])
    : [];
  const tables = [...new Set(columns.map((c) => c.table))].sort();
  return { columns, functions, tables };
}

/** Diff the expected set against a PostgREST OpenAPI document. */
export function diffAgainstOpenApi(expected, openapi) {
  const defs = openapi.definitions ?? {};
  const paths = openapi.paths ?? {};
  const invisibleTables = [];
  const missingColumns = [];
  const nullabilityDrift = [];
  const byTable = new Map();
  for (const c of expected.columns) {
    if (!byTable.has(c.table)) byTable.set(c.table, []);
    byTable.get(c.table).push(c);
  }
  let checkedTables = 0;
  let checkedColumns = 0;
  for (const [table, cols] of byTable) {
    const def = defs[table];
    if (!def) {
      invisibleTables.push(table);
      continue;
    }
    checkedTables += 1;
    const props = new Set(Object.keys(def.properties ?? {}));
    const required = new Set(def.required ?? []);
    for (const c of cols) {
      if (!props.has(c.column)) {
        missingColumns.push(`${c.table}.${c.column}`);
        continue;
      }
      checkedColumns += 1;
      if (required.has(c.column) !== c.notNull) {
        nullabilityDrift.push(
          `${c.table}.${c.column}: repo=${c.notNull ? "NOT NULL" : "nullable"}, ` +
            `prod=${required.has(c.column) ? "NOT NULL" : "nullable"}`,
        );
      }
    }
  }
  // An RPC only appears in `paths` when the role reading the document may see
  // it, so an absence here is weaker than a missing column. Reported separately
  // and never mixed into the hard findings.
  const invisibleFunctions = expected.functions.filter((n) => !paths[`/rpc/${n}`]);
  return {
    invisibleTables,
    invisibleFunctions,
    missingColumns,
    nullabilityDrift,
    checkedTables,
    checkedColumns,
  };
}

/** The anon key: public by construction - it ships in the browser bundle. */
export function anonKey() {
  if (process.env.ANON_KEY) return process.env.ANON_KEY.trim();
  try {
    const env = readFileSync(path.join(REPO, ".env.production"), "utf8");
    const m = /^VITE_SUPABASE_ANON_KEY=(.+)$/m.exec(env);
    if (m) return m[1].trim();
  } catch { /* fall through */ }
  try {
    const dir = path.join(REPO, "dist", "assets");
    const JWT = /eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}/;
    for (const f of readdirSync(dir).filter((x) => x.endsWith(".js"))) {
      const hit = JWT.exec(readFileSync(path.join(dir, f), "utf8"));
      if (!hit) continue;
      const claims = JSON.parse(Buffer.from(hit[0].split(".")[1], "base64").toString());
      if (claims.role === "anon") return hit[0];
    }
  } catch { /* fall through */ }
  return null;
}

async function fetchOpenApi(key) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${API}/rest/v1/`, {
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        Accept: "application/openapi+json",
      },
      signal: ctl.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

function selfTest() {
  const sql = [
    "WITH exp_col (t, c, nullable) AS (VALUES",
    "('listings','id','NO'),",
    "('listings','draft_id','YES'),",
    "('listings','listed_at','NO'),",
    "('admin_audit_log','id','NO')",
    "),",
    "exp_fn (n) AS (VALUES",
    "('gt_require_role'),",
    "('increment_grades_used')",
    "),",
  ].join("\n");
  const expected = expectedFromAuditSql(sql);
  const openapi = {
    definitions: {
      listings: {
        properties: { id: {}, listed_at: {} },
        required: ["id"],
      },
    },
    paths: { "/rpc/gt_require_role": {} },
  };
  const d = diffAgainstOpenApi(expected, openapi);
  const checks = [
    ["parses 4 expected columns", expected.columns.length === 4],
    ["parses 2 expected functions", expected.functions.length === 2],
    ["a column absent from a VISIBLE table is missing", d.missingColumns.join() === "listings.draft_id"],
    ["nullability drift is caught", d.nullabilityDrift.length === 1 && d.nullabilityDrift[0].startsWith("listings.listed_at")],
    ["an UNEXPOSED table is invisible, never missing", d.invisibleTables.join() === "admin_audit_log"],
    ["a table's absence never becomes a column finding", !d.missingColumns.some((m) => m.startsWith("admin_audit_log"))],
    ["an absent RPC is reported separately", d.invisibleFunctions.join() === "increment_grades_used"],
    ["the counts describe what was actually inspected", d.checkedTables === 1 && d.checkedColumns === 2],
  ];
  let failed = 0;
  for (const [label, ok] of checks) {
    if (!ok) failed += 1;
    console.log(`  ${ok ? "ok  " : "FAIL"} ${label}`);
  }
  // The real audit file must still parse, or every run above is measuring an
  // empty expectation and reporting it as clean.
  const real = expectedFromAuditSql(readFileSync(path.join(REPO, "scripts", "prod-schema-audit.sql"), "utf8"));
  const realOk = real.columns.length > 3000 && real.functions.length > 100;
  if (!realOk) failed += 1;
  console.log(
    `  ${realOk ? "ok  " : "FAIL"} the real prod-schema-audit.sql parses: ` +
      `${real.tables.length} tables, ${real.columns.length} columns, ${real.functions.length} functions`,
  );
  console.log(failed === 0 ? `self-test: ${checks.length + 1} passed` : `self-test: ${failed} FAILED`);
  return failed === 0 ? 0 : 1;
}

function report(d, expected) {
  console.log(
    `expected ${expected.tables.length} tables / ${expected.columns.length} columns / ` +
      `${expected.functions.length} functions (from scripts/prod-schema-audit.sql)`,
  );
  console.log(
    `checked ${d.checkedTables} exposed table(s), ${d.checkedColumns} column(s) against production.`,
  );
  console.log(
    `${d.invisibleTables.length} table(s) and ${d.invisibleFunctions.length} function(s) are not in ` +
      `the document at all - deny-all RLS or not exposed. NOT a finding; they need the .sql and a session.`,
  );
  if (d.missingColumns.length === 0 && d.nullabilityDrift.length === 0) {
    console.log("\nNo missing column and no nullability drift on anything PostgREST can see.");
    console.log("Indexes, triggers, defaults and CHECK constraints are still unchecked by this tool.");
    return 0;
  }
  if (d.missingColumns.length > 0) {
    console.log(`\n${d.missingColumns.length} EXPECTED COLUMN(S) ABSENT from a visible table:`);
    for (const m of d.missingColumns) console.log(`  ${m}`);
  }
  if (d.nullabilityDrift.length > 0) {
    console.log(`\n${d.nullabilityDrift.length} NULLABILITY DRIFT:`);
    for (const m of d.nullabilityDrift) console.log(`  ${m}`);
  }
  console.log(
    "\nSend `NOTIFY pgrst, 'reload schema';` and re-run before concluding anything: this reads\n" +
      "PostgREST's cache, and a migration applied without that NOTIFY is invisible here.",
  );
  return 1;
}

async function main(argv) {
  if (argv.includes("--self-test")) return selfTest();
  const expected = expectedFromAuditSql(
    readFileSync(path.join(REPO, "scripts", "prod-schema-audit.sql"), "utf8"),
  );
  const fileIdx = argv.indexOf("--openapi");
  let openapi;
  if (fileIdx >= 0 && argv[fileIdx + 1]) {
    openapi = JSON.parse(readFileSync(argv[fileIdx + 1], "utf8"));
    console.log(`reading ${argv[fileIdx + 1]}`);
  } else {
    const key = anonKey();
    if (!key) {
      console.error(
        "no anon key: set ANON_KEY, or keep VITE_SUPABASE_ANON_KEY in .env.production, or run npm run build.",
      );
      return 2;
    }
    openapi = await fetchOpenApi(key);
    console.log(`${API}/rest/v1/ served ${Object.keys(openapi.definitions ?? {}).length} definitions`);
  }
  return report(diffAgainstOpenApi(expected, openapi), expected);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
