// US-3163 AC4: vault/30-platform/import-sources.md must list every import
// source with its route, and it must stay listed when a new one ships.
//
// The epic made that an acceptance criterion and SEVEN member stories closed
// without it, so "update the note in the same commit" is not a rule that holds
// by intention. This test holds it for the part of the list that the tree can
// enumerate.
//
// WHAT IS ENUMERABLE, and it is not everything:
//
//   - flipdesk_import_runs.origin: the CHECK constraint in the newest
//     migration that defines it. Every spreadsheet and closet source writes one
//     of these, and BOTH blocked sources (Depop, Etsy) must widen it before
//     they can insert a run. That makes this the exact line a new listing
//     source has to touch, which is what makes it a good hook.
//   - CLOUD_PROVIDER_IDS: every cloud folder provider. isCloudProviderId gates
//     every /api/flipdesk/cloud route, so a third provider cannot arrive
//     anywhere else.
//
// WHAT IS NOT: a source that is neither an import-run origin nor a cloud
// provider (Google Photos, phone capture, the Sheets pull) arrives as a new
// route file and nothing in the tree enumerates it. Those rows are in the note
// and are NOT held by this test, which is stated here rather than left for
// someone to discover from a green run. See mode 9 in the guards-that-do-not-
// guard notes: a scan whose scope is a hand-written list is invisible where it
// misses. The scope here is derived, the gap is named, and the route check
// below covers every row including the unenumerable ones.
//
// The note's table is delimited by HTML comments so that PROSE about a source
// cannot enter the corpus. Writing "Depop" in the blocked section must not read
// as a shipped row (mode 7). If the markers go missing the parse yields zero
// rows and the floor assertions fail loudly rather than passing clean.

import { assert, assertEquals } from "@std/assert";
import { CLOUD_PROVIDER_IDS } from "../lib/cloud-folder-providers.ts";

const NOTE = new URL(
  "../../../../vault/30-platform/import-sources.md",
  import.meta.url,
);
const MIGRATIONS = new URL("../../../../supabase/migrations/", import.meta.url);
const MAIN_TS = new URL("../main.ts", import.meta.url);

/** Rows are `| \`key\` | source | route | auth | carries | bucket |`. */
interface NoteRow {
  key: string;
  route: string;
}

/**
 * The keyed rows inside the marked table block, and nothing else in the note.
 *
 * The separator row and the header are skipped because neither opens with a
 * backticked key.
 */
async function tableRows(): Promise<NoteRow[]> {
  const md = await Deno.readTextFile(NOTE);
  const start = md.indexOf("<!-- import-sources:table:start -->");
  const end = md.indexOf("<!-- import-sources:table:end -->");
  if (start < 0 || end < 0 || end < start) return [];
  const block = md.slice(start, end);
  const rows: NoteRow[] = [];
  for (const line of block.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("|")) continue;
    const cells = trimmed.split("|").slice(1, -1).map((c) => c.trim());
    if (cells.length < 3) continue;
    const key = cells[0].match(/^`([a-z0-9-]+)`$/);
    if (!key) continue;
    rows.push({ key: key[1], route: cells[2] });
  }
  return rows;
}

/**
 * The origins the LATEST migration touching the constraint permits.
 *
 * Same derivation as closet-import-origin_test.ts: the constraint is dropped
 * and re-added each time it widens, so the newest file is the live definition.
 */
async function permittedOrigins(): Promise<{ file: string; values: string[] }> {
  const names: string[] = [];
  for await (const entry of Deno.readDir(MIGRATIONS)) {
    if (entry.isFile && entry.name.endsWith(".sql")) names.push(entry.name);
  }
  names.sort();

  for (const name of names.reverse()) {
    const sql = await Deno.readTextFile(new URL(name, MIGRATIONS));
    if (!sql.includes("flipdesk_import_runs_origin_check")) continue;
    const match = sql.match(
      /ADD\s+CONSTRAINT\s+flipdesk_import_runs_origin_check\s+CHECK\s*\(\s*origin\s+IN\s*\(([^)]*)\)/i,
    );
    if (!match) continue;
    return {
      file: name,
      values: [...match[1].matchAll(/'([^']+)'/g)].map((m) => m[1]),
    };
  }
  throw new Error(
    "No migration defines flipdesk_import_runs_origin_check: did the constraint get renamed?",
  );
}

