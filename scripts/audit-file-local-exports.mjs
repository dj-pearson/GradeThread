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
// ─────────────────────────────────────────────────────────────────────────────
// US-2436, 2026-08-08: THE "NEVER IMPORTED" NUMBER WAS MOSTLY WRONG, AND THIS
// IS WHY IT WAS BELIEVED. The scan above walks src/ and counts only a named
// `import { X } from` as a use. Both limits over-report, and together they
// over-reported the runtime-value group by roughly THREE IN FOUR:
//
//   • src/ is not the whole repo. vite.config.ts, scripts/, functions/ (the
//     Cloudflare Pages functions) and the Playwright suite all import from src/,
//     and none of them are walked. src/prerender/entry-server.tsx is the clearest
//     case: its exports exist FOR scripts/prerender.mjs and are read nowhere else,
//     so the scan called every one of them dead.
//   • A named import is not the only import. `import * as m from`, a default
//     import, and `export { X } from` re-exports all reach a symbol without ever
//     matching that regex.
//
// So the value list is now filtered by a second pass — `crossRefs()` below —
// that looks for the identifier ANYWHERE in the repo outside its own file, in
// every text file type that could hold a reference. It is deliberately crude and
// deliberately over-inclusive: a bare word match in a vault note counts as a
// reference. That direction of error is the safe one. This audit's job is to
// hand over a list where every entry is real; missing a few is cheap, and one
// false positive means someone deletes live code on its authority.
//
// The three groups that survive need three DIFFERENT answers, which is the
// whole point of separating them:
//   referenced   — not a candidate at all. Do nothing.
//   file-local   — drop the `export` keyword. Mechanical, tsc proves it.
//   dead         — declared once, referenced nowhere. DELETE it. This group is
//                  small and it is the only one worth a human's attention:
//                  un-exporting dead code leaves it running and hides it better.
//
// Numbers move every time src/ changes. Nothing should ever hard-code one of
// these counts — cite this script and re-run it.
//
// Usage:
//   node scripts/audit-file-local-exports.mjs           # summary + worst files
//   node scripts/audit-file-local-exports.mjs --list    # every never-imported name
//   node scripts/audit-file-local-exports.mjs --tests   # the test-only group
//   node scripts/audit-file-local-exports.mjs --values  # the actionable value groups
import { readdirSync, readFileSync } from "node:fs";

const MODE = process.argv.includes("--list")
  ? "list"
  : process.argv.includes("--tests")
  ? "tests"
  : process.argv.includes("--values")
  ? "values"
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

// ── The second pass. See the US-2436 block at the top for why this exists. ──
// src/types/database.ts is excluded by policy, not by measurement: it is the
// generated shape of the schema, and its exports are the app's public vocabulary
// for tables that exist. Pruning it by today's usage would fight the next
// migration, and an unused row type costs nothing at runtime.
const EXCLUDED_FILES = ["src/types/database.ts"];

function crossRefs() {
  // PROSE IS NOT A REFERENCE, and this is not a detail. A symbol named in a
  // vault note, a README or a backlog entry has been WRITTEN ABOUT, not used —
  // and the write-up is very often the report saying it is dead. Counting those
  // made the audit immunise its own findings: file two stories naming four dead
  // symbols and the next run reports zero, because prd.json now "references"
  // them. This file is excluded for the same reason, one step worse: it would
  // have immunised every symbol it ever printed.
  const SELF = "scripts/audit-file-local-exports.mjs";
  const PROSE = /\.md$|(^|[\\/])prd(\.archive)?\.json$/;
  const SKIP = /node_modules|[\\/]\.git|[\\/]dist|coverage|test-results|playwright-report/;
  const TEXT = /\.(ts|tsx|js|jsx|mjs|cjs|json|html)$/;
  const repo = new Map();
  const walkAll = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = `${d}/${e.name}`.replace(/^\.\//, "");
      if (SKIP.test(p)) continue;
      if (e.isDirectory()) walkAll(p);
      else if (p === SELF || PROSE.test(p)) continue;
      else if (TEXT.test(e.name)) {
        try {
          repo.set(p, readFileSync(p, "utf8"));
        } catch {
          /* unreadable is not a reference */
        }
      }
    }
  };
  walkAll(".");

  const groups = { referenced: [], local: [], dead: [] };
  for (const e of never) {
    if (e.kind !== "value" || EXCLUDED_FILES.includes(e.file)) continue;
    const re = new RegExp(`\\b${e.name.replace(/\$/g, "\\$")}\\b`, "g");
    let outside = 0;
    for (const [f, s] of repo) {
      if (f === e.file) continue;
      re.lastIndex = 0;
      if (re.test(s)) outside++;
    }
    if (outside > 0) {
      groups.referenced.push({ ...e, outside });
      continue;
    }
    re.lastIndex = 0;
    const uses = (repo.get(e.file)?.match(re) ?? []).length;
    // Exactly one occurrence is the declaration itself.
    (uses <= 1 ? groups.dead : groups.local).push({ ...e, uses });
  }
  return groups;
}

if (MODE === "list") {
  for (const e of never) console.log(`${e.kind.padEnd(5)} ${e.name}  ${e.file}`);
} else if (MODE === "tests") {
  console.log("Imported ONLY by tests — do NOT un-export these:\n");
  for (const e of testOnly) console.log(`${e.kind.padEnd(5)} ${e.name}  ${e.file}`);
} else if (MODE === "values") {
  const g = crossRefs();
  console.log(`referenced elsewhere in the repo: ${g.referenced.length}  <- NOT candidates`);
  console.log(`file-local:                       ${g.local.length}  <- drop the export keyword`);
  console.log(`dead:                             ${g.dead.length}  <- delete, do not un-export`);
  console.log("\n--- DEAD (delete) ---");
  for (const e of g.dead) console.log(`  ${e.name}  ${e.file}`);
  console.log("\n--- FILE-LOCAL (un-export) ---");
  const per = new Map();
  for (const e of g.local) per.set(e.file, [...(per.get(e.file) ?? []), e.name]);
  for (const [f, ns] of [...per].sort((a, b) => b[1].length - a[1].length)) {
    console.log(`  ${String(ns.length).padStart(3)}  ${f}  [${ns.join(", ")}]`);
  }
} else {
  const types = never.filter((e) => e.kind === "type").length;
  const values = never.length - types;
  console.log(`never imported anywhere: ${never.length}  (${types} types, ${values} values)`);
  console.log(`imported ONLY by tests:  ${testOnly.length}  <- must NOT be un-exported`);
  const g = crossRefs();
  console.log(
    `\nof the values (excluding ${EXCLUDED_FILES.join(", ")}), once the whole repo is searched:`,
  );
  console.log(`  referenced elsewhere: ${g.referenced.length}  <- NOT candidates, the scan above cannot see them`);
  console.log(`  file-local:           ${g.local.length}  <- drop the export keyword`);
  console.log(`  dead:                 ${g.dead.length}  <- delete; un-exporting leaves it running`);
  console.log("  (--values lists them)");
  const perFile = new Map();
  for (const e of never) perFile.set(e.file, (perFile.get(e.file) ?? 0) + 1);
  console.log("\nworst files:");
  for (const [f, n] of [...perFile].sort((a, b) => b[1] - a[1]).slice(0, 12)) {
    console.log(`  ${String(n).padStart(4)}  ${f}`);
  }
}
