// US-1716 — every seeded brand fact carries provenance.
//
// THE GUARANTEE, from brand-seed.ts's own header: "Every fact seeded into the
// brand knowledge base MUST carry a source and a calibrated confidence — an
// unsourced 'fact' is a guess wearing a citation's clothes, and the whole point
// of the KB is to be MORE trustworthy than the model's memory, not to launder
// guesses into the prompt."
//
// NOTHING ENFORCED IT. Triaged 2026-07-19 via scripts/audit-unwired-exports.mjs:
//
//   • brand-seed.ts declares itself "the gate" that every seed run passes
//     through — and has ZERO callers. It cannot gate anything.
//   • It never could. Brand facts are seeded by SQL MIGRATIONS (37 of them,
//     178 insert statements), which cannot call a TypeScript validator. The
//     gate was written for a seeding path that was never built.
//   • The schema does not enforce it either: 00389 declares `source_url text`
//     — NULLABLE. `confidence` has a range CHECK but no NOT NULL.
//
// So the only thing standing between the KB and an unsourced fact was author
// discipline across 37 hand-written migrations. Measured before writing this:
// 178 of 178 inserts list source_url. The discipline held perfectly — which is
// exactly when to install the ratchet, while it costs nothing.
//
// WHY IT MATTERS MORE HERE THAN IT LOOKS: brand_knowledge grounds authenticity
// assessments. An unsourced row does not announce itself at read time; it reads
// like every other fact, and it makes the model MORE confident, not less. The
// failure mode is a fabricated tell presented with the same authority as a
// verified one.
//
// SCOPE: this checks the insert COLUMN LIST, not the values. A migration listing
// source_url and passing NULL for a row would pass here. That is a deliberate
// stopping point — column presence is the mechanical part a reviewer misses,
// whereas a deliberate NULL is a choice someone made and can be seen in review.

import { assert, assertEquals } from "@std/assert";

const MIGRATIONS = new URL("../../../../supabase/migrations/", import.meta.url);

/** Brand-KB tables whose rows are facts that ground a model's assessment. */
const FACT_TABLE = /brand|tell|decoder|pack/i;

Deno.test("US-1716: every brand-knowledge insert carries source_url", async () => {
  const offenders: string[] = [];
  let files = 0;
  let inserts = 0;

  for await (const entry of Deno.readDir(MIGRATIONS)) {
    if (!entry.isFile || !entry.name.endsWith(".sql")) continue;
    if (!/brand_knowledge|brand-knowledge/.test(entry.name)) continue;
    files++;
    const sql = await Deno.readTextFile(new URL(entry.name, MIGRATIONS));

    for (const m of sql.matchAll(/insert\s+into\s+public\.(\w+)\s*\(([^)]*)\)\s*values/gi)) {
      const table = m[1]!;
      const cols = m[2]!.replace(/\s+/g, " ").toLowerCase();
      if (!FACT_TABLE.test(table)) continue;
      inserts++;
      if (!cols.includes("source_url")) {
        const line = sql.slice(0, m.index).split("\n").length;
        offenders.push(`${entry.name}:${line} — insert into ${table} omits source_url`);
      }
    }
  }

  // Both counts are asserted: a walker that finds no files, or a regex that
  // matches no inserts, would otherwise report a clean tree while inspecting
  // nothing — the failure mode this repo keeps hitting with source guards.
  assert(files >= 30, `expected the brand-knowledge migrations, found ${files}`);
  assert(inserts >= 100, `expected brand fact inserts, found ${inserts}`);

  assertEquals(
    offenders,
    [],
    "A brand fact without source_url is a guess wearing a citation's clothes — " +
      "and brand_knowledge grounds authenticity assessments, so it makes the " +
      "model more confident rather than less. brand-seed.ts was written to " +
      "prevent this and CANNOT: it has no callers, and SQL seeding cannot call " +
      "a TypeScript validator. The schema does not either (00389: source_url is " +
      "nullable). This check is the only thing enforcing it:\n" +
      offenders.join("\n"),
  );
});
