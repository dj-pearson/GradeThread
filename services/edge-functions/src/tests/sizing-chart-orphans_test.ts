// US-3387: a chart whose garment scope no longer matches any current naming is
// still in the table, and it competes with the one that replaced it.
//
// THE MECHANISM. The conflict key on every migration that seeds
// brand_size_charts is (brand_key, department, garment). RENAMING a garment
// scope therefore does not update the old row, it inserts a second one, and
// both survive. resolveBrandKnowledgePack reads every row for a brand_key,
// narrows by CATEGORY ONLY (department is not a filter) and keeps the first
// three. So the stale row and its replacement land in the same prompt, and on a
// brand with several charts the stale one pushes a sourced chart out entirely.
//
// 00782 retired 14 of these and was believed exhaustive. It was not, and the
// reason is in how its list was derived: a diff of the ORIGINAL 00498 against
// the regenerated one, which can only ever surface rows 00498 itself seeded.
// Measured 2026-09-11 over the reconstructed table: 49 of 464 rows have no
// counterpart in sizing-charts.ts, and in 58 brand/category probes an orphan
// sits inside the 3-chart budget while a sourced chart is cut from it.
//
//   deno test --allow-read --allow-env src/tests/sizing-chart-orphans_test.ts
//
// WHY A REGISTRY. "No counterpart in the code corpus" is not the same as
// "stale". 15 of the 49 are hand-written charts that were never generated from
// code and have no rival at all, and 11 more differ from their only rival by
// DEPARTMENT, which is a re-scoping question a delete would answer wrongly.
// Only the 23 with a surviving SAME-brand, SAME-department sibling are renames.
// Each of the other 26 carries its reason below, and like knownNoise in
// check-ui-antipatterns.mjs and DB_ONLY in verified-chart-parity_test.ts, an
// entry that stops matching also fails, so the list can only shrink.
//
// THE IDS BELOW ARE TABLE DATA, NOT PROSE. A few garment scopes contain an em
// dash, an en dash or a double-headed arrow because that is what 00472, 00574
// and 00776 wrote into the column. They are compared, never read, so they have
// to be byte-exact; this is the deliberate exception to the ASCII rule.
//
// THE MODEL USES THE CURRENT 00498, PROD APPLIED THE ORIGINAL. 00498 is
// regenerated in place on every corpus change and apply-prod-migrations skips
// every file at or below the highest recorded version, so prod still holds the
// 2026-07-29 version. The two differ by exactly 14 tuples, and those 14 are
// exactly what 00782 deletes (measured 2026-09-11), so the model and prod agree
// today. If 00498 is regenerated again without a matching retirement, they will
// not, and this guard will be reading a table production does not have.

import { assert, assertEquals } from "@std/assert";

const { SIZING_CHARTS } = await import("../lib/sizing-charts.ts");
const { brandKey } = await import("../lib/brand-normalize.ts");

const MIGRATIONS_DIR = new URL("../../../../supabase/migrations/", import.meta.url);

/**
 * The 23 renames 00793 retires. THE MIGRATION IS HELD on a branch awaiting the
 * owner, so main's model still carries every one of them, and this list is
 * deliberately what the assertion expects: it fails the moment that branch
 * lands, which is the signal to DELETE the list. It also fails if any OTHER
 * unregistered orphan appears, so holding one retirement does not buy silence
 * for the next.
 */
const HELD_BY_00793: string[] = [
  "arcteryx|men|bottoms (alpha, body inches converted from the brand's cm)",
  "arcteryx|women|bottoms (alpha, body inches converted from the brand's cm)",
  "beyondyoga|women|bottoms",
  "dickies|men|tops & outerwear (alpha, body inches)",
  "duluthtradingco|men|tops & outerwear (alpha, body inches)",
  "fabletics|women|bottoms",
  "gymshark|women|bottoms",
  "levis|men|tops & outerwear (alpha, body inches)",
  "levis|women|tops, outerwear & dresses (alpha, body inches)",
  "luckybrand|men|tops & outerwear (alpha, body inches)",
  "luckybrand|women|tops, outerwear & dresses (alpha/numeric, body inches)",
  "madewell|women|tops & outerwear (alpha/numeric, body inches)",
  "skims|women|tops & outerwear (alpha/numeric, body inches)",
  "sweatybetty|women|bottoms",
  "tommyhilfiger|men|bottoms (waist tag 28-50 — the number is the tag, not the body)",
  "tommyhilfiger|men|outerwear (alpha, body inches)",
  "tommyhilfiger|women|bottoms (alpha/numeric, body inches)",
  "tommyhilfiger|women|outerwear (alpha/numeric, body inches)",
  "truereligion|men|tops & outerwear (alpha, body inches)",
  "truereligion|women|tops & outerwear (alpha, body inches)",
  "underarmour|women|bottoms",
  "vuori|men|bottoms",
  "vuori|women|bottoms",
];

