#!/usr/bin/env node
// No schema repair may sit in a markdown file without a migration number.
//
// WHY THIS EXISTS (US-2726 / US-2832). Production was missing
// `listings.draft_id`. The column comes from 00134, which is pre-footer-era, and
// `scripts/apply-prod-migrations.sh` skips by MAXIMUM rather than by membership,
// so a hole beneath the watermark is never re-applied. The fix was two
// statements pasted by hand out of a fenced block in PENDING_MIGRATIONS.md.
//
// That paste left NO applied_migrations row. Which means: a restored backup, a
// staging stack or a new region silently lacks the column, the only symptom is
// that every cross-listing writeback fails with PGRST204, and no audit anywhere
// can tell a repaired production from a broken one. The markdown file said the
// repair had been done. A markdown file is not evidence about a database.
//
// So this guard makes that shape impossible to leave lying around: DDL in an ops
// document has to be attributable to a numbered migration file that exists on
// disk. Number it and the footer records it; do not number it and this fails.
//
//   node scripts/check-loose-repair-sql.mjs            # the default corpus
//   node scripts/check-loose-repair-sql.mjs --self-test
//   node scripts/check-loose-repair-sql.mjs FILE...    # specific files
//
// THE RULE. A fenced code block whose body contains a schema-MUTATING statement
// must sit under a markdown heading that names a five-digit version, and that
// version must resolve to a real file in supabase/migrations/. Everything else
// about the block is ignored.
//
// FIVE WAYS THIS COULD HAVE FAILED OPEN, and what each one cost elsewhere
// (see the guards-that-do-not-guard memory):
//
//   1. Language-gated fences. The live 00727 block opens with a BARE ``` and no
//      `sql` tag. A scan for ```sql misses it entirely. Every fence is read.
//   2. The guard's own prose satisfying it. Only FENCED blocks count - an
//      `ALTER TABLE` written inline in a sentence, or in this header, is prose
//      and is skipped. Nothing outside a fence is ever matched.
//   3. SQL comments. A block whose only DDL sits behind `--` or `/* */` is
//      documentation of a statement, not the statement. Comments are stripped
//      before matching, blocks first and then line comments, because stripping
//      by line prefix leaves the interior of a block comment behind.
//   4. A version token that resolves to nothing. `held-migration-gate.mjs`
//      printed "no HELD migrations listed - OK" for weeks because both headings
//      were spelled in a way it could not parse. An unparseable or dangling
//      version is REPORTED here, never dropped: a heading citing 00999 fails
//      just as loudly as a heading citing nothing.
//   5. Passing because it matched nothing. The test asserts the real
//      PENDING_MIGRATIONS.md still contains mutating blocks. If a future edit
//      makes the corpus empty, the green result stops being evidence, so the
//      test goes red instead.
//
// WHAT IT DELIBERATELY DOES NOT COVER. Plain DML (INSERT/UPDATE/DELETE) is not
// matched: `PENDING_MIGRATIONS.md` quotes self-record footers and one-row
// operator fixes constantly, and a rule with a noisy baseline is a rule people
// silence. Loose `.sql` files under scripts/ (the prod-catchup set) are also out
// of scope - they are already outside the migration system by design and would
// need their own decision. Both are named here so the gap is visible rather than
// assumed away.

import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");

/** Ops documents that are allowed to carry SQL at all. */
export const DEFAULT_CORPUS = [
  "PENDING_MIGRATIONS.md",
  "vault/10-ops/migrations-process.md",
  "vault/10-ops/deploy.md",
  "vault/10-ops/staging.md",
  "vault/10-ops/backups.md",
  "vault/10-ops/reading-prod-schema-without-psql.md",
];

/**
 * Statement heads that CHANGE the schema. Each is anchored to a statement
 * boundary (start of a line or just after a semicolon) so a keyword inside an
 * identifier or a sentence cannot trip it.
 */
