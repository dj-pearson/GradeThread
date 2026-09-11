// US-3359: the SEED half of the second-opinion switch.
//
// These live in their own file because the migration they check was HELD on a
// branch for a while. Leaving them in second-opinion_test.ts made main red for a
// migration main did not carry, which is a guard failing for the right reason at
// the wrong time.
//
// RESOLVED 2026-09-11. A parallel session shipped the same seed as
// 00790_grading_second_opinion_setting.sql and prod applied it, so the held
// branch was redundant and was deleted. These guards now run on main and check
// that file. They are kept in their own file rather than folded back, because
// they read the migrations directory and the rest of second-opinion_test.ts
// reads only code.
import { assert, assertStringIncludes } from "@std/assert";
import "./_env.ts";

const { DEFAULT_SECOND_OPINION_CONFIG } = await import("../lib/second-opinion.ts");

// ── The switch has to EXIST (US-3359) ───────────────────────────────────────
//
// This is the bug the whole story is about, and it is invisible from the code:
// every guard above passed for three weeks while the pass could not run, because
// admin-settings.ts answers PUT /:key with 404 when no row exists and
// system_settings rows are only ever created by a migration. A feature switch
// with no seed row is a feature with no switch.

const MIGRATIONS_DIR = new URL("../../../../supabase/migrations/", import.meta.url);

async function migrationsMentioning(needle: string): Promise<string[]> {
  const hits: string[] = [];
  for await (const entry of Deno.readDir(MIGRATIONS_DIR)) {
    if (!entry.isFile || !entry.name.endsWith(".sql")) continue;
    const sql = await Deno.readTextFile(new URL(entry.name, MIGRATIONS_DIR));
    if (sql.includes(needle)) hits.push(entry.name);
  }
  return hits.sort();
}

Deno.test("US-3359: a migration seeds the grading_second_opinion settings row", async () => {
  const hits = await migrationsMentioning("'grading_second_opinion'");
  assert(
    hits.length > 0,
    "no migration seeds system_settings.grading_second_opinion, so the second-opinion " +
      "pass has no switch: admin-settings.ts PUT /:key 404s on a key with no row",
  );
});

Deno.test("US-3359: the seed leaves an operator's existing row alone", async () => {
  // Nobody could prove the row's absence on prod before this was written --
  // system_settings is revoked from anon, so it is missing from PostgREST's anon
  // OpenAPI document, and absence there means "not visible", not "not there".
  // An upsert would have overwritten a hand-seeded row, including one somebody
  // had turned ON.
  const [seed] = await migrationsMentioning("'grading_second_opinion'");
  assert(seed, "the seed migration is missing");
  const sql = await Deno.readTextFile(new URL(seed, MIGRATIONS_DIR));
  assertStringIncludes(sql.toLowerCase(), "on conflict (key) do nothing");
});

Deno.test("US-3359: the seeded row is DISABLED and matches the code defaults", async () => {
  // Applying a migration must never start paying for a second model pass. The
  // band and epsilon are checked too: a seed that disagreed with
  // DEFAULT_SECOND_OPINION_CONFIG would silently become the real config the
  // moment somebody flipped enabled, and the code default would be a lie.
  const [seed] = await migrationsMentioning("'grading_second_opinion'");
  assert(seed, "the seed migration is missing");
  const body = (await Deno.readTextFile(new URL(seed, MIGRATIONS_DIR)))
    .replace(/^\s*--.*$/gm, "");
  assertStringIncludes(body, "'enabled',      false");
  assertStringIncludes(body, `'bandMin',      ${DEFAULT_SECOND_OPINION_CONFIG.bandMin}`);
  assertStringIncludes(body, `'bandMax',      ${DEFAULT_SECOND_OPINION_CONFIG.bandMax}`);
  assertStringIncludes(body, `'epsilon',      ${DEFAULT_SECOND_OPINION_CONFIG.epsilon}`);
  assertStringIncludes(body, `'model',        '${DEFAULT_SECOND_OPINION_CONFIG.model}'`);
});