/**
 * Orphans whose only rival is in a DIFFERENT department. A rename keeps the
 * department; these did not, so retiring one would delete a body's only chart
 * rather than a duplicate. Each entry is a re-scoping question for a human.
 */
const CROSS_DEPARTMENT: Record<string, string> = {
  "fabletics|men|tops":
    "Fabletics' MEN'S tops chart, from 00452. The corpus kept only a " +
    "women's tops chart and a women's bottoms chart, so every rival this " +
    "row has is a women's body. A men's chart is not a stale rename of a " +
    "women's one.",
  "gymshark|men|bottoms":
    "Gymshark's MEN'S bottoms chart, from 00452. Its only rival is the " +
    "women's bottoms chart, which is a different body.",
  "llbean|women|tops":
    "L.L.Bean's WOMEN'S tops chart, from 00452/00453. The corpus kept the " +
    "men's tops chart and dropped this one, so retiring it would leave " +
    "L.L.Bean womenswear with no tops reference at all.",
  "marmot|women|tops":
    "Marmot's WOMEN'S tops chart, same shape as L.L.Bean: the only rival is " +
    "the men's tops chart.",
  "mountainhardwear|women|tops":
    "Mountain Hardwear's WOMEN'S tops chart, same shape as L.L.Bean.",
  "reicoop|women|tops":
    "REI Co-op's WOMEN'S tops chart. 00781 replaced the MEN'S approximation " +
    "with REI's own published chart and left this one alone, so the only " +
    "rival is a men's body.",
  "stssy|unisex|bottoms (alpha + waist tag, body inches)":
    "00776 seeded Stussy as UNISEX; 00781's sourced chart is filed under " +
    "MEN. Whether the men's chart covers women's sizing is a re-scoping " +
    "decision, not a rename, so the unisex row stays until someone makes " +
    "it.",
  "stssy|unisex|outerwear (alpha, body inches, with the brand's own conversions)":
    "The other half of the same Stussy re-scope. See the bottoms entry.",
  "thenorthface|unisex|bottoms (waist tag 28-44 with an alpha beside it, body inches)":
    "00776 seeded The North Face as UNISEX; 00781 split it into Men and " +
    "Women. Same re-scoping question as Stussy, and the same answer: not " +
    "this story's.",
  "thenorthface|unisex|tops (alpha, body inches)":
    "The other half of the same North Face re-scope. See the bottoms entry.",
  "underarmour|women|tops":
    "Under Armour's WOMEN'S tops chart, from 00452. Its only rival is the " +
    "men's tops chart from the same migration.",
};

/**
 * Orphans with no rival at all: hand-written charts that were never generated
 * from sizing-charts.ts. Deleting one removes the brand's only reference.
 */
