// US-3324: a brand_match token must not be short enough to be another company.
//
// THE MECHANISM, and it is the whole reason this class exists. brandTextMatches
// in sizing-charts.ts is a LEADING-word substring test:
//
//   for (let i = b.indexOf(m); i !== -1; i = b.indexOf(m, i + 1))
//     if (!isWordChar(i === 0 ? "" : b[i - 1])) return true;
//
// There is a boundary on the LEFT and none on the RIGHT. That asymmetry is
// deliberate (US-1738: a bare "gap" must not fire inside "babygap"), and it has
// a consequence nobody wrote down until now: a token is a PREFIX test. So a
// token that is a truncation of its own brand key is, by construction, also a
// prefix of every other company whose name starts the same way.
//
// That is exactly how 'duluth' shipped. Duluth Trading Co.'s pants chart refused
// the bare token and said why in its own note (Duluth Pack, est. 1882, is a
// different company); the US-3284 backfill seeded it on the sibling TOPS chart
// anyway, and it reached production in 00498 and 00781. The rule was known and
// not applied, which is what makes it worth a guard rather than a fix.
//
//   deno test --allow-read --allow-env src/tests/sizing-chart-brand-token_test.ts
//
// ── WHY A REGISTRY AND NOT A BARE RULE (AC4, and the numbers that decide it) ──
//
// Measured 2026-09-11 over the whole corpus, by the model this file builds
// (post-fix numbers, so 'duluth' is already out of both halves):
//
//   in code (sizing-charts.ts)  415 charts, 171 companies, 803 token instances,
//                               331 distinct tokens
//   in the DB (every migration, 464 charts, 181 brand keys / 179 companies,
//    upserts, deletes and         899 token instances, 340 distinct tokens
//    array_removes applied)
//
// Of those, 143 distinct code tokens are 8 characters or shorter. A rule on
// LENGTH ALONE would therefore flag 143 tokens to catch one defect, because
// almost every short token is simply the brand's whole name: nike, zara, puma,
// vans, h&m, kith, bape. Length is not the hazard.
//
// TRUNCATION is. Only 14 code tokens (15 in the DB) are a strict prefix of their
// own brand key, and 8 of those (9 in the DB) are under 8 characters. With the
// defect still in, that was 15/16 and 9/10:
//
//   alo -> aloyoga          rei -> reicoop        lulu -> lululemon
//   levi -> levis           gstar -> gstarraw     g-star -> gstarraw
//   g star -> gstarraw      dooney -> dooneybourke
//   goorin -> goorinbros    duluth -> duluthtradingco   <- the defect
//
// One of ten was wrong. A bare rule at zero would have failed on all ten the day
// it was written, so it would have been written with exceptions or not at all.
// The other nine are kept for a reason the rule cannot see: the truncation is how
// the brand ACTUALLY PRINTS on its own tag, so removing it loses real matches
// ("REI" on an REI Co-op label, "lulu align" in a Lululemon listing title).
// 'duluth' had no such defence, which is precisely why its sibling refused it.
//
// So: the FLOOR bounds how much has to be reviewed, and the REGISTRY carries the
// judgement the floor cannot make. A new truncation token fails until someone
// writes down which of the two cases it is. Same shape as knownNoise in
// scripts/check-ui-antipatterns.mjs, DB_ONLY in verified-chart-parity_test.ts and
// SERVICE_ROLE_ONLY in rls-guard_test.ts, and like those, an entry that stops
// matching also fails, so the list can only shrink.

import { assert, assertEquals } from "@std/assert";

const { SIZING_CHARTS } = await import("../lib/sizing-charts.ts");
const { brandKey } = await import("../lib/brand-normalize.ts");

const MIGRATIONS_DIR = new URL("../../../../supabase/migrations/", import.meta.url);

/** Tokens shorter than this that truncate their own brand key need an entry. */
const TRUNCATION_FLOOR = 8;

/**
 * Truncation tokens that are deliberate. The reason is the entry: it must say
 * what the token buys and which other company it could reach.
 */
