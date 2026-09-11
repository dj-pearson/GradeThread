// US-3363: no edge query may name a column the database does not have.
//
// THE DEFECT THIS EXISTS FOR. `flipdesk-sync.ts` ran
//     .update({ listing_status: "sold", sold_at: sale.soldAt })
// on `listings`, and `public.listings` has no `sold_at` column -- ownership of
// that value is `public.sales`, which is where `items_full` reads it from.
// Measured against the local stack on 2026-09-11: that PATCH returns
//     HTTP 400 {"code":"PGRST204","message":"Could not find the 'sold_at'
//     column of 'listings' in the schema cache"}
// while the same PATCH without the field returns 200. PostgREST refuses the
// WHOLE statement, so `listing_status` was not written either, and the result
// was never read. Every extension-confirmed sale on Poshmark, Mercari, Grailed,
// Vinted and Facebook booked a sales row and left its listing showing as live,
// and the route returned `status: "ok"`.
//
// It was found by accident, which is the part worth fixing. US-2842 was the
// same shape in a different file (`grade_reports.user_id`, which has never
// existed, on a harness with 21 green unit tests) and
// `calibration-selects-real-columns_test.ts` guards that ONE file. A guard
// whose scope is a hand-written list of filenames only resets the clock until
// the next file -- so this one derives BOTH halves: the corpus from a walk of
// the tree, the expectation from the migrations.
//
//   deno test --allow-read src/tests/edge-writes-real-columns_test.ts
import { assert, assertEquals } from "@std/assert";
import { columnsOf, migrationFileCount, viewNames } from "./_migration-columns.ts";

const SRC = new URL("../", import.meta.url);
const REPO_PREFIX = "services/edge-functions/src/";

/**
 * Every non-test module in the edge service.
 *
 * `tests/` is excluded because a fixture may legitimately describe a row shape
 * that no table has. That exclusion is the dangerous kind -- a broken one that
 * swallowed `lib/` would leave this quietly green -- so the corpus floors below
 * are asserted, and so is the presence of the specific files that do the thing.
 */
function sources(): string[] {
  const out: string[] = [];
  const walk = (dir: URL, prefix: string) => {
    for (const e of Deno.readDirSync(dir)) {
      if (e.isDirectory) {
        if (e.name === "tests" || e.name === "node_modules") continue;
        walk(new URL(`${e.name}/`, dir), `${prefix}${e.name}/`);
        continue;
      }
      if (e.isFile && e.name.endsWith(".ts")) out.push(`${prefix}${e.name}`);
    }
  };
  walk(SRC, "");
  return out.sort();
}

const FILES = sources();

function read(rel: string): string {
  // Block comments are stripped whole rather than by line prefix: the
  // continuation lines of a `/* ... */` start with plain prose, and a note beside
  // a field is exactly where that field's name gets quoted.
  return Deno.readTextFileSync(new URL(rel, SRC)).replace(/\/\*[\s\S]*?\*\//g, "");
}

/** The `{ ... }` (or `( ... )`, `[ ... ]`) that starts at `open`, brackets balanced. */
function balanced(src: string, open: number): string {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const ch = src[i];
    if (ch === "{" || ch === "(" || ch === "[") depth++;
    else if (ch === "}" || ch === ")" || ch === "]") {
      depth--;
      if (depth === 0) return src.slice(open, i + 1);
    }
  }
  return "";
}

/**
 * The property names of an object literal's OWN level.
 *
 * Three things here are corrections for a false positive this scan actually
 * produced while it was being written, and each one is a mode from
 * guards-that-do-not-guard:
 *
 *   - Line comments are skipped. `// Deliberately null: ...` beside a field read
 *     as a key called `null` (mode 1) -- 11 of the first 30 hits.
 *   - A key may only begin where a property may begin: after `{` or after a
 *     top-level `,`. Without that, the false branch of `a: x ? y : null` reads
 *     as a key called `y` -- 8 more hits, including a camelCase one that looked
 *     completely convincing.
 *   - Anything nested is another object's business.
 */
