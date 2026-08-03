// Generate a SQL-console-safe copy of scripts/prod-diagnostics.sql.
//
// THE BUG THIS FIXES, reported by the operator: pasting the script into a SQL
// editor fails at line 39 with `syntax error at or near "\"`. Those backslash
// lines (\pset, \timing, \echo) are PSQL META-COMMANDS — the client interprets
// them and never sends them to the server. A SQL console has no client-side
// interpreter, so it forwards them to Postgres, which rejects the first one.
//
// The script's header says to run it with `psql -f`, and I verified it that way.
// That verification was correct and did not cover how it would actually be used,
// which is the more useful lesson than the fix: I proved the file worked in the
// mode I chose for it.
//
// This emits the same queries with the meta-commands removed and each banner
// turned into a SQL comment, so the file is valid in any Postgres client.
import { readFileSync, writeFileSync } from "node:fs";

const SRC = "scripts/prod-diagnostics.sql";
const OUT = "scripts/prod-diagnostics-console.sql";

const raw = readFileSync(SRC, "utf8");
const crlf = raw.includes("\r\n");
const lines = (crlf ? raw.split("\r\n").join("\n") : raw).split("\n");

const out = [];
for (const line of lines) {
  if (/^\\(pset|timing|set|x|a|t)\b/.test(line)) continue; // client-only
  const echo = line.match(/^\\echo\s+'(.*)'\s*$/);
  if (echo) {
    const text = echo[1].replace(/''/g, "'");
    out.push(text.trim() === "" ? "" : `-- ${text}`);
    continue;
  }
  if (/^\\/.test(line)) continue; // any other meta-command
  out.push(line);
}

const header = [
  "-- ══════════════════════════════════════════════════════════════════",
  "-- GENERATED — do not edit. Source: scripts/prod-diagnostics.sql",
  "--   node scripts/gen-console-diagnostics.mjs",
  "--",
  "-- Same queries, with psql meta-commands (\\pset, \\timing, \\echo) removed so",
  "-- this is valid in a SQL CONSOLE (Supabase SQL editor, pgAdmin, DBeaver).",
  "-- Those lines are interpreted by the psql CLIENT; a console forwards them to",
  "-- the server, which rejects the first one with:",
  "--   ERROR: 42601: syntax error at or near \"\\\"",
  "--",
  "-- ⚠️ HOW TO RUN THIS IN A CONSOLE. Most SQL editors show only the LAST result",
  "-- set when you execute a whole file. Run it ONE SECTION AT A TIME — the",
  "-- sections are marked `§1` … `§13` — or use psql with the original file,",
  "-- which prints every result with its banner.",
  "--",
  "-- Still strictly read-only: no INSERT, UPDATE, DELETE, CREATE, ALTER or DROP.",
  "-- ══════════════════════════════════════════════════════════════════",
  "",
];

const body = header.concat(out).join("\n").replace(/\n{3,}/g, "\n\n");
writeFileSync(OUT, crlf ? body.split("\n").join("\r\n") : body);
console.log(`wrote ${OUT} (${body.split("\n").length} lines, no meta-commands)`);