const KNOWN_TRUNCATIONS: Record<string, string> = {
  alo:
    "Alo Yoga's own tag prints a lower-case 'alo' alone, so the token is how " +
    "half its listings read. The only other apparel company leading with it is " +
    "ALOHAS (Spanish footwear), which has no chart to steal.",
  rei:
    "REI's own label prints both 'REI' and 'REI CO-OP', so the bare token is a " +
    "real match rather than a truncation in practice. Reigning Champ and Reiss " +
    "both start with 'rei' and both are different companies; neither has a " +
    "chart, so today the token can only over-reach into REI's own. If either " +
    "gets a chart the collision test below fails and this entry is the place " +
    "to revisit.",
  lulu:
    "Lulus (lulus.com) is a different company, so this is the Duluth shape. It " +
    "is kept because the token earns its place: resale titles say 'lulu align', " +
    "'lulu scuba', 'lulu define' constantly and 'lululemon' does not appear in " +
    "them. Revisit if Lulus is ever charted.",
  levi:
    "Levi's prints 'LEVI'S' and listings drop the apostrophe every way there " +
    "is; 'levi' catches all of them. No other apparel company leads with it.",
  gstar:
    "G-Star is the brand and RAW is the line, so 'gstar' is the brand's own " +
    "name rather than a truncation of it. Nothing else leads with it.",
  "g-star": "The hyphenated spelling of the same name. See 'gstar'.",
  "g star": "The spaced spelling of the same name. See 'gstar'.",
  dooney:
    "Dooney & Bourke is universally shortened to 'Dooney' by sellers and the " +
    "ampersand spellings do not survive most listing titles. Nothing else " +
    "leads with it.",
  goorin:
    "Goorin Bros. (DB-only headwear, 00574). Sellers write 'Goorin' without " +
    "the 'Bros'. Nothing else leads with it.",
};

/**
 * Token/brand pairs where a token legitimately fires on a DIFFERENT charted
 * brand's label. The entry must say why the wrong chart cannot be handed over.
 */
const KNOWN_COLLISIONS: Record<string, string> = {
  "brooks -> brooksbrothers":
    "Brooks RUNNING (a Berkshire Hathaway company) vs Brooks Brothers, and the " +
    "collision is unavoidable: 'brooks' is the running brand's entire name, so " +
    "no shorter or longer token separates them. It is contained rather than " +
    "removed. The Brooks charts are FOOTWEAR-only by categoryMatch and the " +
    "Brooks Brothers charts match the longer 'brooks brothers', so shirt, " +
    "jacket and pant categories each resolve to Brooks Brothers alone " +
    "(measured). Both Brooks notes open with 'THIS IS BROOKS RUNNING, NOT " +
    "BROOKS BROTHERS', so the model reading the chart is told. WHAT IS STILL " +
    "TRUE AND WAS OVERSTATED IN THE CHART'S OWN COMMENT: category narrowing " +
    "only separates them when the category MATCHES something. A Brooks " +
    "Brothers item with category 'shoe' gets the running chart, and one with " +
    "an empty or unmatched category ('bag', 'accessory') gets both brands' " +
    "charts in the pool. Both are wrong and neither is fixable from brand_match.",
  "aerie -> aerie":
    "SUB-BRAND, not a different company. American Eagle's charts carry 'aerie' " +
    "on purpose, and Aerie has charts of its own, so an Aerie legging lands in " +
    "a pool holding both. That is correct: Aerie is American Eagle's own line " +
    "and shares its grade. The wrong fix would be removing 'aerie' from the " +
    "parent, which loses every item tagged only 'Aerie' for a category Aerie " +
    "has no chart for.",
  "loft -> loft":
    "SUB-BRAND, same shape as aerie. Ann Taylor's charts carry 'loft' and say " +
    "so in the garment name itself ('shared Ann Taylor / LOFT grade'), and LOFT " +
    "has a denim chart of its own. Both are the same grade by the brand's own " +
    "published guide.",
};

// ── the corpus, both halves ────────────────────────────────────────────────

const isWordChar = (ch: string) => ch !== "" && /[0-9a-z]/i.test(ch);
/** The resolver's own matcher, copied so this guard tests behaviour not intent. */
function brandTextMatches(b: string, m: string): boolean {
  if (m === "") return false;
  for (let i = b.indexOf(m); i !== -1; i = b.indexOf(m, i + 1)) {
    if (!isWordChar(i === 0 ? "" : b[i - 1])) return true;
  }
  return false;
}

interface Chart {
  brandKey: string;
  label: string;
  ident: string;
  tokens: string[];
  where: string;
}