const MUTATING_HEADS = [
  "alter\\s+table\\b",
  "alter\\s+type\\b",
  "alter\\s+(index|sequence|view|materialized\\s+view|function|policy|schema|publication)\\b",
  "create\\s+(or\\s+replace\\s+)?(table|index|unique\\s+index|trigger|policy|function|procedure|view|materialized\\s+view|type|schema|extension|sequence|rule|publication)\\b",
  "drop\\s+(table|index|trigger|policy|function|procedure|view|materialized\\s+view|type|schema|extension|sequence|column|constraint|publication)\\b",
  "comment\\s+on\\b",
  "truncate\\b",
  "grant\\b",
  "revoke\\b",
];

const MUTATING_RE = new RegExp(
  `(?:^|;)[\\s]*(${MUTATING_HEADS.join("|")})`,
  "gim",
);

/**
 * Fenced code blocks, with 1-based line numbers for the block body.
 * Returns every fence regardless of its language tag - see failure mode 1.
 */
export function fencedBlocks(text) {
  const lines = text.split(/\r?\n/);
  const blocks = [];
  let open = null;
  for (let i = 0; i < lines.length; i++) {
    const m = /^\s*```(\S*)/.exec(lines[i]);
    if (!m) continue;
    if (open === null) {
      open = { lang: m[1] ?? "", from: i + 1, body: [] };
      continue;
    }
    blocks.push({ lang: open.lang, startLine: open.from + 1, endLine: i, body: open.body.join("\n") });
    open = null;
  }
  // Collect bodies in a second pass so the line bookkeeping above stays simple.
  for (const b of blocks) {
    b.body = lines.slice(b.startLine - 1, b.endLine).join("\n");
  }
  return blocks;
}

/**
 * Strip SQL comments. BLOCKS FIRST, then line comments - the other order leaves
 * the indented interior of a slash-star block comment behind, and the interior
 * of a comment is exactly where a statement gets quoted.
 */
export function stripSqlComments(sql) {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .split("\n")
    .map((l) => l.replace(/--.*$/, ""))
    .join("\n");
}

/** The schema-mutating statement heads in a block, lowercased and de-duplicated. */
export function mutatingStatements(sql) {
  const clean = stripSqlComments(sql);
  const found = new Set();
  MUTATING_RE.lastIndex = 0;
  let m;
  while ((m = MUTATING_RE.exec(clean)) !== null) {
    found.add(m[1].replace(/\s+/g, " ").trim().toLowerCase());
  }
  return [...found];
}

/** The nearest markdown heading at or above `line` (1-based), or null. */
export function nearestHeading(text, line) {
  const lines = text.split(/\r?\n/);
  for (let i = Math.min(line, lines.length) - 1; i >= 0; i--) {
    if (/^#{1,6}\s/.test(lines[i])) return { line: i + 1, text: lines[i] };
  }
  return null;
}

/**
 * Five-digit version tokens in a string.
 *
 * NOT `\b\d{5}\b`. An underscore is a word character, so `\b` finds no boundary
 * in `00601_cancellation_requested_notification.sql` - and that filename form is
 * the DOMINANT way headings in PENDING_MIGRATIONS.md name a migration. The first
 * cut of this guard used `\b` and reported two correctly-attributed sections as
 * loose repairs: a guard firing at correct documentation, which is the expensive
 * direction, because the fix looks like editing the document. Bounded on digits
 * instead, so `00601_foo.sql`, `00601 - foo` and `(00601)` all resolve and
 * `20260809` still does not.
 */
export function versionsIn(s) {
  return [...new Set(s.match(/(?<!\d)\d{5}(?!\d)/g) ?? [])];
}

/** Every NNNNN prefix in supabase/migrations. */
export function knownMigrationVersions(dir = path.join(REPO, "supabase", "migrations")) {
  const out = new Set();
  for (const f of readdirSync(dir)) {
    const m = /^(\d{5})_.*\.sql$/.exec(f);
    if (m) out.add(m[1]);
  }
  return out;
}

/**
 * Findings for one markdown document.
 *
 * kind `loose-sql`          the block's heading names no migration version
 * kind `unresolved-version` it names one, and no such file exists on disk
 * kind `no-heading`         the block sits above every heading in the file
 */
export function auditText(text, { file = "<text>", known = new Set() } = {}) {
  const findings = [];
  for (const block of fencedBlocks(text)) {
    const statements = mutatingStatements(block.body);
    if (statements.length === 0) continue;
    const heading = nearestHeading(text, block.startLine - 1);
    const where = `${file}:${block.startLine}`;
    if (!heading) {
      findings.push({ kind: "no-heading", file, line: block.startLine, statements, where });
      continue;
    }
    const versions = versionsIn(heading.text);
    if (versions.length === 0) {
      findings.push({
        kind: "loose-sql",
        file,
        line: block.startLine,
        statements,
        heading: heading.text.trim(),
        headingLine: heading.line,
        where,
      });
      continue;
    }
    const resolved = versions.filter((v) => known.has(v));
    if (resolved.length === 0) {
      findings.push({
        kind: "unresolved-version",
        file,
        line: block.startLine,
        statements,
        versions,
        heading: heading.text.trim(),
        headingLine: heading.line,
        where,
      });
    }
  }
  return findings;
}

/** Audit a list of repo-relative paths. Missing files are skipped, not failed. */
export function auditFiles(files, { repo = REPO, known } = {}) {
  const versions = known ?? knownMigrationVersions(path.join(repo, "supabase", "migrations"));
  const findings = [];
  let scanned = 0;
  let blocks = 0;
  for (const rel of files) {
    let text;
    try {
      text = readFileSync(path.join(repo, rel), "utf8");
    } catch {
      continue;
    }
    scanned += 1;
    blocks += fencedBlocks(text).filter((b) => mutatingStatements(b.body).length > 0).length;
    findings.push(...auditText(text, { file: rel, known: versions }));
  }
  return { findings, scanned, blocks };
}

const MESSAGES = {
  "loose-sql":
    "schema SQL under a heading that names no migration. Give it a number so " +
    "its self-record footer proves it ran, then point this section at the file.",
  "unresolved-version":
    "the heading names a version with no file in supabase/migrations. A token " +
    "that resolves to nothing is reported, never ignored.",
  "no-heading": "schema SQL above the first heading in the file, so nothing attributes it.",
};

/** The versions the self-test cases pretend exist on disk. */
export const SELF_TEST_KNOWN = new Set(["00134", "00660"]);

/**
 * Sabotage cases, exported so the vitest suite runs the SAME set the CLI does
 * rather than a second copy that can drift. Each entry is
 * [label, markdown, expected finding kinds].
 */
export const SELF_TEST_CASES = (() => {
  const cases = [
    ["loose DDL under a version-less heading", "## The repair\n\n```sql\nALTER TABLE public.listings ADD COLUMN IF NOT EXISTS draft_id uuid;\n```\n", ["loose-sql"]],
    ["the same DDL under a numbered heading", "## APPLIED: 00660 ensure draft_id\n\n```sql\nALTER TABLE public.listings ADD COLUMN IF NOT EXISTS draft_id uuid;\n```\n", []],
    // The dominant heading form in the real document, and the one `\b\d{5}\b`
    // cannot parse because an underscore is a word character.
    ["a heading naming the FILENAME, not the bare number", "## APPLIED: 00660_ensure_listings_draft_id.sql (US-2832)\n\n```sql\nALTER TABLE public.listings ADD COLUMN IF NOT EXISTS draft_id uuid;\n```\n", []],
    // A date must not read as a version.
    ["an eight-digit date is not a version", "## Repair 20260820\n\n```sql\nALTER TABLE public.listings ADD COLUMN draft_id uuid;\n```\n", ["loose-sql"]],
    ["a heading naming a version with no file", "## APPLIED: 00999 nothing\n\n```sql\nCREATE INDEX IF NOT EXISTS x ON public.listings (draft_id);\n```\n", ["unresolved-version"]],
    // Failure mode 1: the live 00727 block has no language tag.
    ["a BARE fence carrying DDL", "## The repair\n\n```\nALTER TABLE public.flipdesk_settings ADD COLUMN IF NOT EXISTS x boolean;\n```\n", ["loose-sql"]],
    // Failure mode 2: prose about SQL is not SQL.
    ["DDL only in prose and inline backticks", "## The repair\n\nRun `ALTER TABLE public.listings ADD COLUMN draft_id uuid;` by hand.\n\nALTER TABLE at the start of a line, in prose.\n", []],
    // Failure mode 3: a commented-out statement is documentation.
    ["DDL behind a line comment", "## The repair\n\n```sql\n-- ALTER TABLE public.listings ADD COLUMN draft_id uuid;\nSELECT 1;\n```\n", []],
    ["DDL inside a block comment, indented continuation", "## The repair\n\n```sql\n/* what it does:\n   ALTER TABLE public.listings ADD COLUMN draft_id uuid;\n*/\nSELECT 1;\n```\n", []],
    // A read is never a repair.
    ["a read-only block", "## The audit\n\n```sql\nSELECT count(*) FROM public.listings WHERE draft_id IS NOT NULL;\n```\n", []],
    // Statement boundary, not a substring - both directions.
    ["a second statement after a semicolon", "## The repair\n\n```sql\nSELECT 1; CREATE INDEX idx ON public.listings (draft_id);\n```\n", ["loose-sql"]],
    ["a mutating keyword inside a string literal in a read", "## The audit\n\n```sql\nSELECT id FROM public.admin_audit_log WHERE action = 'drop table listings' ORDER BY id;\n```\n", []],
    ["no heading at all", "```sql\nDROP INDEX idx_listings_draft_id;\n```\n", ["no-heading"]],
    ["GRANT counts as a mutation", "## Fix the grants\n\n```sql\nGRANT SELECT ON public.listings TO anon;\n```\n", ["loose-sql"]],
  ];
  return cases;
})();

function selfTest() {
  let failed = 0;
  for (const [label, md, want] of SELF_TEST_CASES) {
    const got = auditText(md, { file: "case.md", known: SELF_TEST_KNOWN }).map((f) => f.kind).sort();
    const ok = JSON.stringify(got) === JSON.stringify([...want].sort());
    if (!ok) failed += 1;
    console.log(`  ${ok ? "ok  " : "FAIL"} ${label}: [${got.join(",")}] (want [${want.join(",")}])`);
  }
  // Anti-vacuous: the guard passing on the REAL document only means something
  // if the real document still has blocks for it to look at. A corpus that
  // quietly emptied would otherwise read exactly like a clean one.
  const { blocks, scanned } = auditFiles(DEFAULT_CORPUS);
  if (blocks < 4) {
    failed += 1;
    console.log(`  FAIL corpus: only ${blocks} mutating block(s) across ${scanned} document(s) - a green result here is not evidence`);
  } else {
    console.log(`  ok   corpus: ${blocks} mutating block(s) across ${scanned} document(s) for the rule to bite on`);
  }
  console.log(failed === 0 ? `self-test: ${SELF_TEST_CASES.length + 1} passed` : `self-test: ${failed} FAILED`);
  return failed === 0 ? 0 : 1;
}

function main(argv) {
  if (argv.includes("--self-test")) return selfTest();
  const files = argv.filter((a) => !a.startsWith("--"));
  const corpus = files.length > 0 ? files : DEFAULT_CORPUS;
  const { findings, scanned, blocks } = auditFiles(corpus);
  console.log(
    `check-loose-repair-sql: ${scanned} document(s), ${blocks} schema-mutating fenced block(s).`,
  );
  if (findings.length === 0) {
    console.log("every one of them is attributed to a migration file that exists. OK");
    return 0;
  }
  console.log(`\n${findings.length} unattributed schema repair(s):\n`);
  for (const f of findings) {
    console.log(`  ${f.where}  [${f.kind}]  ${f.statements.join(", ")}`);
    if (f.heading) console.log(`    under ${f.file}:${f.headingLine}  ${f.heading}`);
    console.log(`    ${MESSAGES[f.kind]}`);
  }
  console.log(
    "\nSQL pasted out of a markdown file leaves no applied_migrations row, so no audit\n" +
      "can tell a repaired production from a broken one. That is US-2726 verbatim.",
  );
  return 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
