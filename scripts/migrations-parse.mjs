#!/usr/bin/env node
// Every migration must PARSE as PostgreSQL. No Docker, no server, no network.
//
// WHY THIS EXISTS. `verify:db` boots a throwaway Postgres and applies the whole
// directory, which is the real proof — and it needs Docker. When Docker is down
// the lane is SKIPPED WITH A WARNING, and on 2026-08-23 that meant a migration
// was written, committed, and reached origin/main having never been near a
// Postgres in any form. Nothing between "I typed some SQL" and "prod runs it"
// looked at the SQL at all.
//
// This is the cheap half of that proof, and it is the half that always runs.
// It uses libpg_query — the ACTUAL PostgreSQL grammar, the same C parser the
// server uses, compiled to WASM — so a pass means the statements are real
// Postgres, not that they matched a regex someone wrote.
//
// ── WHAT IT DOES NOT PROVE, and the distinction matters ──────────────────────
//
// Parsing is not applying. This says nothing about whether a column exists, a
// type matches, a constraint is satisfiable, or a function body's plpgsql is
// sound (the parser sees `AS $$...$$` as an opaque string). A migration can
// parse perfectly and still fail on contact with a real schema.
//
// So this does NOT replace verify:db. It replaces "nobody looked".
//
// Run: node scripts/migrations-parse.mjs [--quiet]

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = resolve(HERE, "..", "supabase", "migrations");

// A deliberately broken statement, used to prove the parser still rejects
// things. WITHOUT THIS the whole script degrades silently: a parser that starts
// accepting everything — a bad upgrade, a stubbed module — would report 656
// clean files and look exactly like a healthy run. Same reason
// check-ui-antipatterns.mjs scans its own fixtures.
const CANARY = "CREATE TABLE IF NOT EXISTS public.x (((;";

async function main() {
  const quiet = process.argv.includes("--quiet");

  let parser;
  try {
    parser = await import("pgsql-parser");
    if (parser.loadModule) await parser.loadModule();
  } catch (err) {
    // NOT a skip. A missing parser means this check is not running, and a check
    // that is not running must not look like a check that passed — that is the
    // exact shape verify:db's Docker skip has, and the reason this file exists.
    console.error(
      "\n[migrations-parse] FAILED — pgsql-parser could not be loaded.\n" +
        `  ${err instanceof Error ? err.message : String(err)}\n\n` +
        "  This is a devDependency. Run `npm ci`. It is deliberately NOT skipped\n" +
        "  when absent: an absent parser and a clean parse look identical in a\n" +
        "  log, and that confusion is what this check was written after.\n",
    );
    process.exit(1);
  }

  try {
    parser.parseSync(CANARY);
    console.error(
      "\n[migrations-parse] FAILED — the canary PARSED.\n\n" +
        "  A statement with unbalanced parens was accepted, so the parser is not\n" +
        "  rejecting anything and a green run below would mean nothing.\n",
    );
    process.exit(1);
  } catch {
    // Expected: the canary must be refused.
  }

  const files = readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  if (files.length < 100) {
    console.error(
      `\n[migrations-parse] FAILED — only ${files.length} migration(s) found in\n` +
        `  ${MIGRATIONS}\n\n  That is too few to be the real directory; the path is probably wrong.\n`,
    );
    process.exit(1);
  }

  const broken = [];
  let statements = 0;
  for (const f of files) {
    const sql = readFileSync(join(MIGRATIONS, f), "utf8");
    try {
      const ast = parser.parseSync(sql);
      const stmts = Array.isArray(ast) ? ast : (ast?.stmts ?? []);
      statements += stmts.length;
    } catch (err) {
      broken.push({
        file: f,
        message: String(err instanceof Error ? err.message : err).split("\n")[0],
      });
    }
  }

  // A SECOND FLOOR, on the OUTPUT rather than on the input.
  //
  // The canary above catches a parser that accepts everything. It does not catch
  // one that RETURNS nothing — a stub, a bad upgrade, an API change where
  // parseSync starts handing back a shape this code reads as zero statements.
  // Every file would "parse", nothing would be broken, and 656 clean files would
  // print. Sabotage found exactly that: canary bypassed plus parseSync stubbed
  // produced a green run over a directory containing `CREATE TABLE (((;`.
  //
  // 5,131 statements today across 656 files. The floor is deliberately far below
  // that — it is asking "is this parser doing anything at all", not policing the
  // corpus size.
  if (statements < 1000) {
    console.error(
      `\n[migrations-parse] FAILED — parsed ${files.length} file(s) but only ` +
        `${statements} statement(s).\n\n` +
        "  That is far too few for this corpus, so the parser is returning\n" +
        "  empty results rather than reading the SQL. Every file would report\n" +
        "  clean, which is what a stubbed or mis-upgraded parser looks like.\n",
    );
    process.exit(1);
  }
  if (broken.length > 0) {
    console.error("\n[migrations-parse] BROKEN SQL:\n");
    for (const b of broken) console.error(`  ${b.file}\n      ${b.message}`);
    console.error(
      "\n  These do not parse as PostgreSQL. Applying one fails partway or not at\n" +
        "  all, depending on where the error is.\n",
    );
    process.exit(1);
  }

  if (!quiet) {
    console.log(
      `✓ migrations parse: ${files.length} file(s), ${statements} statement(s), ` +
        "canary rejected",
    );
  }
}

await main();