/**
 * Company identity for the collision test, taken from the LABEL rather than the
 * brand key.
 *
 * ⚠ brandKey() IS THE WRONG AXIS HERE and the first draft of this guard used it,
 * which produced eleven findings that were all one company reported as two. The
 * keys are not stable across the corpus's two halves: brandKey() applies the
 * BRAND_ALIASES map, while a migration carries whatever literal its author
 * typed, and the accent handling differs too (00472 holds 'fjllrven' and
 * 'khl' where 00498 holds 'fjallraven' and 'kuhl'). The question this test asks
 * is "does this token reach a DIFFERENT COMPANY", and the label answers it.
 */
const ident = (s: string) =>
  // NFD first, so an accented letter decomposes to a plain one plus a combining
  // mark; the [^a-z0-9] strip then drops the mark. No literal combining-mark
  // class in the source, which keeps this line ASCII.
  s.toLowerCase().normalize("NFD").replace(/[^a-z0-9]/g, "");

const codeCharts: Chart[] = SIZING_CHARTS.map((c) => ({
  brandKey: brandKey(c.brand),
  label: c.brand,
  ident: ident(c.brand),
  tokens: c.brandMatch,
  where: "sizing-charts.ts",
}));

/**
 * The DB half, modelled from the migrations rather than a live connection: the
 * migrations decide what prod holds, they are in the repo, and a guard needing
 * credentials is a guard that does not run in CI (the verified-chart-parity
 * precedent).
 *
 * ⚠ IT READS UPDATES, NOT ONLY INSERTS. US-3319's lesson on this same table was
 * that a guard modelling the DB from half the statements does not model the DB.
 * Every batch migration UPSERTS brand_match, so the highest-numbered insert wins;
 * 00792 then REMOVES a token with array_remove, and a guard blind to that form
 * would report a fixed defect forever and get itself relabelled expected-red.
 */
const ROW_RE =
  /\(\s*'((?:[^']|'')*)'\s*,\s*'((?:[^']|'')*)'\s*,\s*ARRAY\[([^\]]*)\]::text\[\]\s*,\s*'((?:[^']|'')*)'\s*,\s*'((?:[^']|'')*)'/g;
const INSERT_RE =
  /insert\s+into\s+public\.brand_size_charts\s*\([^)]*\)\s*values\s*([\s\S]*?)\n\s*on\s+conflict/gi;
const DELETE_RE =
  /delete\s+from\s+public\.brand_size_charts\b[\s\S]*?using\s*\(\s*values\s*([\s\S]*?)\)\s*as\s+v\s*\(([^)]*)\)/gi;
const REMOVE_RE =
  /update\s+public\.brand_size_charts\s+set\s+brand_match\s*=\s*array_remove\s*\(\s*brand_match\s*,\s*'((?:[^']|'')*)'\s*\)[\s\S]*?where\s+brand_key\s*=\s*'((?:[^']|'')*)'/gi;

const unquote = (s: string) => s.replace(/''/g, "'");

/**
 * Top-level `( ... )` tuples out of a VALUES list, quote-aware.
 *
 * ⚠ A /\(([^()]*)\)/ regex CANNOT do this and the first draft used one. Eleven
 * of 00782's fourteen retired charts have a parenthesis inside the quoted
 * garment ("Tops (US numeric 00-18 / alpha)"), so the cheap regex matched the
 * INNER parenthesis, produced the wrong arity and skipped the row. It silently
 * modelled 3 of 14 deletes, which reads as a clean parse.
 */
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

const dbCharts = new Map<string, Chart>();
let removalFiles = 0;
let removalsParsed = 0;
let deleteFiles = 0;
let deletesParsed = 0;

const files: string[] = [];
for await (const entry of Deno.readDir(MIGRATIONS_DIR)) {
  if (entry.isFile && entry.name.endsWith(".sql")) files.push(entry.name);
}
files.sort(); // NNNNN order, so the last writer wins

for (const name of files) {
  const sql = await Deno.readTextFile(new URL(name, MIGRATIONS_DIR));
  // ONE STATEMENT AT A TIME, bounded at `on conflict`. Scanning from the first
  // mention of the table to end-of-file looks equivalent and is not: these packs
  // seed brand_styles and brand_colorways in the same file, whose VALUES rows
  // have the same ('key', 'Label', ARRAY[...]::text[], 'a', 'b') shape. The
  // first draft did that and invented 80-odd charts named after colourways.
  INSERT_RE.lastIndex = 0;
  let ins: RegExpExecArray | null;
  while ((ins = INSERT_RE.exec(sql))) {
    ROW_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = ROW_RE.exec(ins[1]!))) {
      const [, key, label, arr, dept, garment] = m;
      const tokens = [...arr!.matchAll(/'((?:[^']|'')*)'/g)].map((x) => unquote(x[1]!));
      dbCharts.set(`${unquote(key!)}|${unquote(dept!)}|${unquote(garment!)}`, {
        brandKey: unquote(key!),
        label: unquote(label!),
        ident: ident(unquote(label!)),
        tokens,
        where: name,
      });
    }
  }
  if (/array_remove\s*\(\s*brand_match/i.test(sql)) removalFiles++;
  REMOVE_RE.lastIndex = 0;
  let r: RegExpExecArray | null;
  while ((r = REMOVE_RE.exec(sql))) {
    const token = unquote(r[1]!);
    const key = unquote(r[2]!);
    removalsParsed++;
    for (const chart of dbCharts.values()) {
      if (chart.brandKey === key) chart.tokens = chart.tokens.filter((t) => t !== token);
    }
  }

  // DELETES, for the same reason as the removals: 00782 retires 14 pre-backfill
  // approximations, including the shared `thenorthfacepatagoniaouterwear` row.
  // A model that keeps them reports a token reaching a company whose chart the
  // migration series has already dropped.
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
      const values = [...tuple.matchAll(/'((?:[^']|'')*)'/g)].map((x) => unquote(x[1]!));
      if (values.length !== columns.length) continue;
      if (dbCharts.delete(`${values[ki]}|${values[di]}|${values[gi]}`)) deletesParsed++;
    }
  }
}

