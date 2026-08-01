// US-2214: the drift guard between the in-code sizing charts and the DB seed.
//
// THE FAILURE THIS EXISTS TO PREVENT is silent by construction: the resolver
// falls back to the in-code charts whenever the DB has none, and the fallback
// always returns SOMETHING. So a brand missing from brand_size_charts is
// indistinguishable from one that has a chart, which is how the DB drifted to a
// couple of dozen charts against 292 in code without anyone noticing.
//
// Same remedy this repo already used twice — the shared rubric-factors fixture
// (US-1997) and the grading-standard mirror (US-2107): re-derive the artifact
// and fail when the committed copy no longer matches.
//
//   deno test --allow-env --allow-read src/tests/sizing-chart-parity_test.ts

import { assert, assertEquals } from "@std/assert";

const { SIZING_CHARTS } = await import("../lib/sizing-charts.ts");
const { brandKey } = await import("../lib/brand-normalize.ts");
const { buildSql, chartToValues } = await import(
  "../../../../scripts/gen-sizing-chart-seed.mjs"
);
const { buildSql: buildSystemsSql } = await import(
  "../../../../scripts/gen-size-systems-migration.mjs"
);

const MIGRATION_URL = new URL(
  "../../../../supabase/migrations/00498_sizing_charts_backfill.sql",
  import.meta.url,
);
// The generators emit "\n"; git checks these .sql files out with native line
// endings, so on Windows the committed copy is CRLF and a raw string compare
// reports the whole file as drifted. What this guard is about is the SQL, not
// how the working copy stores newlines — normalize both sides.
const lf = (s: string) => s.replace(/\r\n/g, "\n");

const committed = lf(await Deno.readTextFile(MIGRATION_URL));

Deno.test("US-2214: the committed backfill matches what the code generates", async () => {
  // The whole guard in one assertion. If someone edits sizing-charts.ts and does
  // not re-run scripts/gen-sizing-chart-seed.mjs, this fails here rather than
  // silently in prod as a fallback nobody looks at.
  assertEquals(
    buildSql(SIZING_CHARTS),
    committed,
    "00498 is stale — regenerate: deno run --allow-read --allow-write scripts/gen-sizing-chart-seed.mjs",
  );
  await Promise.resolve();
});

Deno.test("US-2214: every in-code chart has a row in the backfill", () => {
  for (const chart of SIZING_CHARTS) {
    const key = brandKey(chart.brand);
    const tuple = chartToValues(chart);
    assert(
      committed.includes(tuple),
      `no backfill row for ${key} | ${chart.department} | ${chart.garment}`,
    );
  }
});

