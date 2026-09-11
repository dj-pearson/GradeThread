// US-3377: no query in the web app may name a column the database does not
// have, and no `onConflict` may name a PARTIAL unique index.
//
// This is the `src/` half of the two guards the edge service gained this week:
// `edge-writes-real-columns_test.ts` (US-3363) and `partial-index-conflict_test.ts`
// (US-3365). Both derive their expectation from supabase/migrations/, and both
// were missing here entirely.
//
// -- Why it matters MORE in src/ than in the edge --
//
// Nearly every write in this tree is cast `as never`, to work around the
// supabase-js `tsc -b` resolution problem recorded in CLAUDE.md. Behind that
// cast TypeScript checks no column name at all. Two patch builders make it
// worse by returning `Record<string, unknown>`: `composerItemPatch`
// (src/pages/flipdesk/composer.tsx:2006, which returns `buildItemPatch(...)`
// from src/lib/composer-save.ts:300) and `mergeOverridesToItemUpdate`
// (src/hooks/use-sku-merge.ts:54). Measured here 2026-09-11: 43 of 155 write
// sites pass a variable rather than an object literal, so a scan that only
// reads `.update({ ... })` walks past 28% of the writes -- including both
// builders. That is why `payloadKeys` resolves an identifier back to the
// literal or the function that built it, and why both builders are named as
// canaries below. 149 of 157 sites resolve today.
//
// -- What the defect looks like in production --
//
// PostgREST answers HTTP 400 PGRST204 for the WHOLE statement, so the fields
// that DO exist are not written either. `flipdesk-sync.ts` patched `listings`
// with a `sold_at` that table has never had; `listing_status: "sold"` did not
// land, nothing read the result, and every extension-confirmed sale left its
// listing showing as live for a month.
//
// -- Two traps this repo has already paid for --
//
//  1. Comments are stripped PER FILE, never after concatenation. The first
//     version of the edge's index scan joined 785 migrations first, and a cron
//     string `'0 */2 * * *'` closed a `/*` opened in an earlier file: 85 unique
//     indexes visible instead of 128. A third of the schema went missing and the
//     scan reported a clean codebase. scripts/lib/migration-schema.mjs parses
//     per file; the named canaries below are the second line of defence,
//     because 85 still looks like plenty.
//  2. A scan with a broken comparison does not error, it reports health. The
//     sweep that originally found the partial-index defect compared
//     `indpred IS NOT NULL` against "t" when psql printed "true", so every
//     index read as non-partial. Every rule in this file therefore has a
//     self-check that proves it can still go red.
//
// The census this pins, measured 2026-09-11 against 786 migrations and 1,307
// source files: 1,472 column names -- 440 payload keys over 157 write sites,
// 501 filter columns, 531 select columns -- ZERO bad. 21 onConflict targets --
// ZERO partial. 15 `users` write sites naming 14 distinct columns against the
// 00710 self-service allowlist -- ZERO violations.

import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import {
  allUniqueIndexes,
  columnsOf,
  migrationFileCount,
  parseUniqueIndexes,
  parseSelfServiceArray,
  usersGuardMigration,
  usersSelfServiceAllowlist,
  viewNames,
  type UniqueIndexFact,
} from "../../scripts/lib/migration-schema.mjs";

const SRC = "src";

// -- corpus -----------------------------------------------------------------

interface Source {
  file: string;
  /** Comment-blanked text. Offsets and line numbers still line up with disk. */
  code: string;
}

/**
 * Blank comments, preserving every newline and every character position.
 *
 * Blanked rather than deleted so a reported line number is the line you open.
 * It has to happen at all because a note beside a field is exactly where a
 * field name gets quoted -- 11 of the first 30 hits the edge version produced
 * were `// Deliberately null: ...` read as a key called `null`.
 */
function blankComments(src: string): string {
  return src
    .replace(/\r\n/g, "\n")
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/\/\/[^\n]*/g, (m) => " ".repeat(m.length));
}

/**
 * Every non-test module under src/.
 *
 * The test exclusion is the dangerous kind of exclusion -- a fixture may
 * legitimately describe a row shape no table has, but a broken exclusion that
 * swallowed `pages/` would leave this quietly green. The corpus floors below
 * are the answer, and so is the named-file assertion.
 */
