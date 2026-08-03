#!/usr/bin/env node
// US-2365 AC3: which exports in src/ does nothing outside their own file use?
//
// WHY THIS IS A REPORT AND NOT A SWEEP. The story says "85 exports in src/ are
// exported but used only inside their own file — dropping the export keyword is
// safe and shrinks the public surface. Batch it with this." Both halves of that
// turned out to be wrong, and the numbers are the argument:
//
//   • The count is not 85. It is ~936 — 629 types/interfaces and ~307 runtime
//     values. An estimate off by an order of magnitude is not a scoping error,
//     it changes what the task IS.
//   • ~230 more are imported ONLY BY TESTS. Those are not dead surface: they are
//     exported so a test can reach them, and un-exporting one breaks the test
//     rather than shrinking anything. This group alone is bigger than the story's
//     entire claimed total, which is why it is reported separately and loudly.
//
// And "safe" does not survive contact with where they live. 162 sit in
// src/types/database.ts, which is the app's type vocabulary — an unused row type
// is a description of a table that exists, not clutter. 52 are hooks in
// use-ebay.ts and 31 are constants: an exported hook nobody calls is DEAD CODE,
// and the answer there is to wire it or delete it (US-2362's question), not to
// quietly make it file-private and leave it running.
//
// So: read this, decide per group, and do it in passes that can be reviewed.
// A single commit dropping 936 export keywords is unreviewable, and it would
// conflict with everything else in flight.
//
// Usage:
//   node scripts/audit-file-local-exports.mjs           # summary + worst files
//   node scripts/audit-file-local-exports.mjs --list    # every never-imported name
//   node scripts/audit-file-local-exports.mjs --tests   # the test-only group
import { readdirSync, readFileSync } from "node:fs";

const MODE = process.argv.includes("--list")
  ? "list"
  : process.argv.includes("--tests")
  ? "tests"
  : "summary";

const files = [];
const walk = (d) => {
  for (const e of readdirSync(d, { withFileTypes: true })) {
    const p = `${d}/${e.name}`;
    if (e.isDirectory()) {
      if (!/node_modules|\.git|dist|coverage/.test(e.name)) walk(p);
    } else if (/\.(ts|tsx)$/.test(e.name)) files.push(p);
  }
};
walk("src");

const isTest = (f) =>
  /(^|\/)__tests__\//.test(f) || /\.test\.tsx?$/.test(f) || /^src\/test\//.test(f);

const DECL = [
  [/export\s+(?:async\s+)?function\s+([A-Za-z0-9_$]+)/g, "value"],
  [/export\s+(?:const|let|class)\s+([A-Za-z0-9_$]+)/g, "value"],
  [/export\s+(?:interface|type)\s+([A-Za-z0-9_$]+)/g, "type"],
];

// Only an IMPORT statement counts as a cross-file use. A bare mention of the
// same word elsewhere is not a dependency, and counting one would under-report
// exactly the symbols this exists to find.
const importedBy = new Map();
for (const f of files) {
  const src = readFileSync(f, "utf8");
  for (const m of src.matchAll(/import\s+(?:type\s+)?\{([^}]*)\}\s+from/g)) {
    for (const raw of m[1].split(",")) {
      const name = raw.trim().split(/\s+as\s+/)[0].trim().replace(/^type\s+/, "");
      if (!name) continue;
      if (!importedBy.has(name)) importedBy.set(name, new Set());
      importedBy.get(name).add(f);
    }
  }
}

const never = [];
const testOnly = [];
for (const f of files) {
  if (isTest(f)) continue; // a test's own exports are not public surface
  const src = readFileSync(f, "utf8");
  for (const [re, kind] of DECL) {
    for (const m of src.matchAll(re)) {
      const importers = [...(importedBy.get(m[1]) ?? [])].filter((x) => x !== f);
      if (importers.length === 0) never.push({ name: m[1], file: f, kind });
      else if (importers.every(isTest)) testOnly.push({ name: m[1], file: f, kind });
    }
  }
}

if (MODE === "list") {
  for (const e of never) console.log(`${e.kind.padEnd(5)} ${e.name}  ${e.file}`);
} else if (MODE === "tests") {
  console.log("Imported ONLY by tests — do NOT un-export these:\n");
  for (const e of testOnly) console.log(`${e.kind.padEnd(5)} ${e.name}  ${e.file}`);
} else {
  const types = never.filter((e) => e.kind === "type").length;
  const values = never.length - types;
  console.log(`never imported anywhere: ${never.length}  (${types} types, ${values} values)`);
  console.log(`imported ONLY by tests:  ${testOnly.length}  <- must NOT be un-exported`);
  const perFile = new Map();
  for (const e of never) perFile.set(e.file, (perFile.get(e.file) ?? 0) + 1);
  console.log("\nworst files:");
  for (const [f, n] of [...perFile].sort((a, b) => b[1] - a[1]).slice(0, 12)) {
    console.log(`  ${String(n).padStart(4)}  ${f}`);
  }
}