function topLevelKeys(obj: string): string[] {
  const keys: string[] = [];
  let depth = 0;
  let expectKey = false;
  let i = 0;
  while (i < obj.length) {
    const ch = obj[i]!;
    if (ch === "{" || ch === "(" || ch === "[") {
      depth++;
      if (depth === 1) expectKey = true;
      i++;
      continue;
    }
    if (ch === "}" || ch === ")" || ch === "]") {
      depth--;
      i++;
      continue;
    }
    if (ch === "," && depth === 1) {
      expectKey = true;
      i++;
      continue;
    }
    // Comments come first and do NOT consume the key slot: a note on its own
    // line between two fields sits exactly where a key is expected.
    if (ch === "/" && obj[i + 1] === "/") {
      while (i < obj.length && obj[i] !== "\n") i++;
      continue;
    }
    if (ch === "/" && obj[i + 1] === "*") {
      const end = obj.indexOf("*/", i + 2);
      i = end === -1 ? obj.length : end + 2;
      continue;
    }
    // Then the key, BEFORE the string skipper -- `"quoted_col": 1` is a
    // perfectly ordinary property and skipping it as a string loses it.
    if (depth === 1 && expectKey && !/\s/.test(ch)) {
      const m = /^(?:"([a-z_][a-z0-9_]*)"|([a-z_][a-z0-9_]*))\s*:/i.exec(obj.slice(i));
      // A spread, a shorthand or a computed key also consumes the slot.
      expectKey = false;
      if (m) {
        keys.push((m[1] ?? m[2])!.toLowerCase());
        i += m[0].length;
        continue;
      }
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      const quote = ch;
      i++;
      while (i < obj.length && obj[i] !== quote) {
        if (obj[i] === "\\") i++;
        i++;
      }
      i++;
      continue;
    }
    i++;
  }
  return keys;
}

interface Site {
  file: string;
  line: number;
  table: string;
  column: string;
  kind: "write" | "select";
}

