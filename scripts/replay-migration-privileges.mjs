#!/usr/bin/env node
// Put the migrations' privilege decisions back after a blanket GRANT ALL.
//
// tenant-isolation.yml and money-cert-integration.yml run
//   GRANT ALL ON ALL TABLES/SEQUENCES/FUNCTIONS IN SCHEMA public TO anon, authenticated, service_role
// so the fixture seed can write through PostgREST. That statement also undoes
// every REVOKE in the schema (US-3350: 83+ tables read as wide open after it),
// so the security lane ran against a privilege model prod does not have and
// could never see an anon-grant regression.
//
// This replays every GRANT and REVOKE in supabase/migrations, in filename
// order, so the end state is what the migrations say. Both kinds, in order,
// because revokes alone are wrong in the other direction: a table revoked in
// one migration and partly re-granted in a later one would end up closed.
//
// ⚠ Two statement shapes, and the second is the one the obvious regex misses.
//   1. A plain `revoke ... ;` / `grant ... ;`.
//   2. `EXECUTE 'REVOKE ALL ON public.t FROM anon, authenticated';` inside a
//      DO block (00475, 00531, 00711 wrap revokes this way). Extracting
//      `revoke[^;]*;` catches it with a stray quote on the end, psql rejects
//      it, and those tables stay open. That is not hypothetical: replaying
//      plain revokes only left selector_health_pings, extension_usage_pings,
//      ebay_api_call_daily and ebay_rate_limit_snapshots granted to anon, and
//      scripts/check-service-role-grants.mjs reported all four.
// A statement built with format('%I') cannot be replayed from text; those are
// counted and printed, never silently dropped.
//
// Usage:
//   node scripts/replay-migration-privileges.mjs --dsn "$SUPABASE_DB_URL"
//   node scripts/replay-migration-privileges.mjs --list     # print, run nothing
//   add --verbose to list the statements whose object was dropped later
//
// LOCAL / CI throwaway stacks ONLY. Never point it at prod: prod's privileges
// are already what the migrations made them.
//
// Exit: 0 replayed, 1 a statement failed for a reason other than its object
// having been dropped later, 2 could not reach the database.

import { readdirSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { looksUnreachable, psqlTarget } from "./lib/psql-target.mjs";

const MIGRATIONS = join(import.meta.dirname, "..", "supabase", "migrations");

/** Comments out, CRLF normalised. Block comments per file so one stray opener stays bounded. */
export function stripSqlComments(sql) {
  return sql
    .replace(/\r\n?/g, "\n")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/--[^\n]*/g, "");
}

/**
 * Every GRANT/REVOKE in one migration, in source order.
 * Returns { statements, dynamic } where dynamic are EXECUTE strings that build
 * the statement with format() and so cannot be replayed from text.
 */
export function privilegeStatements(sql) {
  const src = stripSqlComments(sql);
  const found = [];
  const dynamic = [];
  // 1. Plain statements. No quote allowed before the ';', so the tail of an
  //    EXECUTE '...' string is never read as a statement of its own.
  for (const m of src.matchAll(/(?:^|[;\n])\s*((?:grant|revoke)\s[^;']*);/gi)) {
    found.push({ at: m.index + m[0].indexOf(m[1]), text: m[1].trim() });
  }
  // 2. EXECUTE 'GRANT/REVOKE ...' with a literal string.
  for (const m of src.matchAll(/execute\s+'((?:grant|revoke)\s(?:[^']|'')*)'/gi)) {
    const text = m[1].replace(/''/g, "'").trim().replace(/;$/, "");
    if (/%[IsL]/.test(text)) dynamic.push(text);
    else found.push({ at: m.index, text });
  }
  // 3. EXECUTE format('GRANT/REVOKE ...%I...') -- report, cannot replay.
  for (const m of src.matchAll(/execute\s+format\(\s*'((?:grant|revoke)\s(?:[^']|'')*)'/gi)) {
    dynamic.push(m[1]);
  }
  found.sort((a, b) => a.at - b.at);
  return { statements: found.map((f) => f.text), dynamic };
}