function sourceFiles(dir = SRC, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry).replace(/\\/g, "/");
    if (statSync(full).isDirectory()) {
      if (entry === "node_modules" || entry === "__tests__") continue;
      if (full === `${SRC}/test`) continue;
      sourceFiles(full, out);
      continue;
    }
    if (/\.tsx?$/.test(entry) && !/\.(test|spec)\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

const readCache = new Map<string, string>();
function codeOf(file: string): string {
  let hit = readCache.get(file);
  if (hit === undefined) {
    hit = blankComments(readFileSync(file, "utf8"));
    readCache.set(file, hit);
  }
  return hit;
}

// -- expression helpers -----------------------------------------------------

/** The bracketed run starting at `open`, brackets balanced. */
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
 * A key may only begin where a property may begin: after `{` or after a
 * top-level `,`. Without that rule, the false branch of `a: x ? y : null` reads
 * as a key called `y`. A spread, a shorthand or a computed key consumes the
 * slot without contributing a name, which is permissive on purpose -- the
 * spread's own keys are somebody else's object.
 */
export function topLevelKeys(obj: string): string[] {
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
    if (depth === 1 && expectKey && !/\s/.test(ch)) {
      const m = /^(?:"([a-z_][a-z0-9_]*)"|([a-z_][a-z0-9_]*))\s*:/i.exec(obj.slice(i));
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

/**
 * How a scan reads a file.
 *
 * Injected rather than read straight off disk so the self-checks can run the
 * EXACT same code path over a fabricated file, and over a real file with a real
 * mutation applied in memory. The first version of the sabotage case below went
 * green against a mutated file because `fnReturnKeys` still read the ORIGINAL
 * from the cache: a self-check that silently reads different bytes than the
 * rule proves nothing about the rule.
 */
type Reader = (file: string) => string;

/** Where an imported symbol comes from, as a file path, or null. */
function importedFrom(read: Reader, file: string, name: string): string | null {
  for (const m of read(file).matchAll(/import\s*\{([^}]*)\}\s*from\s*"([^"]+)"/g)) {
    const names = m[1]!
      .split(",")
      .map((s) => s.trim().split(/\s+as\s+/).pop()!.trim());
    if (!names.includes(name)) continue;
    const spec = m[2]!;
    let base: string;
    if (spec.startsWith("@/")) base = resolve(SRC, spec.slice(2));
    else if (spec.startsWith(".")) base = resolve(dirname(file), spec);
    else return null;
    for (const ext of [".ts", ".tsx", "/index.ts", "/index.tsx"]) {
      if (existsSync(base + ext)) return (base + ext).replace(/\\/g, "/");
    }
    return null;
  }
  return null;
}

/**
 * The keys of the object a function returns, following one `return other(...)`
 * hop across files.
 *
 * That hop is not a flourish: `composerItemPatch` is a thin wrapper whose whole
 * body is `return buildItemPatch({...})` in another module, and without it the
 * two biggest `inventory_items` writes in the app are unchecked.
 */
function fnReturnKeys(
  read: Reader,
  file: string,
  name: string,
  seen = new Set<string>(),
): string[] | null {
  const key = `${file}#${name}`;
  if (seen.has(key)) return null;
  seen.add(key);

  const code = read(file);
  let start = -1;
  for (
    const pat of [
      new RegExp(`function\\s+${name}\\s*[(<]`),
      new RegExp(`(?:const|let)\\s+${name}\\s*(?::[^=\\n]*)?=\\s*(?:async\\s*)?[(<]`),
    ]
  ) {
    const m = pat.exec(code);
    if (m) {
      start = m.index;
      break;
    }
  }
  if (start === -1) {
    const other = importedFrom(read, file, name);
    return other ? fnReturnKeys(read, other, name, seen) : null;
  }

  const bodyOpen = code.indexOf("{", code.indexOf(")", start));
  if (bodyOpen === -1) return null;
  const body = balanced(code, bodyOpen);
  const keys = new Set<string>();
  let found = false;

  // `return { ... }`
  for (const m of body.matchAll(/return\s*\{/g)) {
    found = true;
    for (const k of topLevelKeys(balanced(body, body.indexOf("{", m.index)))) keys.add(k);
  }

  // `const out: Record<string, unknown> = {}` ... `out.foo = ...` ... `return out`
  //
  // EVERY `return ident;` in the body is tried, not just the first. A builder
  // this size has helper closures inside it -- mergeOverridesToItemUpdate's
  // `priceNum` has a bare `return null;` twelve lines above the real one -- and
  // taking the first match made the resolver hand back an EMPTY key list while
  // reporting success. An empty list is not a clean payload, it is a payload
  // nobody checked, and it read as clean for 30 column names.
  for (const m of body.matchAll(/return\s+([A-Za-z_$][\w$]*)\s*;/g)) {
    const v = m[1]!;
    const decl = new RegExp(`(?:const|let|var)\\s+${v}\\s*(?::[^=\\n]*)?=\\s*\\{`).exec(body);
    if (!decl) continue;
    found = true;
    for (const k of topLevelKeys(balanced(body, body.indexOf("{", decl.index)))) keys.add(k);
    for (const k of assignedKeys(body, v)) keys.add(k);
  }

  // `return other(...)` -- one hop, same file or imported. Last, because it is
  // the only branch that can leave the file.
  if (!found) {
    for (const m of body.matchAll(/return\s+([A-Za-z_$][\w$]*)\s*\(/g)) {
      const target = m[1]!;
      const inner = fnReturnKeys(read, file, target, seen);
      if (inner) {
        found = true;
        for (const k of inner) keys.add(k);
        break;
      }
    }
  }
  return found ? [...keys] : null;
}

/**
 * The single statement that starts at `at`: forward to the first `;` outside
 * any bracket.
 *
 * Bounding the search to ONE statement is what stops `const chunk =
 * rows.slice(i, i + N)` from picking up an unrelated `=> ({ ... })` further
 * down the function and reporting its keys as this write's payload. That is the
 * cry-wolf direction, which is the expensive one.
 */
function statementFrom(code: string, at: number): string {
  let depth = 0;
  for (let i = at; i < code.length && i < at + 8000; i++) {
    const ch = code[i];
    if (ch === "(" || ch === "[" || ch === "{") depth++;
    else if (ch === ")" || ch === "]" || ch === "}") depth--;
    else if (ch === ";" && depth <= 0) return code.slice(at, i);
  }
  return code.slice(at, Math.min(code.length, at + 8000));
}

/** `v.col = ...` and `v["col"] = ...` inside one region. NOT `==` or `=>`. */
function assignedKeys(region: string, v: string): string[] {
  const out: string[] = [];
  for (const m of region.matchAll(new RegExp(`\\b${v}\\.([a-z_][a-z0-9_]*)\\s*=(?![=>])`, "g"))) {
    out.push(m[1]!);
  }
  for (
    const m of region.matchAll(
      new RegExp(`\\b${v}\\[\\s*"([a-z_][a-z0-9_]*)"\\s*\\]\\s*=(?![=>])`, "g"),
    )
  ) {
    out.push(m[1]!);
  }
  return out;
}

/**
 * The column names a write payload carries, or null when the shape is one this
 * does not read.
 *
 * null is "cannot check", never "clean". The share of sites that resolve is
 * asserted below so the null branch cannot quietly grow into the whole corpus.
 */
export function payloadKeys(
  read: Reader,
  file: string,
  code: string,
  exprStart: number,
): string[] | null {
  const rest = code.slice(exprStart);

  // .update({ ... })
  if (/^\s*\{/.test(rest)) return topLevelKeys(balanced(code, exprStart + rest.indexOf("{")));

  // .update(ident as never) / .insert(ident)
  const ident = /^\s*([A-Za-z_$][\w$]*)\s*(?:as\s+\w+\s*)?[,)]/.exec(rest);
  if (ident) {
    const v = ident[1]!;
    const before = code.slice(0, exprStart);
    const declRe = new RegExp(`(?:const|let|var)\\s+${v}\\s*(?::[^=\\n]*)?=\\s*`, "g");
    let last: RegExpExecArray | RegExpMatchArray | null = null;
    for (const m of before.matchAll(declRe)) last = m;
    if (!last) return null;
    const at = last.index! + last[0].length;
    const region = code.slice(at, exprStart);

    // const v = { ... }   (plus any v.col = ... between the declaration and the
    // write -- bounded to that region, because the same name is declared in
    // several sibling scopes in a big page component and a whole-file sweep
    // mixes them. That produced three false positives while this was written.)
    if (code[at] === "{") {
      const keys = new Set(topLevelKeys(balanced(code, at)));
      for (const k of assignedKeys(region, v)) keys.add(k);
      return [...keys];
    }
    // const v = rows.map((r) => ({ ... }))  /  const v = other.slice(...)
    const tail = statementFrom(code, at);
    const arrow = /=>\s*\(\s*\{/.exec(tail);
    const chained = /^([A-Za-z_$][\w$]*)\s*\./.exec(tail);
    const call = /^([A-Za-z_$][\w$]*)\s*\(/.exec(tail);
    if (arrow && (!call || arrow.index < call.index)) {
      return topLevelKeys(balanced(tail, tail.indexOf("{", arrow.index)));
    }
    if (call) return fnReturnKeys(read, file, call[1]!, new Set());
    if (chained) {
      // `const chunk = rows.slice(...)` -- the row shape belongs to `rows`.
      const owner = chained[1]!;
      const declOther = new RegExp(`(?:const|let|var)\\s+${owner}\\s*(?::[^=\\n]*)?=\\s*`, "g");
      let lastOther: RegExpMatchArray | null = null;
      for (const m of before.matchAll(declOther)) lastOther = m;
      if (!lastOther) return null;
      const otherAt = lastOther.index! + lastOther[0].length;
      const otherTail = statementFrom(code, otherAt);
      const otherArrow = /=>\s*\(\s*\{/.exec(otherTail);
      if (otherArrow) return topLevelKeys(balanced(otherTail, otherTail.indexOf("{", otherArrow.index)));
      if (code[otherAt] === "{") return topLevelKeys(balanced(code, otherAt));
      return null;
    }
    return null;
  }

  // .update(buildPatch(...))
  const call = /^\s*([A-Za-z_$][\w$]*)\s*\(/.exec(rest);
  if (call) return fnReturnKeys(read, file, call[1]!, new Set());
  return null;
}

// -- the scan ---------------------------------------------------------------

const WRITE_RE = /\.from\(\s*"([a-z_][a-z0-9_]*)"\s*\)([\s\S]{0,400}?)\.(?:update|insert|upsert)\(/g;
const SELECT_RE = /\.from\(\s*"([a-z_][a-z0-9_]*)"\s*\)\s*\.select\(\s*"([^"]*)"\s*[,)]/g;
const FILTER_RE =
  /\.(eq|neq|gt|gte|lt|lte|like|ilike|is|in|contains|containedBy|overlaps|order)\(\s*"([^"]*)"/g;
const CONFLICT_RE = /onConflict:\s*"([^"]+)"/g;

/**
 * The table a chained call belongs to: the nearest preceding `.from(`, and only
 * when that `.from(` names a string literal.
 *
 * The literal requirement is the whole point. `src/lib/team-reporting.ts` does
 * `.from(table).select(...).eq("user_id", ownerId)` with `table` a parameter,
 * 27 lines below a real `.from("users")`. Without this the filter attributes to
 * `users`, which has no `user_id`, and the scan cries wolf at correct code --
 * the expensive direction. An unattributed call is counted, not checked.
 */
function ownerTable(code: string, at: number): string | null {
  const owner = code.lastIndexOf(".from(", at);
  if (owner === -1) return null;
  const m = /^\.from\(\s*"([a-z_][a-z0-9_]*)"\s*\)/.exec(code.slice(owner));
  return m ? m[1]!.toLowerCase() : null;
}

export interface Finding {
  where: string;
  detail: string;
}

export interface Scan {
  writeSites: number;
  resolvedSites: number;
  payloadKeys: number;
  filterColumns: number;
  selectColumns: number;
  conflictTargets: Array<{ where: string; table: string; columns: string[] }>;
  unresolvedPayloads: string[];
  unresolvedTables: Set<string>;
  usersWriteSites: number;
  usersColumns: Map<string, Set<string>>;
  bad: Finding[];
}

/**
 * The whole rule, over a list of sources.
 *
 * Takes sources rather than reading the tree itself so the self-checks below
 * can run the EXACT same code path over a fabricated file, and over a real file
 * with a real mutation applied in memory. A self-check that re-implements the
 * scan proves nothing about the scan.
 */
export function scanSources(sources: Source[]): Scan {
  // A file in `sources` wins over whatever is on disk, so an in-memory mutation
  // is what the whole resolver sees, including its cross-file hops.
  const overlay = new Map(sources.map((s) => [s.file, s.code]));
  const read: Reader = (file) => overlay.get(file) ?? codeOf(file);

  const out: Scan = {
    writeSites: 0,
    resolvedSites: 0,
    payloadKeys: 0,
    filterColumns: 0,
    selectColumns: 0,
    conflictTargets: [],
    unresolvedPayloads: [],
    unresolvedTables: new Set(),
    usersWriteSites: 0,
    usersColumns: new Map(),
    bad: [],
  };

  for (const { file, code } of sources) {
    const lineOf = (i: number) => code.slice(0, i).split("\n").length;

    for (const m of code.matchAll(WRITE_RE)) {
      // `.from("a").select(... .from("b").update({...})` -- a second .from() in
      // the gap means the pair is not really a pair.
      if (/\.from\(/.test(m[2]!)) continue;
      out.writeSites++;
      const table = m[1]!;
      const where = `${file}:${lineOf(m.index)}`;
      const keys = payloadKeys(read, file, code, m.index + m[0].length);
      if (keys === null) {
        out.unresolvedPayloads.push(`${where} ${table}`);
        continue;
      }
      out.resolvedSites++;
      out.payloadKeys += keys.length;
      if (table === "users") {
        out.usersWriteSites++;
        for (const k of keys) {
          if (!out.usersColumns.has(k)) out.usersColumns.set(k, new Set());
          out.usersColumns.get(k)!.add(where);
        }
      }
      const known = columnsOf(table);
      if (known.size === 0) {
        out.unresolvedTables.add(table);
        continue;
      }
      for (const col of keys) {
        if (!known.has(col)) out.bad.push({ where, detail: `writes ${table}.${col}` });
      }
    }

    for (const m of code.matchAll(SELECT_RE)) {
      const list = m[2]!;
      // `*`, an embedded resource (`items!inner(...)`) and an aggregate are not
      // plain column lists; parsing those properly is a different job.
      if (list.includes("*") || /[(!]/.test(list)) continue;
      const known = columnsOf(m[1]!);
      if (known.size === 0) {
        out.unresolvedTables.add(m[1]!);
        continue;
      }
      for (const raw of list.split(",")) {
        // `alias:column` -- PostgREST puts the real name on the right.
        const col = raw.trim().split(":").pop()!.trim().toLowerCase();
        if (!col) continue;
        out.selectColumns++;
        if (!known.has(col)) {
          out.bad.push({ where: `${file}:${lineOf(m.index)}`, detail: `selects ${m[1]}.${col}` });
        }
      }
    }

    for (const m of code.matchAll(FILTER_RE)) {
      const table = ownerTable(code, m.index);
      if (!table) continue;
      const col = m[2]!.trim().toLowerCase();
      // An embedded filter (`items.user_id`), a json path (`meta->>x`) and a
      // computed name are somebody else's grammar.
      if (!/^[a-z_][a-z0-9_]*$/.test(col)) continue;
      out.filterColumns++;
      const known = columnsOf(table);
      if (known.size === 0) {
        out.unresolvedTables.add(table);
        continue;
      }
      if (!known.has(col)) {
        out.bad.push({
          where: `${file}:${lineOf(m.index)}`,
          detail: `filters ${table}.${col} with .${m[1]}()`,
        });
      }
    }

    for (const m of code.matchAll(CONFLICT_RE)) {
      const table = ownerTable(code, m.index);
      if (!table) continue;
      out.conflictTargets.push({
        where: `${file}:${lineOf(m.index)}`,
        table,
        columns: m[1]!.split(",").map((c) => c.trim().toLowerCase()).filter((c) => c.length > 0),
      });
    }
  }
  return out;
}

/**
 * onConflict targets that match a PARTIAL unique index and nothing non-partial.
 *
 * Column ORDER is irrelevant -- Postgres infers the arbiter as a SET -- so this
 * compares sets. A target matching both a partial and a non-partial index is
 * fine: the planner picks the one it can use.
 */
export function findPartialConflicts(
  targets: Scan["conflictTargets"],
  indexes: UniqueIndexFact[],
): Array<{ where: string; table: string; columns: string[]; index: string }> {
  const sameSet = (a: string[], b: string[]) =>
    a.length === b.length && [...a].sort().join(",") === [...b].sort().join(",");
  const bad = [];
  for (const t of targets) {
    const onTable = indexes.filter((i) => i.table === t.table && sameSet(i.columns, t.columns));
    if (onTable.length === 0) continue;
    if (onTable.some((i) => !i.partial)) continue;
    bad.push({ ...t, index: onTable[0]!.name });
  }
  return bad;
}

const FILES = sourceFiles();
const RESULT = scanSources(FILES.map((file) => ({ file, code: codeOf(file) })));

// -- corpus controls --------------------------------------------------------

describe("US-3377: the src/ scan reads the tree and the migrations", () => {
  it("reads every migration, including the six-digit ones", () => {
    // 000355, 000375 and 000385 are numbered with SIX digits. A `^\d{5}_`
    // filter drops them silently, which is how the edge copy first reported a
    // real column (push_device_tokens.is_active) as missing.
    expect(migrationFileCount()).toBeGreaterThanOrEqual(700);
  });

  it("walks the whole of src/ and not just a corner of it", () => {
    // 1,307 files when this was written, 734 of them .tsx.
    expect(FILES.length, "the directory exclusions are eating the corpus").toBeGreaterThanOrEqual(
      1000,
    );
    expect(FILES.some((f) => f.startsWith("src/pages/"))).toBe(true);
    expect(FILES.some((f) => f.startsWith("src/hooks/"))).toBe(true);
    expect(FILES.some((f) => f.startsWith("src/lib/"))).toBe(true);
    expect(FILES.some((f) => f.startsWith("src/components/"))).toBe(true);
    // .tsx is load-bearing: src/ is TSX-heavy and a .ts-only walk silently
    // skips most of the pages, including composer.tsx and every FlipDesk
    // surface. 734 of the 1,307 files are .tsx today.
    expect(
      FILES.filter((f) => f.endsWith(".tsx")).length,
      "the .tsx glob stopped matching; most of src/ is .tsx",
    ).toBeGreaterThanOrEqual(600);
    expect(FILES.some((f) => f.startsWith("src/test/"))).toBe(false);
    expect(FILES.some((f) => f.includes("/__tests__/"))).toBe(false);
  });

  it("matches enough sites that a dead regex cannot read as a clean tree", () => {
    // Measured 2026-09-11: 157 write sites, 440 payload keys, 501 filter
    // columns, 531 select columns, 21 onConflict targets. The floors sit about
    // 15% under, which is the usual trade: low enough that deleting a page does
    // not fail the build, high enough that a regex which stops matching cannot
    // read as a clean tree.
    expect(RESULT.writeSites, "the write regex stopped matching").toBeGreaterThanOrEqual(130);
    expect(RESULT.payloadKeys).toBeGreaterThanOrEqual(370);
    expect(RESULT.filterColumns).toBeGreaterThanOrEqual(430);
    expect(RESULT.selectColumns).toBeGreaterThanOrEqual(450);
    expect(RESULT.conflictTargets.length).toBeGreaterThanOrEqual(15);
  });

  it("resolves the payload of the large majority of write sites", () => {
    // 149 of 157 today. The 8 that do not resolve are shapes this does not read
    // -- a function parameter (use-saved-searches.ts), a member expression
    // (`plan.patch` in listings-actions.ts), a value built across several
    // branches. They are UNCHECKED, not clean, so the share is asserted rather
    // than assumed.
    expect(
      RESULT.resolvedSites / RESULT.writeSites,
      `only ${RESULT.resolvedSites} of ${RESULT.writeSites} write payloads resolved. ` +
        `Unresolved: ${RESULT.unresolvedPayloads.join(", ")}`,
    ).toBeGreaterThan(0.8);
  });

  it("reaches through the two Record<string, unknown> patch builders", () => {
    // The reason this guard exists (US-3377). Both return Record<string,
    // unknown>, both are written `as never`, and between them they carry 30
    // column names that nothing else in the toolchain checks. If the resolver
    // stops reaching them, the clean result above is about the easy 90%.
    const builders = fnReturnKeys(codeOf, "src/pages/flipdesk/composer.tsx", "composerItemPatch");
    expect(
      builders,
      "composerItemPatch no longer resolves -- it returns buildItemPatch(...) " +
        "from src/lib/composer-save.ts, so the cross-file hop in fnReturnKeys is broken",
    ).not.toBeNull();
    expect(builders).toContain("ebay_category_id");
    expect(builders).toContain("floor_price");

    const merge = fnReturnKeys(codeOf, "src/hooks/use-sku-merge.ts", "mergeOverridesToItemUpdate");
    expect(merge, "mergeOverridesToItemUpdate no longer resolves").not.toBeNull();
    expect(merge).toContain("condition_notes");
    expect(merge).toContain("acquired_price");
  });

  it("every table it could not resolve is a VIEW", () => {
    // An unresolved table yields an EMPTY column set, and an empty set skips
    // the check. That is the failure mode where a scan passes because it
    // matched nothing, so the set is named rather than tolerated.
    const views = viewNames();
    for (const t of RESULT.unresolvedTables) {
      expect(
        views.has(t),
        `the scan cannot resolve the columns of "${t}", and the migrations do ` +
          `not declare it as a view either. Empty is "cannot check", not "clean".`,
      ).toBe(true);
    }
    expect(
      [...RESULT.unresolvedTables].sort(),
      "the set of views queried by name changed. That is fine, but a NEW name " +
        "here means a new UNCHECKED query -- confirm it is a view and update this.",
    ).toEqual(["items_full", "public_grade_reports", "public_passport_links", "sale_pnl"]);
  });
});

// -- liveness: the check is not vacuously true ------------------------------

describe("US-3377: the column check is live", () => {
  it("columnsOf resolves a real table to its real columns", () => {
    const listings = columnsOf("listings");
    expect(listings.size, "columnsOf('listings') is empty, so every listings write is unchecked")
      .toBeGreaterThan(50);
    expect(listings.has("listing_status")).toBe(true);
    expect(listings.has("listing_price")).toBe(true);
    expect(columnsOf("inventory_items").has("floor_price")).toBe(true);
    expect(columnsOf("users").has("share_garment_measurements")).toBe(true);
  });

  it("listings still has no sold_at, and sales still owns it", () => {
    // US-3363's defect, asserted from the schema. A migration that adds
    // listings.sold_at turns this red on the commit that adds it, at which
    // point the second copy needs a deliberate owner: items_full computes
    // sale_date, sold_at_raw and days_to_sell from the sales lateral join.
    expect(
      columnsOf("listings").has("sold_at"),
      "listings now HAS a sold_at. Decide which of the two columns items_full " +
        "and every money surface should believe before writing to it.",
    ).toBe(false);
    expect(columnsOf("sales").has("sold_at")).toBe(true);
  });

  it("a fabricated column name is not in any table", () => {
    expect(columnsOf("listings").has("zzz_not_a_column")).toBe(false);
    expect(columnsOf("inventory_items").has("zzz_not_a_column")).toBe(false);
  });
});

// -- self-checks: the scan can still go red ---------------------------------

describe("US-3377: the scan reddens on a real defect (self-check)", () => {
  it("the key parser finds real keys and not prose", () => {
    const obj = `{
      user_id: ownerId,
      "quoted_col": 1,
      listing_status: "sold",
      sale_price: cond ? realValue : null,
      nested: { not_a_top_level_key: 1 },
      ...(flag ? { spread_key: 1 } : {}),
    }`;
    expect(topLevelKeys(obj)).toEqual([
      "user_id",
      "quoted_col",
      "listing_status",
      "sale_price",
      "nested",
    ]);
  });

  it("spots the US-3363 write shape, as an object literal and behind a variable", () => {
    const literal = scanSources([
      {
        file: "fixture/literal.ts",
        code: blankComments(`
          await supabase
            .from("listings")
            .update({ listing_status: "sold", sold_at: sale.soldAt } as never)
            .eq("id", id);
        `),
      },
    ]);
    expect(literal.bad.map((b) => b.detail)).toEqual(["writes listings.sold_at"]);

    // The `as never` shape this tree actually uses. A scan that only reads
    // `.update({` walks past 43 of the 155 real sites.
    const indirect = scanSources([
      {
        file: "fixture/indirect.ts",
        code: blankComments(`
          const patch: Record<string, unknown> = { listing_status: "sold" };
          patch.sold_at = sale.soldAt;
          await supabase.from("listings").update(patch as never).eq("id", id);
        `),
      },
    ]);
    expect(indirect.bad.map((b) => b.detail)).toEqual(["writes listings.sold_at"]);
  });

  it("spots a bad filter column and a bad select column", () => {
    const scan = scanSources([
      {
        file: "fixture/reads.ts",
        code: blankComments(`
          await supabase.from("grade_reports").select("id,certificate_id").eq("user_id", uid);
          await supabase.from("listings").select("id,zzz_not_a_column");
        `),
      },
    ]);
    // grade_reports.user_id has NEVER existed -- that was US-2842, the same
    // shape in a different file, on a harness with 21 green unit tests.
    expect(scan.bad.map((b) => b.detail).sort()).toEqual([
      "filters grade_reports.user_id with .eq()",
      "selects listings.zzz_not_a_column",
    ]);
  });

  it("reddens a REAL file when one real key is renamed (in-memory sabotage)", () => {
    // A real write site, a real payload builder, a one-token mutation, and the
    // mutation is asserted to have landed before the result is believed. This
    // tree mixes CRLF and LF and a patch that silently matches nothing is the
    // classic way a sabotage "passes".
    const file = "src/hooks/use-sku-merge.ts";
    const original = codeOf(file);
    expect(original).toContain("out.condition_notes = strTrim(v.condition_notes)");
    const mutated = original.replace(
      "out.condition_notes = strTrim(v.condition_notes)",
      "out.conditon_notes  = strTrim(v.condition_notes)",
    );
    expect(mutated, "the sabotage did not land; the assertion below proves nothing")
      .not.toBe(original);
    expect(mutated.length, "the replacement changed the file length and so the line numbers")
      .toBe(original.length);

    const clean = scanSources([{ file, code: original }]);
    expect(clean.bad, "this file is clean today; the sabotage below is the only difference")
      .toEqual([]);
    const red = scanSources([{ file, code: mutated }]);
    expect(red.bad.map((b) => b.detail)).toEqual(["writes inventory_items.conditon_notes"]);
  });

  it("does not attribute a filter to the wrong table when .from() takes a variable", () => {
    // The real shape in src/lib/team-reporting.ts:1060-1087. Nearest-.from()
    // attribution without the string-literal requirement blamed `users` for an
    // `inventory_items` filter and reported a defect that does not exist.
    const scan = scanSources([
      {
        file: "fixture/owner.ts",
        code: blankComments(`
          await supabase.from("users").select("id,full_name,email").in("id", ids);
          const q = supabase.from(table).select("created_by").eq("user_id", ownerId);
        `),
      },
    ]);
    expect(scan.bad).toEqual([]);
  });
});

// -- the rule ---------------------------------------------------------------

describe("US-3377: no query in src/ names a column the migrations do not create", () => {
  it("is clean", () => {
    expect(
      RESULT.bad.map((b) => `${b.where} ${b.detail}`).sort(),
      "a query names a column no migration creates. PostgREST refuses the WHOLE " +
        "statement with HTTP 400 PGRST204, so the fields that DO exist are not " +
        "written either -- and almost every write here is cast `as never`, so " +
        "nothing else in the toolchain will tell you.",
    ).toEqual([]);
  });
});

// -- onConflict vs partial unique indexes -----------------------------------

describe("US-3377: no onConflict in src/ names a partial unique index", () => {
  const indexes = allUniqueIndexes();

  it("the migration scan still sees the indexes", () => {
    // 128 unique indexes, 60 partial, measured 2026-09-11 -- the same numbers
    // the edge suite derives, which is the cross-check that this file and
    // services/edge-functions/src/tests/_migration-columns.ts agree.
    expect(
      indexes.filter((i) => i.partial).length,
      `only ${indexes.filter((i) => i.partial).length} partial unique indexes of ` +
        `${indexes.length} total. If that has collapsed, the parser broke, not the schema.`,
    ).toBeGreaterThanOrEqual(50);
  });

  it("names the canaries, because a bulk count is not enough", () => {
    // A corpus floor alone would NOT have caught the concatenated-file bug: 85
    // of 128 still looks like plenty. These five are the indexes that actually
    // produced the defect in the edge, so a parser that stops seeing one fails
    // here instead of going quietly green.
    for (
      const name of [
        "idx_grade_outcomes_buyer_purchase",
        "idx_grade_outcomes_report_sale",
        "changelog_entries_source_ref_key",
        "marketplace_sync_reviews_open_uniq",
        "marketplace_sync_reviews_unmatched_uniq",
      ]
    ) {
      const hit = indexes.find((i) => i.name === name);
      expect(hit, `the migration scan no longer sees ${name}`).toBeTruthy();
      expect(hit!.partial, `${name} is no longer partial`).toBe(true);
    }
  });

  it("is clean", () => {
    expect(
      findPartialConflicts(RESULT.conflictTargets, indexes).map(
        (b) => `${b.where}: ${b.table}(${b.columns.join(",")}) -> ${b.index}`,
      ),
      "each site above names a PARTIAL unique index as its ON CONFLICT target. " +
        "PostgREST cannot send the index predicate, so Postgres answers 400 / " +
        "42P10 for the whole statement and the write never happens.",
    ).toEqual([]);
  });

  it("the partial-index rule can still fire (self-check)", () => {
    const fixture = parseUniqueIndexes(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_grade_outcomes_report_sale
        ON public.grade_outcomes(grade_report_id, sale_id)
        WHERE sale_id IS NOT NULL;
      CREATE UNIQUE INDEX changelog_entries_pkey ON public.changelog_entries USING btree (id);
    `);
    expect(fixture.length).toBe(2);
    expect(fixture.filter((i) => i.partial).length).toBe(1);

    const scan = scanSources([
      {
        file: "fixture/conflict.ts",
        code: blankComments(`
          await supabase.from("grade_outcomes")
            .upsert(rows as never, { onConflict: "sale_id,grade_report_id" });
          await supabase.from("changelog_entries").upsert(rows as never, { onConflict: "id" });
        `),
      },
    ]);
    // Column ORDER reversed on purpose: ON CONFLICT infers on a SET, and an
    // order-sensitive comparison walks straight past the defect.
    expect(findPartialConflicts(scan.conflictTargets, fixture).map((b) => b.index)).toEqual([
      "idx_grade_outcomes_report_sale",
    ]);
  });
});

// -- the users self-service allowlist ---------------------------------------

describe("US-3377: every users write from src/ is on the self-service allowlist", () => {
  const allowlist = usersSelfServiceAllowlist();

  it("is derived from the NEWEST migration that defines it", () => {
    // 00526 made public.users self-updates deny-by-default, and the list lives
    // in the function body, so extending it means restating the whole array in
    // a LATER file. Pinning 00526 would assert against a body the database has
    // already replaced. 00710 documents what a wrong ancestor costs: copying
    // 00526 instead of 00671 would have dropped eight columns and silently
    // RE-ADDED business_phone and ship_from_address, which 00671 removed
    // because a browser write stores plaintext over AES-256-GCM ciphertext.
    const guard = usersGuardMigration();
    expect(guard).toMatch(/^\d{5,}_.*\.sql$/);
    expect(allowlist.length, "the allowlist parsed empty").toBeGreaterThan(20);
    expect(allowlist).toContain("share_garment_measurements");
    expect(allowlist).toContain("active_workspace_owner_id");
    // Every name it yields is a real column of public.users, which is the
    // cross-check that the array was parsed and not some other string list.
    const users = columnsOf("users");
    expect(allowlist.filter((c) => !users.has(c))).toEqual([]);
  });

  it("keeps the two AES-256-GCM columns OUT (US-2417 / 00671)", () => {
    // A browser write to either stores plaintext over ciphertext. The only
    // writer is PUT /api/account/shipping-profile, running as the service role.
    expect(allowlist).not.toContain("business_phone");
    expect(allowlist).not.toContain("ship_from_address");
  });

  it("never lets an entitlement, usage or billing column through", () => {
    const frozen = [
      "included_grades_this_period",
      "ai_actions_used_this_month",
      "grade_credit_balance",
      "role",
      "suspended",
      "plan",
      "stripe_customer_id",
      "id",
      "email",
    ];
    expect(frozen.filter((c) => allowlist.includes(c))).toEqual([]);
  });

  it("is clean", () => {
    // 15 write sites naming 14 distinct columns when this was written. A column
    // NOT on the list is refused by the trigger at runtime, on a real user, in
    // production -- the save returns no error to the browser and changes
    // nothing, which is how business_phone and ship_from_address were found.
    expect(RESULT.usersWriteSites, "no users writes matched at all").toBeGreaterThanOrEqual(5);
    const refused = [...RESULT.usersColumns.entries()]
      .filter(([col]) => !allowlist.includes(col))
      .map(([col, where]) => `${col} (${[...where].sort().join(", ")})`)
      .sort();
    expect(
      refused,
      "These columns are written on public.users from the browser, which runs " +
        "as the authenticated role, and guard_users_protected_columns refuses " +
        "them. Either the write belongs on the edge as the service role, or the " +
        "column belongs in a NEW migration restating the whole self_service array.",
    ).toEqual([]);
  });

  it("the allowlist parser can still fire (self-check)", () => {
    // THE SAME extractor the rule uses, over a fabricated body. A self-check
    // that re-implements the parser proves nothing about the parser: it stays
    // green while the real one hands back a fixed list regardless of input.
    const parsed = parseSelfServiceArray(`
      self_service constant text[] := ARRAY[
        'updated_at',
        -- business_phone and ship_from_address are NO LONGER HERE (US-2417)
        'full_name', 'avatar_url'
      ];
    `);
    // Exactly the three names in the array, in order. Dropping one from the
    // array changes this answer, which is the whole AC: a removed column fails
    // the build instead of waiting for a seller to report a save doing nothing.
    expect(parsed).toEqual(["updated_at", "full_name", "avatar_url"]);
    // And the prose naming the two removed columns must not smuggle them back.
    expect(parsed).not.toContain("business_phone");
    expect(parsed).not.toContain("ship_from_address");
  });
});