const allCharts = [...codeCharts, ...dbCharts.values()];

/** One entry per company, keyed by label identity. */
const companies = new Map<string, string>();
for (const chart of allCharts) {
  if (!companies.has(chart.ident)) companies.set(chart.ident, chart.label);
}

// ── the guards ─────────────────────────────────────────────────────────────

Deno.test("US-3324: the parsers found both corpora (guards the guard)", () => {
  // Every assertion below reads as a pass on an empty parse.
  assert(codeCharts.length > 300, `only ${codeCharts.length} in-code charts parsed`);
  assert(dbCharts.size > 300, `only ${dbCharts.size} migration-seeded charts parsed`);
  assert(
    deleteFiles === 0 || deletesParsed > 0,
    `${deleteFiles} migration(s) delete from brand_size_charts but the delete ` +
      `parser matched no row this model holds`,
  );
  assert(
    removalFiles === 0 || removalsParsed > 0,
    `${removalFiles} migration(s) call array_remove on brand_match but the ` +
      `removal parser extracted none, and it no longer matches the SQL being written`,
  );
});

Deno.test("US-3324: no truncation token under the floor is unregistered", () => {
  const offenders: string[] = [];
  // SCOPED TO CODE. The DB half is the case below, because 00792 -- the
  // migration that removes the bare token from the live table -- is HELD on
  // branch held/us-3324-00792 and is deliberately not on main. Merging both
  // halves here would make main red for a migration main does not carry.
  for (const chart of codeCharts) {
    for (const token of chart.tokens) {
      if (token.length >= TRUNCATION_FLOOR) continue;
      const tk = brandKey(token);
      if (!(chart.brandKey.startsWith(tk) && chart.brandKey.length > tk.length)) continue;
      if (token in KNOWN_TRUNCATIONS) continue;
      offenders.push(`"${token}" truncates "${chart.brandKey}" (${chart.where})`);
    }
  }
  assertEquals(
    offenders.sort(),
    [],
    "brandTextMatches has no RIGHT boundary, so a token that truncates its own " +
      "brand key is a prefix of every other company starting that way (US-3324, " +
      "'duluth' vs Duluth Pack). Remove it, or add it to KNOWN_TRUNCATIONS with " +
      "the reason it is safe",
  );
});

