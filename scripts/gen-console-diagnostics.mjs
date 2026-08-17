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
//
// ⚠ RENDERING IS A PURE FUNCTION AND THE WRITE IS BEHIND AN ENTRY-POINT CHECK.
// Both matter, and both were learned the hard way on 2026-08-17. The test
// imports from this module; when the top level called writeFileSync, importing
// it REGENERATED the output before any assertion ran, so a deliberately
// sabotaged header passed five green tests — the guard repaired the thing it
// was checking. And when the "is the checked-in copy current?" case regenerated
// the file itself, it repaired it for the two cases after it, which could then
// never see a bad file either. A guard that fixes its own subject is not a
// guard, and it is the kind that never announces itself.
import { readFileSync, writeFileSync } from "node:fs";

const SRC = "scripts/prod-diagnostics.sql";
const OUT = "scripts/prod-diagnostics-console.sql";

/**
 * The section numbers the source actually defines, read from its own index.
 *
 * ⚠ THIS USED TO BE THE HARDCODED STRING "`§1` … `§13`" and the source had
 * grown to §27. An operator following the header ran thirteen sections and
 * stopped, and the fourteen they skipped are the ones most of the open stories
 * are blocked on — US-2347, US-2288, US-2289, US-2117, US-2444, US-2403,
 * US-2286, US-2606, US-2304, US-2610. A stale count in an instruction is worse
 * than no count, because it reads as completeness.
 *
 * Derived rather than maintained, so it cannot go stale a second time. The
 * index lines look like `--   §14 US-2347 AC1 — …`.
 */
export function sectionNumbers(sql) {
  const nums = [...sql.matchAll(/^--\s+§(\d+)\s+\S/gm)].map((m) => Number(m[1]));
  return [...new Set(nums)].sort((a, b) => a - b);
}

/** Strip psql meta-commands; turn each `\echo` banner into a SQL comment. */
function stripMetaCommands(lines) {
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
  return out;
}

/**
 * The full console-safe file for a given source. PURE — no reads, no writes.
 *
 * The test calls this and compares the result against the checked-in copy, so
 * "is the committed file current?" is answered without producing a current one
 * as a side effect.
 */
export function renderConsoleSql(raw) {
  const crlf = raw.includes("\r\n");
  const lines = (crlf ? raw.split("\r\n").join("\n") : raw).split("\n");
  const out = stripMetaCommands(lines);

  const sections = sectionNumbers(raw);
  if (sections.length === 0) {
    throw new Error(
      "no §N index entries found in the source — the header would claim a range " +
        "it cannot support, which is the defect this derivation exists to prevent",
    );
  }
  const first = sections[0];
  const last = sections[sections.length - 1];
  // A gap means the index and the sections disagree, and the range would
  // overstate what is there. Say so rather than printing a tidy span over a hole.
  const missing = [];
  for (let n = first; n <= last; n++) if (!sections.includes(n)) missing.push(n);

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
    "-- set when you execute a whole file. Run it ONE SECTION AT A TIME — there are",
    `-- ${sections.length}, marked \`§${first}\` … \`§${last}\` — or use psql with the original file,`,
    "-- which prints every result with its banner.",
    ...(missing.length
      ? [
        "--",
        `-- ⚠️ The index skips §${missing.join(", §")}, so the span above is not a`,
        "-- contiguous run. Work from the index, not from the numbers.",
      ]
      : []),
    "--",
    "-- The count above is DERIVED from the source's own index at generation time.",
    "-- It was hardcoded until 2026-08-17 and had been wrong by fourteen sections,",
    "-- which is how an operator runs half the diagnostics and believes they ran all.",
    "--",
    "-- Still strictly read-only: no INSERT, UPDATE, DELETE, CREATE, ALTER or DROP.",
    "-- ══════════════════════════════════════════════════════════════════",
    "",
  ];

  const body = header.concat(out).join("\n").replace(/\n{3,}/g, "\n\n");
  return crlf ? body.split("\n").join("\r\n") : body;
}

if (process.argv[1]?.endsWith("gen-console-diagnostics.mjs")) {
  const body = renderConsoleSql(readFileSync(SRC, "utf8"));
  writeFileSync(OUT, body);
  console.log(`wrote ${OUT} (${body.split("\n").length} lines, no meta-commands)`);
}