Deno.test("US-2214: the backfill row count equals the in-code chart count", () => {
  // Guards the other direction: a row for a chart that no longer exists.
  const rowLines = committed
    .split("\n")
    .filter((l) => /^ {2}\('/.test(l));
  assertEquals(rowLines.length, SIZING_CHARTS.length);
});

Deno.test("US-2214: chart keys are unique, so no row can be silently dropped", () => {
  // brand_size_charts_key_idx is (brand_key, department, garment) and the insert
  // is ON CONFLICT DO NOTHING — a duplicate triple in code would vanish into the
  // conflict clause instead of failing loudly.
  const seen = new Set<string>();
  for (const chart of SIZING_CHARTS) {
    const key = `${brandKey(chart.brand)}|${chart.department}|${chart.garment}`;
    assert(!seen.has(key), `duplicate chart key: ${key}`);
    seen.add(key);
  }
  assertEquals(seen.size, SIZING_CHARTS.length);
});

Deno.test("US-2214: the backfill never overwrites a hand-sourced pack row", () => {
  // The hand-written packs (00447 onward) carry real source_url + confidence.
  // This backfill has neither, so it must yield to them on conflict.
  assert(
    committed.includes("on conflict (brand_key, department, garment) do nothing"),
    "the backfill must not overwrite sourced pack rows",
  );
});

Deno.test("US-2214: backfilled rows claim no provenance they do not have", () => {
  // verified=false / confidence NULL / source_url NULL is the honest state: the
  // in-code seed carries no per-chart provenance to copy, and inventing one
  // would make an unreviewed chart look reviewed.
  for (const line of committed.split("\n").filter((l) => /^ {2}\('/.test(l))) {
    assert(
      line.includes("NULL, NULL, false,"),
      `a backfill row claims provenance it does not have: ${line.slice(0, 80)}`,
    );
  }
});

Deno.test("US-2214: the migration carries the US-1108 self-record footer", () => {
  assert(
    committed.includes(
      "insert into public.applied_migrations (version) values ('00498')",
    ),
  );
});

Deno.test("US-2214: no chart's JSON can break out of its dollar quote", () => {
  // chartToValues throws on the delimiter; prove it stays true for real data.
  for (const chart of SIZING_CHARTS) {
    assert(!JSON.stringify(chart.rows).includes("$json$"));
  }
});

Deno.test("US-2214: single quotes in notes and brands are escaped", () => {
  const withQuote = SIZING_CHARTS.filter((c) =>
    c.brand.includes("'") || (c.note ?? "").includes("'")
  );
  // Levi's alone guarantees this is a non-empty sample.
  assert(withQuote.length > 0, "expected at least one apostrophe in the corpus");
  for (const chart of withQuote) {
    // Strip the dollar-quoted JSON FIRST. Apostrophes inside $json$...$json$
    // are literal and must NOT be doubled — that is the whole point of dollar
    // quoting — so counting quotes across the raw tuple mis-reports every chart
    // whose measurement data contains one (Brahmin's does).
    const tuple = chartToValues(chart).replace(/\$json\$[\s\S]*?\$json\$/g, "JSON");
    const quotes = (tuple.match(/'/g) ?? []).length;
    assertEquals(quotes % 2, 0, `unbalanced quoting for ${chart.brand}`);
  }
});

Deno.test("US-2214: dollar-quoted JSON is what carries apostrophes safely", () => {
  // The complement of the test above, pinning WHY it strips: at least one real
  // chart's row data contains an apostrophe, and it is correct for that one to
  // reach the SQL undoubled because it sits inside a dollar quote.
  const inJson = SIZING_CHARTS.filter((c) => JSON.stringify(c.rows).includes("'"));
  assert(inJson.length > 0, "expected an apostrophe inside some chart's rows");
  for (const chart of inJson) {
    const tuple = chartToValues(chart);
    const json = tuple.slice(tuple.indexOf("$json$"), tuple.lastIndexOf("$json$"));
    assert(json.includes("'"), "the apostrophe should survive undoubled");
    assert(!json.includes("''"), "and must NOT be doubled inside a dollar quote");
  }
});

// ── AC5: the DB-first path is actually wired ───────────────────────────────

Deno.test("US-2214: estimateSize prefers resolved (DB-first) charts over the in-code seed", async () => {
  // THE GAP THIS CLOSES: estimateSize read findSizingCharts() directly, so
  // brand_size_charts reached resolveBrandKnowledgePack and stopped there —
  // fixing a wrong chart in the admin UI changed nothing about sizing. The
  // source is checked rather than the behaviour because exercising the call
  // needs a vision request.
  const src = await Deno.readTextFile(
    new URL("../lib/ai-size-estimate.ts", import.meta.url),
  );
  assert(
    /input\.charts && input\.charts\.length > 0/.test(src),
    "estimateSize must prefer caller-supplied charts",
  );
  assert(
    src.includes("findSizingCharts(input.brand, input.category)"),
    "...and must still fall back to the in-code seed when none are supplied",
  );
});

Deno.test("US-2214: the grading pipeline passes the pack's charts to the size call", async () => {
  const src = await Deno.readTextFile(
    new URL("../lib/grading-pipeline.ts", import.meta.url),
  );
  assert(
    src.includes("charts: brandPack?.sizingCharts ?? []"),
    "the pipeline must hand estimateSize the DB-first charts",
  );
});

Deno.test("US-2214: the in-code fallback is observable when it fires", async () => {
  // The fallback always returns SOMETHING, which is why the drift was silent
  // for so long. It must now say so.
  const src = await Deno.readTextFile(
    new URL("../lib/brand-knowledge.ts", import.meta.url),
  );
  assert(
    src.includes("came from the IN-CODE"),
    "resolveBrandKnowledgePack must warn when charts fall back to code",
  );
});

// ── US-2215: the size_system / size_class migration is generated too ───────

Deno.test("US-2215: the committed 00499 matches what the code generates", async () => {
  const committed499 = lf(
    await Deno.readTextFile(
      new URL("../../../../supabase/migrations/00499_size_systems.sql", import.meta.url),
    ),
  );
  assertEquals(
    buildSystemsSql(SIZING_CHARTS),
    committed499,
    "00499 is stale — regenerate: deno run --allow-read --allow-write scripts/gen-size-systems-migration.mjs",
  );
});

Deno.test("US-2215: 00499 only ADDS columns and fills them", async () => {
  const sql = await Deno.readTextFile(
    new URL("../../../../supabase/migrations/00499_size_systems.sql", import.meta.url),
  );
  assert(sql.includes("add column if not exists size_system text"));
  assert(sql.includes("add column if not exists size_class  text"));
  assert(
    sql.includes("insert into public.applied_migrations (version) values ('00499')"),
  );
  // It must not rewrite the charts themselves: the size labels and notes are
  // what the model reads, and re-authoring 115 of them deserves its own eval.
  assert(!/update[\s\S]*set[\s\S]*\brows\b\s*=/i.test(sql), "00499 must not rewrite chart rows");
  assert(!/set[\s\S]*\bnote\s*=/i.test(sql), "00499 must not rewrite chart notes");
});