export function corpusStatements(dir = MIGRATIONS) {
  const files = readdirSync(dir).filter((f) => /^\d+_.*\.sql$/.test(f)).sort();
  const statements = [];
  const dynamic = [];
  for (const f of files) {
    const r = privilegeStatements(readFileSync(join(dir, f), "utf8"));
    for (const s of r.statements) statements.push({ file: f, text: s });
    for (const d of r.dynamic) dynamic.push({ file: f, text: d });
  }
  return { files: files.length, statements, dynamic };
}

// Objects a later migration dropped or renamed. Replaying a grant on them is a
// no-op in the end state, so these failures are expected and only counted.
const GONE = new Set(["42P01", "42883", "42704", "3F000", "42725"]);

export function buildReplaySql(statements) {
  const lines = ["\\set ON_ERROR_STOP on"];
  statements.forEach((s, i) => {
    if (s.text.includes("$replay_stmt$")) throw new Error(`cannot quote statement ${i}`);
    lines.push(
      `do $replay$ begin execute $replay_stmt$${s.text}$replay_stmt$; ` +
        `exception when others then raise notice 'REPLAY_FAIL ${i} %: %', sqlstate, sqlerrm; end $replay$;`,
    );
  });
  lines.push("select 'REPLAY_DONE';");
  return lines.join("\n") + "\n";
}

function main() {
  const { files, statements, dynamic } = corpusStatements();
  const revokes = statements.filter((s) => /^revoke/i.test(s.text)).length;
  if (statements.length < 200 || revokes < 150) {
    console.error(
      `✗ only ${statements.length} statements (${revokes} revokes) found in ${files} migrations; ` +
        "the extraction broke, and replaying nothing would leave every table open.",
    );
    process.exit(2);
  }

  if (process.argv.includes("--list")) {
    for (const s of statements) console.log(`${s.file}\t${s.text.replace(/\s+/g, " ")}`);
    for (const d of dynamic) console.log(`${d.file}\tDYNAMIC\t${d.text.replace(/\s+/g, " ")}`);
    return;
  }

  const target = psqlTarget();
  const run = spawnSync(target.cmd, target.argv, {
    input: buildReplaySql(statements),
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  const out = String(run.stdout ?? "") + String(run.stderr ?? "");
  const status = run.status ?? (run.error ? -1 : 0);
  if (run.error || looksUnreachable(out, status)) {
    console.error(`✗ could not reach ${target.how}.\n  ${target.hint}`);
    process.exit(2);
  }
  if (!out.includes("REPLAY_DONE")) {
    console.error("✗ the replay did not finish. Raw tail:\n" + out.slice(-1500));
    process.exit(2);
  }

  const gone = [];
  const failed = [];
  for (const m of out.matchAll(/REPLAY_FAIL (\d+) (\w+): ([^\n]*)/g)) {
    const s = statements[Number(m[1])];
    const row = `${s.file}: ${s.text.replace(/\s+/g, " ").slice(0, 140)} -> ${m[2]} ${m[3]}`;
    (GONE.has(m[2]) ? gone : failed).push(row);
  }

  console.log(
    `  replayed ${statements.length - gone.length - failed.length} of ${statements.length} ` +
      `GRANT/REVOKE statements from ${files} migrations (${revokes} revokes)`,
  );
  if (gone.length) {
    console.log(`  ${gone.length} named an object a later migration dropped (expected; --verbose lists them)`);
    if (process.argv.includes("--verbose")) for (const g of gone) console.log(`    ${g}`);
  }
  if (dynamic.length) {
    console.log(`  ${dynamic.length} built with format() and not replayable from text:`);
    for (const d of dynamic) console.log(`    ${d.file}: ${d.text.replace(/\s+/g, " ").slice(0, 120)}`);
  }
  if (failed.length) {
    console.error(`\n✗ ${failed.length} statement(s) failed for another reason:`);
    for (const f of failed) console.error(`  - ${f}`);
    process.exit(1);
  }
  console.log("\n✓ privileges replayed; check them with scripts/check-service-role-grants.mjs");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