const DB_ONLY: Record<string, string> = {
  "fjallraven|men|apparel (eu numeric ↔ us alpha, body inches)":
    "UNREACHABLE, and that is the finding. canonicalizeBrand('Fjallraven') " +
    "returns 'Fjallraven' with the umlauts, whose brandKey strips them to " +
    "'fjllrven' -- which 00498 seeded separately with the same two charts. " +
    "No input produces the key 'fjallraven', so this 00472 row is never " +
    "read. Dead weight, not a rival.",
  "fjallraven|women|apparel (eu numeric ↔ us alpha, body inches)":
    "The women's half of the same unreachable Fjallraven pair. See above.",
  "golfshoewidth|men|golf shoe widths (letter axis)":
    "Shoe width: a letter axis, not a measurement the size checker bands. " +
    "Already registered DB_ONLY in verified-chart-parity_test.ts.",
  "goorinbros|unisex|hats (alpha xs–xxl)":
    "Headwear: head circumference, no garment band. Already registered " +
    "DB_ONLY in verified-chart-parity_test.ts.",
  "kangol|unisex|hats (alpha s–xxl)":
    "Headwear: head circumference, no garment band. Already registered " +
    "DB_ONLY in verified-chart-parity_test.ts.",
  "kuhl|men|apparel (us alpha tops; pants by waist inch)":
    "UNREACHABLE, same shape as Fjallraven: canonicalizeBrand('Kuhl') " +
    "returns the umlauted spelling, whose brandKey is 'khl', and 00498 " +
    "holds that key. Nothing can read the 'kuhl' rows 00472 wrote.",
  "kuhl|women|apparel (us alpha, body inches)":
    "The women's half of the same unreachable Kuhl pair. See above.",
  "newera|unisex|caps (fitted 59fifty, eighth-inch sizes)":
    "Headwear: head circumference, no garment band. Already registered " +
    "DB_ONLY in verified-chart-parity_test.ts.",
  "newera|unisex|caps (stretch-fit 39thirty / adjustable 9fifty)":
    "Headwear: head circumference, no garment band. Already registered " +
    "DB_ONLY in verified-chart-parity_test.ts.",
  "stetson|unisex|hats (us hat sizes)":
    "Headwear: head circumference, no garment band. Already registered " +
    "DB_ONLY in verified-chart-parity_test.ts.",
  "tailoringmenswear|men|dress shirts (neck x sleeve)":
    "A synthetic key, not a brand: the generic menswear tailoring tables " +
    "00581 seeded. No brand text canonicalizes to it, so only a direct " +
    "lookup reads it and nothing competes with it.",
  "tailoringmenswear|men|jacket length letters (s / r / l)":
    "The jacket-length half of the same 00581 tailoring set. See above.",
  "tailoringmenswear|men|suits & sport coats (jacket chest, with 6-drop trouser waist)":
    "The suits half of the same 00581 tailoring set. See above.",
  "vince|women|tops & knits (us alpha)":
    "Vince has no chart in sizing-charts.ts at all, so this 00457 row is " +
    "the brand's only size reference and there is nothing for it to compete " +
    "with.",
  "westernbootwidth|men|boot widths (letter axis)":
    "Shoe width: a letter axis. Already registered DB_ONLY in " +
    "verified-chart-parity_test.ts.",
};

// -- the model: the table as the migrations leave it -------------------------
//
// Parsers lifted from sizing-chart-brand-token_test.ts (US-3324), where both of
// their traps are already paid for: scanning from the first mention of the table
// to EOF invents charts out of the brand_styles and brand_colorways rows that
// share the tuple shape, and a cheap tuple regex that stops at the first inner
// parenthesis models 3 of 00782's 14 deletes, because eleven of those garment
// names contain a parenthesis.

const ROW_RE =
  /\(\s*'((?:[^']|'')*)'\s*,\s*'((?:[^']|'')*)'\s*,\s*ARRAY\[([^\]]*)\]::text\[\]\s*,\s*'((?:[^']|'')*)'\s*,\s*'((?:[^']|'')*)'/g;
const INSERT_RE =
  /insert\s+into\s+public\.brand_size_charts\s*\([^)]*\)\s*values\s*([\s\S]*?)\n\s*on\s+conflict/gi;
const DELETE_RE =
  /delete\s+from\s+public\.brand_size_charts\b[\s\S]*?using\s*\(\s*values\s*([\s\S]*?)\)\s*as\s+v\s*\(([^)]*)\)/gi;
const CATEGORY_RE = /^\s*,\s*ARRAY\[([^\]]*)\]::text\[\]/;
const LITERAL_RE = /'((?:[^']|'')*)'/g;

const unquote = (s: string) => s.replace(/''/g, "'");

/** Top-level parenthesised tuples out of a VALUES list, quote-aware. */
function tuplesOf(values: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let inQuote = false;
  let current = "";
  for (let i = 0; i < values.length; i++) {
    const ch = values[i]!;
    if (inQuote) {
      current += ch;
      if (ch === "'") {
        if (values[i + 1] === "'") {
          current += "'";
          i++;
        } else {
          inQuote = false;
        }
      }
      continue;
    }
    if (ch === "'") {
      inQuote = true;
      current += ch;
      continue;
    }
    if (ch === "(") {
      depth++;
      if (depth === 1) {
        current = "";
        continue;
      }
    }
    if (ch === ")") {
      depth--;
      if (depth === 0) {
        out.push(current);
        current = "";
        continue;
      }
    }
    if (depth > 0) current += ch;
  }
  return out;
}

interface Chart {
  brandKey: string;
  department: string;
  garment: string;
  categories: string[];
  where: string;
}