/** Every `/api/...` prefix main.ts mounts a router on. */
async function mountedPrefixes(): Promise<string[]> {
  const src = await Deno.readTextFile(MAIN_TS);
  return [...src.matchAll(/app\.route\(\s*"(\/api\/[^"]+)"/g)].map((m) => m[1]);
}

Deno.test("the import-sources note's table parses, and holds every shipped source", async () => {
  const rows = await tableRows();
  // Vacuity floor. Eleven sources shipped when this was written; a parse that
  // silently stops matching reports a count rather than a clean run.
  assert(
    rows.length >= 11,
    `Parsed ${rows.length} rows from the marked table in vault/30-platform/import-sources.md, ` +
      "expected at least 11. Either a source was deleted from the note, or the " +
      "<!-- import-sources:table:start/end --> markers or the `key` column format moved and " +
      "this guard stopped reading anything.",
  );
});

Deno.test("every permitted import-run origin has a row in the note", async () => {
  const { file, values } = await permittedOrigins();
  assert(
    values.length >= 6,
    `${file} parsed to ${values.length} permitted origins, expected at least 6 ` +
      `(got: ${
        values.join(", ") || "none"
      }). The CHECK regex stopped matching.`,
  );
  const keys = new Set((await tableRows()).map((r) => r.key));
  for (const origin of values) {
    assert(
      keys.has(origin),
      `flipdesk_import_runs.origin permits "${origin}" (${file}) but ` +
        "vault/30-platform/import-sources.md has no `" + origin + "` row. " +
        "US-3163 AC4: a new import source gets its row in the same commit that ships it. " +
        "Give it a route, an auth model, what it can carry and which bucket it writes to.",
    );
  }
});

Deno.test("every cloud folder provider has a row in the note", async () => {
  assert(
    CLOUD_PROVIDER_IDS.length >= 2,
    `CLOUD_PROVIDER_IDS holds ${CLOUD_PROVIDER_IDS.length} providers, expected at least 2. ` +
      "Dropbox and OneDrive both shipped in US-3159/US-3160.",
  );
  const keys = new Set((await tableRows()).map((r) => r.key));
  for (const id of CLOUD_PROVIDER_IDS) {
    assert(
      keys.has(id),
      `CLOUD_PROVIDER_IDS includes "${id}" but vault/30-platform/import-sources.md has no ` +
        "`" + id +
        "` row. US-3163 AC4: the note gains the row in the same commit.",
    );
  }
});

Deno.test("every route the note names is still mounted", async () => {
  const prefixes = await mountedPrefixes();
  assert(
    prefixes.length >= 40,
    `main.ts parsed to ${prefixes.length} app.route mounts, expected at least 40. ` +
      "The mount regex stopped matching, so this check proves nothing.",
  );
  const rows = await tableRows();
  let checked = 0;
  for (const row of rows) {
    const paths = [...row.route.matchAll(/\/api\/[A-Za-z0-9/_:-]+/g)].map((m) =>
      m[0]
    );
    assert(
      paths.length > 0,
      `The \`${row.key}\` row names no /api path. Every shipped source has one; a source ` +
        "that does not is not shipped and belongs in the blocked table instead.",
    );
    for (const path of paths) {
      checked++;
      assert(
        prefixes.some((p) => path === p || path.startsWith(p + "/")),
        `The \`${row.key}\` row points at ${path}, which main.ts mounts no router on. ` +
          "Either the mount moved and the note is now wrong, or the path has a typo. " +
          `Mounted prefixes under /api/flipdesk: ${
            prefixes.filter((p) => p.startsWith("/api/flipdesk")).join(", ")
          }`,
      );
    }
  }
  // A row whose route cell parsed to nothing would skip the loop above in
  // silence; assert the work actually happened.
  assertEquals(
    checked >= rows.length,
    true,
    `Checked ${checked} routes across ${rows.length} rows, fewer than one per row.`,
  );
});
