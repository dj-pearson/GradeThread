// US-3261: the closet-import platform list and the origin CHECK constraint have
// to agree, and for months they did not.
//
// US-3155 added "grailed" to CLOSET_IMPORT_PLATFORMS. The route writes
// `origin: platform` into flipdesk_import_runs, whose CHECK (00712) listed five
// values. Every Grailed import therefore failed at the INSERT, and the seller
// read "Could not start the import." — a message that names neither the cause
// nor the fix.
//
// Nothing in the build could see that: the constant is TypeScript, the
// constraint is SQL, and no test read both. This one does. Adding a sixth
// platform to the constant without widening the constraint now fails here
// rather than in production.

import { assert } from "@std/assert";
import { CLOSET_IMPORT_PLATFORMS } from "../lib/closet-import.ts";

/**
 * The values the LATEST migration touching the constraint permits.
 *
 * Read from the highest-numbered migration that defines
 * flipdesk_import_runs_origin_check, because the constraint is dropped and
 * re-added each time it widens — the newest file is the live definition.
 */
async function permittedOrigins(): Promise<{ file: string; values: string[] }> {
  const dir = new URL("../../../../supabase/migrations/", import.meta.url);
  const names: string[] = [];
  for await (const entry of Deno.readDir(dir)) {
    if (entry.isFile && entry.name.endsWith(".sql")) names.push(entry.name);
  }
  names.sort();

  for (const name of names.reverse()) {
    const sql = await Deno.readTextFile(new URL(name, dir));
    if (!sql.includes("flipdesk_import_runs_origin_check")) continue;
    // The ADD CONSTRAINT ... CHECK (origin IN (...)) list.
    const match = sql.match(
      /ADD\s+CONSTRAINT\s+flipdesk_import_runs_origin_check\s+CHECK\s*\(\s*origin\s+IN\s*\(([^)]*)\)/i,
    );
    if (!match) continue;
    const values = [...match[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
    return { file: name, values };
  }
  throw new Error(
    "No migration defines flipdesk_import_runs_origin_check — did the constraint get renamed?",
  );
}

Deno.test("every closet-import platform is a permitted import-run origin", async () => {
  const { file, values } = await permittedOrigins();
  for (const platform of CLOSET_IMPORT_PLATFORMS) {
    assert(
      values.includes(platform),
      `CLOSET_IMPORT_PLATFORMS includes "${platform}" but ${file} does not permit it as ` +
        `flipdesk_import_runs.origin (permitted: ${values.join(", ")}). ` +
        "The closet-import route writes origin: platform, so this platform's imports " +
        "cannot start. Widen the CHECK in a new migration carrying the US-1108 triple.",
    );
  }
});

Deno.test("the spreadsheet origins are still permitted", async () => {
  const { values } = await permittedOrigins();
  for (const origin of ["csv", "sheet", "paste"]) {
    assert(
      values.includes(origin),
      `A widening migration dropped "${origin}" from the origin CHECK; the CSV importer ` +
        "(US-2518) writes it.",
    );
  }
});