/**
 * THE RETIREMENT ITSELF IS THE ONE THING THIS GUARD CANNOT ASSUME. 00793 is
 * HELD: it sits on a branch until the owner applies it, so main's migration
 * directory does not carry it and the model built from main still holds all 23
 * rows. A guard whose expectation flips with the file's presence is a guard
 * that has to be edited twice.
 *
 * So the census below runs on `preRetirement` -- every migration applied EXCEPT
 * this one's delete -- which is the same set in both states and is also the set
 * the scoping proof needs. `dbCharts` applies everything, and the last case
 * checks the two against each other whichever state the tree is in.
 */
const RETIREMENT = "00793_retire_renamed_size_chart_orphans.sql";

const dbCharts = new Map<string, Chart>();
const preRetirement = new Map<string, Chart>();
const retiredByThisStory: string[] = [];
let deleteFiles = 0;
let deletesParsed = 0;

const files: string[] = [];
for await (const entry of Deno.readDir(MIGRATIONS_DIR)) {
  if (entry.isFile && entry.name.endsWith(".sql")) files.push(entry.name);
}
files.sort(); // NNNNN order, so the last writer wins
const retirementPresent = files.includes(RETIREMENT);

for (const name of files) {
  const sql = await Deno.readTextFile(new URL(name, MIGRATIONS_DIR));
  INSERT_RE.lastIndex = 0;
  let ins: RegExpExecArray | null;
  while ((ins = INSERT_RE.exec(sql))) {
    const values = ins[1]!;
    ROW_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = ROW_RE.exec(values))) {
      const key = unquote(m[1]!);
      const department = unquote(m[4]!);
      const garment = unquote(m[5]!);
      // category_match is the ARRAY[...] immediately after the garment.
      const cats = CATEGORY_RE.exec(values.slice(m.index + m[0].length));
      const id = [key, department, garment].join("|").toLowerCase();
      const chart: Chart = {
        brandKey: key,
        department,
        garment,
        categories: cats
          ? [...cats[1]!.matchAll(LITERAL_RE)].map((x) => unquote(x[1]!))
          : [],
        where: name,
      };
      dbCharts.set(id, chart);
      preRetirement.set(id, chart);
    }
  }

  if (/delete\s+from\s+public\.brand_size_charts\b/i.test(sql)) deleteFiles++;
  DELETE_RE.lastIndex = 0;
  let d: RegExpExecArray | null;
  while ((d = DELETE_RE.exec(sql))) {
    const columns = d[2]!.split(",").map((c) => c.trim().toLowerCase());
    const ki = columns.indexOf("brand_key");
    const di = columns.indexOf("department");
    const gi = columns.indexOf("garment");
    if (ki === -1 || di === -1 || gi === -1) continue;
    for (const tuple of tuplesOf(d[1]!)) {
      const values = [...tuple.matchAll(LITERAL_RE)].map((x) => unquote(x[1]!));
      if (values.length !== columns.length) continue;
      const id = [values[ki], values[di], values[gi]].join("|").toLowerCase();
      if (dbCharts.delete(id)) deletesParsed++;
      if (name === RETIREMENT) retiredByThisStory.push(id);
      else preRetirement.delete(id);
    }
  }
}

const codeIds = new Set(
  SIZING_CHARTS.map((c) =>
    [brandKey(c.brand), c.department, c.garment].join("|").toLowerCase()
  ),
);

const orphansOf = (model: Map<string, Chart>) =>
  [...model.entries()]
    .filter(([id]) => !codeIds.has(id))
    .map(([id, chart]) => ({ id, chart }));

const orphans = orphansOf(preRetirement);

// -- the guards --------------------------------------------------------------

Deno.test("US-3387: the parser found the table (guards the guard)", () => {
  // Every assertion below reads as a pass on an empty parse.
  assert(
    preRetirement.size > 300,
    "only " + preRetirement.size + " migration-seeded charts parsed",
  );
  assert(codeIds.size > 300, "only " + codeIds.size + " in-code charts parsed");
  assert(
    deleteFiles === 0 || deletesParsed > 0,
    deleteFiles + " migration(s) delete from brand_size_charts but the delete " +
      "parser matched no row this model holds, and a blind delete parser makes " +
      "the census over-report rather than silently pass",
  );
  // A row with no category tokens cannot be classified, and would read as an
  // orphan with no rival forever.
  assertEquals(
    orphans.filter((o) => o.chart.categories.length === 0).map((o) => o.id),
    [],
    "category_match did not parse for these rows, so the rename test below " +
      "cannot see their rivals",
  );
});