Deno.test("US-3324: no token reaches a different charted brand unless registered", () => {
  const offenders = new Set<string>();
  for (const chart of allCharts) {
    for (const token of chart.tokens) {
      for (const [id, label] of companies) {
        if (id === chart.ident) continue;
        if (!brandTextMatches(label.toLowerCase(), token)) continue;
        const pair = `${token} -> ${id}`;
        if (pair in KNOWN_COLLISIONS) continue;
        offenders.add(`${pair} (${label}, from ${chart.where})`);
      }
    }
  }
  assertEquals(
    [...offenders].sort(),
    [],
    "a brand_match token resolves another company's chart. Narrow the token, or " +
      "add it to KNOWN_COLLISIONS with why the wrong chart cannot be handed over",
  );
});

Deno.test("US-3324: every registry entry still matches something", () => {
  // The list can only shrink. An entry that stops matching is a rule that has
  // quietly stopped being enforced, which is the failure ui:check's selfCheck()
  // and rls-guard's registration list both exist to prevent.
  const liveTruncations = new Set<string>();
  for (const chart of allCharts) {
    for (const token of chart.tokens) {
      const tk = brandKey(token);
      if (chart.brandKey.startsWith(tk) && chart.brandKey.length > tk.length) {
        liveTruncations.add(token);
      }
    }
  }
  assertEquals(
    Object.keys(KNOWN_TRUNCATIONS).filter((t) => !liveTruncations.has(t)).sort(),
    [],
    "a KNOWN_TRUNCATIONS entry no longer matches any token; delete it",
  );

  const liveCollisions = new Set<string>();
  for (const chart of allCharts) {
    for (const token of chart.tokens) {
      for (const [id, label] of companies) {
        if (id === chart.ident) continue;
        if (brandTextMatches(label.toLowerCase(), token)) liveCollisions.add(`${token} -> ${id}`);
      }
    }
  }
  assertEquals(
    Object.keys(KNOWN_COLLISIONS).filter((c) => !liveCollisions.has(c)).sort(),
    [],
    "a KNOWN_COLLISIONS entry no longer matches; delete it",
  );
});

Deno.test("US-3324: the bare 'duluth' token is gone from the in-code chart", () => {
  for (const chart of codeCharts.filter((c) => c.brandKey === "duluthtradingco")) {
    assert(
      !chart.tokens.includes("duluth"),
      `in-code Duluth Trading chart still carries the bare token: ${chart.tokens}`,
    );
  }
});

// THE DB HALF IS HELD, AND THIS CASE IS WHAT MAKES THAT VISIBLE RATHER THAN
// FORGOTTEN. 00792 removes the bare token from the live table and is parked on
// branch held/us-3324-00792 awaiting the owner, so the model built from main's
// migrations still carries it. The assertion is deliberately inverted: it fails
// the moment that branch lands, which is the signal to DELETE this case and
// restore the DB half of the truncation check above. It also fails if any OTHER
// unregistered truncation appears in the table, so holding one fix does not
// buy silence for the next one.
//
// The code half alone was the trap: brand-knowledge.ts reads brand_size_charts
// in preference to the constant, so a green code check with a stale table is
// still a wrong answer to a seller.
Deno.test("US-3324: the DB model still carries duluth, and ONLY duluth, until 00792 lands", () => {
  const offenders: string[] = [];
  for (const chart of dbCharts.values()) {
    for (const token of chart.tokens) {
      if (token.length >= TRUNCATION_FLOOR) continue;
      const tk = brandKey(token);
      if (!(chart.brandKey.startsWith(tk) && chart.brandKey.length > tk.length)) continue;
      if (token in KNOWN_TRUNCATIONS) continue;
      offenders.push(token);
    }
  }
  assertEquals(
    [...new Set(offenders)].sort(),
    ["duluth"],
    "Expected exactly the held one. If this says [] then 00792 has landed: "+
      "delete this case and change codeCharts back to allCharts in the "+
      "truncation-registry case above. If it names anything else, that is a "+
      "new unregistered truncation in the live table and it is not held by "+
      "anything.",
  );
  const dbDuluth = [...dbCharts.values()].filter((c) => c.brandKey === "duluthtradingco");
  assert(dbDuluth.length > 0, "expected Duluth Trading charts in the migrations");
  assert(
    dbDuluth.some((c) => c.tokens.includes("duluth trading")),
    "no Duluth Trading row matches on 'duluth trading' any more",
  );
});