const WRITE_RE =
  /\.from\(\s*"([a-z_][a-z0-9_]*)"\s*\)([\s\S]{0,400}?)\.(?:update|insert|upsert)\(\s*\{/g;
const SELECT_RE = /\.from\(\s*"([a-z_][a-z0-9_]*)"\s*\)\s*\.select\(\s*"([^"]*)"\s*[,)]/g;

interface Scan {
  writes: number;
  selects: number;
  unresolved: Set<string>;
  bad: Site[];
}

function scan(files: string[]): Scan {
  const out: Scan = { writes: 0, selects: 0, unresolved: new Set(), bad: [] };
  const lineOf = (src: string, idx: number) => src.slice(0, idx).split("\n").length;

  for (const file of files) {
    const src = read(file);

    for (const m of src.matchAll(WRITE_RE)) {
      // `.from("a").select(... .from("b").update({...})` -- a second .from() in the
      // gap means the pair is not really a pair.
      if (/\.from\(/.test(m[2]!)) continue;
      const obj = balanced(src, m.index! + m[0].length - 1);
      if (!obj) continue;
      out.writes++;
      const known = columnsOf(m[1]!);
      if (known.size === 0) {
        out.unresolved.add(m[1]!);
        continue;
      }
      for (const col of topLevelKeys(obj)) {
        if (!known.has(col)) {
          out.bad.push({
            file,
            line: lineOf(src, m.index!),
            table: m[1]!,
            column: col,
            kind: "write",
          });
        }
      }
    }

    for (const m of src.matchAll(SELECT_RE)) {
      const list = m[2]!;
      // `*`, an embedded resource (`items!inner(...)`) and an aggregate are not
      // plain column lists; parsing them properly is a different job.
      if (list.includes("*") || /[(!]/.test(list)) continue;
      out.selects++;
      const known = columnsOf(m[1]!);
      if (known.size === 0) {
        out.unresolved.add(m[1]!);
        continue;
      }
      for (const raw of list.split(",")) {
        // `alias:column` -- PostgREST puts the real name on the right.
        const col = raw.trim().split(":").pop()!.trim().toLowerCase();
        if (!col) continue;
        if (!known.has(col)) {
          out.bad.push({
            file,
            line: lineOf(src, m.index!),
            table: m[1]!,
            column: col,
            kind: "select",
          });
        }
      }
    }
  }
  return out;
}

const RESULT = scan(FILES);

// -- corpus controls ---------------------------------------------------------

Deno.test("US-3363: the scan walks the tree and the migrations", () => {
  assert(
    migrationFileCount() >= 700,
    `only ${migrationFileCount()} migrations were read. Three of them are ` +
      `numbered with SIX digits (000355, 000375, 000385) and a ^\\d{5}_ filter ` +
      `drops them, which is how this scan first reported a real column as ` +
      `missing.`,
  );
  assert(
    FILES.length >= 900,
    `the scan walked only ${FILES.length} files; something in the directory ` +
      `exclusions is eating the corpus. 1,044 when this was written.`,
  );
  assert(
    RESULT.writes >= 800,
    `only ${RESULT.writes} write sites matched. 898 when this was written -- a ` +
      `regex that stops matching reads exactly like a clean codebase.`,
  );
  assert(
    RESULT.selects >= 1400,
    `only ${RESULT.selects} plain select sites matched. 1,588 when this was ` +
      `written.`,
  );
});

Deno.test("US-3363: the files that actually do this are in the scanned set", () => {
  // The exclusions fail in opposite directions: a broken `tests` exclusion
  // makes this suite loudly red, one that swallowed `lib/` or `routes/` leaves
  // it quietly green. The quiet direction gets its own assertion.
  for (
    const f of [
      "routes/flipdesk-sync.ts",
      "routes/flipdesk-ebay.ts",
      "routes/grade.ts",
      "lib/cross-listings.ts",
      "lib/shopify-orders.ts",
    ]
  ) {
    assert(FILES.includes(f), `${REPO_PREFIX}${f} writes rows and is not scanned`);
  }
  assert(
    !FILES.some((f) => f.startsWith("tests/")),
    "test fixtures are in the corpus, so a fixture row shape would be judged " +
      "as a query",
  );
});

Deno.test("US-3363: every table the scan could not resolve is a VIEW", () => {
  // An unresolved table yields an EMPTY column set, and an empty set skips the
  // check. That is the failure mode where a scan passes because it matched
  // nothing, so the unresolved set is named rather than tolerated.
  const views = viewNames();
  for (const t of RESULT.unresolved) {
    assert(
      views.has(t),
      `the scan cannot resolve the columns of "${t}", which the migrations do ` +
        `not declare as a view either. Empty is "cannot check", not "clean" -- ` +
        `either the table is created in a shape _migration-columns.ts does not ` +
        `parse, or the name is wrong.`,
    );
  }
  assertEquals(
    [...RESULT.unresolved].sort(),
    ["help_articles_stale", "items_full", "public_grade_reports", "public_showcase_finds"],
    "the set of views queried by name changed. That is fine, but a NEW name " +
      "here means a new unchecked query -- confirm it is a view and update this.",
  );
});

// -- the detector proves it can fire ----------------------------------------

Deno.test("US-3363: the key parser finds real keys and not prose (self-check)", () => {
  const obj = `{
    user_id: ownerId,
    "quoted_col": 1,
    // Deliberately null: a comment beside a field is not a field
    listing_status: "sold",
    sale_price: cond ? realValue : null,
    nested: { not_a_top_level_key: 1 },
    ...(flag ? { spread_key: 1 } : {}),
  }`;
  assertEquals(topLevelKeys(obj), [
    "user_id",
    "quoted_col",
    "listing_status",
    "sale_price",
    "nested",
  ]);
});

Deno.test("US-3363: the scan reddens on the original defect (self-check)", () => {
  // The exact expression that shipped, against the exact table. Without this,
  // a rule that stopped matching would be indistinguishable from a clean tree.
  const src = `
    await supabaseAdmin
      .from("listings")
      .update({ listing_status: "sold", sold_at: sale.soldAt })
      .eq("id", id);
  `;
  const found: string[] = [];
  for (const m of src.matchAll(WRITE_RE)) {
    const obj = balanced(src, m.index! + m[0].length - 1);
    const known = columnsOf(m[1]!);
    for (const col of topLevelKeys(obj)) if (!known.has(col)) found.push(col);
  }
  assertEquals(found, ["sold_at"], "the detector no longer spots the US-3363 write");
});

// -- the rule ---------------------------------------------------------------

Deno.test("US-3363: no edge query names a column the migrations do not create", () => {
  assertEquals(
    RESULT.bad.map((s) =>
      `${REPO_PREFIX}${s.file}:${s.line} ${s.kind}s ${s.table}.${s.column}`
    ),
    [],
    "a query names a column no migration creates. PostgREST refuses the WHOLE " +
      "statement with HTTP 400 PGRST204, so the fields that DO exist are not " +
      "written either -- and if the result is not checked, the route still " +
      "answers 200.",
  );
});

Deno.test("US-3363: listings still has no sold_at, and sales still owns it", () => {
  // The fact the fix rests on, asserted from the schema so that a migration
  // adding listings.sold_at turns this red on the commit that adds it. At that
  // point the second copy needs a deliberate owner -- items_full computes
  // sale_date, sold_at_raw and days_to_sell from the sales lateral join today.
  assertEquals(
    columnsOf("listings").has("sold_at"),
    false,
    "listings now HAS a sold_at. Nothing read one when it was added: decide " +
      "which of the two columns items_full and every money surface should " +
      "believe before writing to it.",
  );
  assertEquals(columnsOf("sales").has("sold_at"), true);
  assertEquals(columnsOf("listings").has("listing_status"), true);
});