Deno.test("US-3387: every garment scope matches a current naming, or is registered", () => {
  const unregistered = orphans
    .filter((o) => !(o.id in CROSS_DEPARTMENT) && !(o.id in DB_ONLY))
    .map((o) => o.id)
    .sort();

  assertEquals(
    unregistered,
    [...HELD_BY_00793].sort(),
    "A brand_size_charts row's (brand_key, department, garment) matches nothing " +
      "in sizing-charts.ts and nothing accounts for it. Retire it in a migration " +
      "if a same-department sibling supersedes it (and add it to " +
      "HELD_BY_00793's successor), or register it in CROSS_DEPARTMENT / DB_ONLY " +
      "with the reason it stays. This census is taken BEFORE 00793's delete, so " +
      "it reads the same whether or not that migration is on this branch.",
  );
});

Deno.test("US-3387: every held tuple really is a same-department rename", () => {
  // The scoping proof for 00793, checked rather than asserted: a delete is only
  // safe when something else already covers the same brand, the same department
  // and at least one of the same category tokens.
  const notSuperseded: string[] = [];
  for (const id of HELD_BY_00793) {
    const chart = preRetirement.get(id);
    if (!chart) {
      notSuperseded.push(id + " (no longer in the model)");
      continue;
    }
    const superseded = [...preRetirement.entries()].some(([siblingId, s]) =>
      siblingId !== id &&
      codeIds.has(siblingId) &&
      s.brandKey === chart.brandKey &&
      s.department === chart.department &&
      s.categories.some((m) => chart.categories.includes(m))
    );
    if (!superseded) notSuperseded.push(id);
  }
  assertEquals(
    notSuperseded,
    [],
    "00793 deletes these rows. A row with no surviving same-department, " +
      "category-overlapping sibling is not a duplicate -- deleting it removes " +
      "the only chart for that body.",
  );
});

Deno.test("US-3387: every registry entry still matches a row", () => {
  // The list can only shrink. An entry that stops matching is a rule that has
  // quietly stopped being enforced.
  const live = new Set(orphans.map((o) => o.id));
  assertEquals(
    Object.keys(CROSS_DEPARTMENT).filter((id) => !live.has(id)).sort(),
    [],
    "a CROSS_DEPARTMENT entry no longer matches an orphan; delete it",
  );
  assertEquals(
    Object.keys(DB_ONLY).filter((id) => !live.has(id)).sort(),
    [],
    "a DB_ONLY entry no longer matches an orphan; delete it",
  );
});

Deno.test("US-3387: 00793 is either held, or it deletes exactly the held list", () => {
  // THE HELD CONDITION, STATED RATHER THAN ASSUMED. Both states are legal and
  // this case says which one the tree is in, so nobody has to guess whether a
  // quiet result means "fixed" or "the branch is not here".
  const stillOrphaned = orphansOf(dbCharts)
    .filter((o) => !(o.id in CROSS_DEPARTMENT) && !(o.id in DB_ONLY))
    .map((o) => o.id)
    .sort();

  if (!retirementPresent) {
    console.log(
      "[US-3387] " + RETIREMENT + " is HELD and not on this branch, so the " +
        "table still carries all " + HELD_BY_00793.length + " renamed orphans.",
    );
    assertEquals(
      stillOrphaned,
      [...HELD_BY_00793].sort(),
      "the retirement is absent, so the live model must still hold exactly the " +
        "rows it would delete",
    );
    return;
  }

  assertEquals(
    [...retiredByThisStory].sort(),
    [...HELD_BY_00793].sort(),
    RETIREMENT + " and HELD_BY_00793 disagree. They are the same decision " +
      "written twice, so they must name the same rows.",
  );
  assertEquals(
    stillOrphaned,
    [],
    "00793 is on this branch but the table still holds unregistered orphans",
  );
});

Deno.test("US-3387: the in-code corpus carries no duplicate of its own", () => {
  // sizing-charts.ts is the reference everything above measures against, so a
  // duplicate inside it would make the whole census read clean while two charts
  // still competed. Measured 2026-09-11: 0 duplicates across 415 charts, and
  // findSizingCharts("Duluth Trading Co.", "shirt") already returns exactly one.
  const seen = new Map<string, number>();
  for (const c of SIZING_CHARTS) {
    const id = [brandKey(c.brand), c.department, c.garment].join("|").toLowerCase();
    seen.set(id, (seen.get(id) ?? 0) + 1);
  }
  assertEquals(
    [...seen].filter(([, n]) => n > 1).map(([id]) => id),
    [],
    "sizing-charts.ts holds the same (brand, department, garment) twice",
  );
});
