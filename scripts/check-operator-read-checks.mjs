#!/usr/bin/env node
/**
 * US-3396: an operator script must not build a real-looking answer out of a
 * failed read.
 *
 * ── WHY A GUARD AND NOT JUST THE NINE FIXES ─────────────────────────────────
 *
 * The audit behind US-3396 read 50 of 260 non-test scripts closely and found 25
 * with a confirmed defect. Nine rendered a failed read as a number and nine
 * exited 0 after failing. Every one of those was written by somebody being
 * careful; the shape is simply invisible at review time, because the code that
 * drops an error looks shorter and cleaner than the code that checks it. So the
 * fixes are worth a day and this file is worth the next one: it is the half
 * that survives the next script nobody reviews.
 *
 * ── WHAT IT CHECKS. TWO MECHANICAL RULES, NOTHING CLEVER ────────────────────
 *
 *   supabase-destructure-drops-error
 *     A destructuring `await` whose bound names include `data` or `count` but
 *     NOT `error`, in a statement that reaches supabase-js (`.from(`, `.rpc(`,
 *     `.storage.`, `.auth.`). supabase-js never throws on a query failure - it
 *     returns `{ data: null, error }` - so dropping `error` turns "the query
 *     failed" into "there is nothing there", which is a different answer that
 *     prints identically.
 *
 *   unchecked-fetch-response
 *     An awaited `fetch` bound to a name, where that name is never tested for
 *     `.ok` or `.status` anywhere later in the file. `fetch` rejects only on a
 *     transport failure; a 401, a 403 and a 500 all resolve, and `.json()` on a
 *     PostgREST error body yields an object that reads as an empty result set.
 *
 * Neither rule needs a type checker, a parser or a running database, which is
 * why they can run on every commit. Both are deliberately dumb: they will
 * occasionally report code that is fine, and that is what KNOWN_OK is for.
 *
 * ── THE SUBJECT SET IS DERIVED, NEVER LISTED ────────────────────────────────
 *
 * SUBJECT_ROOTS names two DIRECTORIES and the files are read off disk. A list
 * of filenames would go stale the first time somebody adds a script, and it
 * would go stale silently, which is the exact failure mode this guard exists to
 * catch.
 *
 * ── KNOWN_OK IS A LIST OF NAMED SITES WITH A REASON, NOT A NUMBER ───────────
 *
 * Same shape as check-ui-antipatterns.mjs's knownNoise, for the same reason: a
 * numeric budget lets a new violation arrive without a word as long as an old
 * one was fixed. Matching by file + snippet means a NEW finding fails even when
 * the total is unchanged. And an entry that STOPS matching also fails, so the
 * list can only shrink - a site that gets fixed has to be deleted from here.
 *
 * ── selfCheck() ─────────────────────────────────────────────────────────────
 *
 * A rule that matches nothing is not an error in a source scan; it is simply
 * absent from the findings, which reads exactly like a clean codebase. So the
 * fixtures under scripts/fixtures/operator-read-checks/ carry a textbook
 * instance of each rule, marked `MUST_FIRE <rule>`, and a matching set of
 * near-misses marked `MUST_NOT_FIRE`. The gate fails if a rule stops firing on
 * its own fixture, if it fires on a near-miss, or if the counts drift.
 *
 * Usage:
 *   node scripts/check-operator-read-checks.mjs          # exit 1 on a finding
 *   node scripts/check-operator-read-checks.mjs --json
 *
 * Enforced by scripts/check-operator-read-checks.test.mjs, which
 * vitest.scripts.config.mjs collects and which runs in `npm run verify` and in
 * CI's `npm run test:scripts` step.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// fileURLToPath, never `new URL(...).pathname`: that keeps a leading slash
// before the drive letter on Windows and is relative on Linux.
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** The two script directories. Files are read off disk, never listed here. */
export const SUBJECT_ROOTS = ["scripts", "services/edge-functions/scripts"];

/** Where the deliberately-bad instances live. Excluded from the real scan. */
export const SELF_CHECK_DIR = "scripts/fixtures/operator-read-checks";

const SKIP_DIRS = new Set(["node_modules", "fixtures", ".git", "dist", "coverage"]);
const SOURCE_EXT = /\.(mjs|cjs|js|ts)$/;
const TEST_FILE = /\.test\.(mjs|cjs|js|ts)$/;

/** supabase-js surfaces. A statement reaching one of these is a database read. */
const SUPABASE_CALL = /\.\s*(?:from|rpc)\s*\(|\.\s*storage\s*\.|\.\s*auth\s*\./;

const DESTRUCTURED_AWAIT = /\b(?:const|let|var)\s*\{([^}]*)\}\s*=\s*await\b/g;
const NAMED_AWAIT_FETCH = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*await\s+fetch\s*\(/g;

export const RULES = ["supabase-destructure-drops-error", "unchecked-fetch-response"];

/**
 * Sites the rules report where the code is defensible. Each entry names the
 * file, a snippet that must still be present, and WHY.
 *
 * An entry that stops matching FAILS THE GUARD. Delete it when the site is
 * fixed or moved; never edit one to make a new finding pass.
 */
export const KNOWN_OK = [
  {
    rule: "unchecked-fetch-response",
    file: "services/edge-functions/scripts/backfill-tag-reads.ts",
    snippet: "const ok = await fetch(",
    why:
      "`ok` is bound to the RESULT of `.then((r) => r.ok)`, not to a Response - " +
      "the check the rule is looking for is inside the same expression, and " +
      "`.catch(() => false)` covers the transport case. The rule matches the " +
      "binding form, which is what keeps it cheap; this is the price.",
  },
  {
    rule: "unchecked-fetch-response",
    file: "services/edge-functions/scripts/check-prod-migration.ts",
    snippet: "const res = await fetch(url, { signal: ctl.signal })",
    why:
      "`res` is bound only to call `.json()`, and every failure path lands in " +
      "the surrounding catch: a transport error, the 25s abort, and a non-JSON " +
      "error page all throw there. The caller then prints `<url> unreadable` " +
      "and returns undefined, so no verdict is built from the failed read.",
  },
  {
    rule: "unchecked-fetch-response",
    file: "scripts/probe-prod-readonly.mjs",
    snippet: "const pre = await fetch(`${EDGE}/health`",
    why:
      "A CORS preflight probe. The question is which layer ANSWERED, so the " +
      "verdict turns on the access-control-allow-headers value rather than on " +
      "the status; a transport failure is caught to null and the whole record " +
      "is skipped. A non-2xx with no CORS headers renders as `LOOK - something " +
      "in front IS rewriting CORS`, which is a flag for a human, not a " +
      "confident answer. Not in US-3396's edit scope; re-check if that probe " +
      "ever starts printing a verdict of its own.",
  },
];

// ── scanning ────────────────────────────────────────────────────────────────

/** Every source file under `dir`, recursively. Tests and fixtures excluded. */
export function listSources(dir, { includeFixtures = false } = {}) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!includeFixtures && SKIP_DIRS.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listSources(full, { includeFixtures }));
    else if (SOURCE_EXT.test(entry.name) && !TEST_FILE.test(entry.name)) out.push(full);
  }
  return out;
}

const lineNumberAt = (source, index) => source.slice(0, index).split("\n").length;

const collapse = (s) => s.replace(/\s+/g, " ").trim();

/**
 * Blank out comments, string bodies and regex bodies, keeping every character
 * position and every newline. Both rules run over THIS, so commented-out code
 * and a URL inside a string cannot trip them, while `file:line` stays exact.
 *
 * Written as one pass rather than a chain of regex replacements on purpose: a
 * "comment stripper" that is itself a regex is how a guard ends up satisfied by
 * its own bug. The regex-literal heuristic is the usual one - a `/` starts a
 * regex only after a token that cannot end an expression - and getting it wrong
 * costs at most a spurious finding, which KNOWN_OK and selfCheck both catch.
 */
export function blankNonCode(source) {
  const out = source.split("");
  const blank = (from, to) => {
    for (let k = from; k < to && k < out.length; k++) {
      if (out[k] !== "\n") out[k] = " ";
    }
  };
  // A TEMPLATE LITERAL'S ${...} IS CODE AND MUST SURVIVE. Blanking it whole is
  // the difference between reading `console.log(\`... ${res.status}\`)` as a
  // status check and reading it as nothing at all - which is exactly the false
  // positive that flagged scripts/ops/uptime-check.mjs on the first run.
  // Entries are { kind: "template" } or { kind: "subst", depth } for the braces
  // nested inside one.
  const stack = [];
  const top = () => stack[stack.length - 1];
  let i = 0;
  let lastCode = "";

  while (i < source.length) {
    if (top()?.kind === "template") {
      const ch = source[i];
      if (ch === "\\") {
        blank(i, i + 2);
        i += 2;
        continue;
      }
      if (ch === "`") {
        stack.pop();
        lastCode = "`";
        i++;
        continue;
      }
      if (ch === "$" && source[i + 1] === "{") {
        stack.push({ kind: "subst", depth: 0 });
        lastCode = "{";
        i += 2;
        continue;
      }
      blank(i, i + 1);
      i++;
      continue;
    }

    const ch = source[i];
    const next = source[i + 1];

    if (ch === "/" && next === "/") {
      let j = i + 2;
      while (j < source.length && source[j] !== "\n") j++;
      blank(i, j);
      i = j;
      continue;
    }
    if (ch === "/" && next === "*") {
      const end = source.indexOf("*/", i + 2);
      const j = end === -1 ? source.length : end + 2;
      blank(i, j);
      i = j;
      continue;
    }
    if (ch === '"' || ch === "'") {
      let j = i + 1;
      while (j < source.length) {
        if (source[j] === "\\") {
          j += 2;
          continue;
        }
        if (source[j] === ch || source[j] === "\n") break;
        j++;
      }
      blank(i + 1, j);
      i = Math.min(j + 1, source.length);
      lastCode = ch;
      continue;
    }
    if (ch === "`") {
      stack.push({ kind: "template" });
      lastCode = "`";
      i++;
      continue;
    }
    if (ch === "{") {
      if (top()?.kind === "subst") top().depth++;
      lastCode = "{";
      i++;
      continue;
    }
    if (ch === "}") {
      const t = top();
      if (t?.kind === "subst") {
        if (t.depth === 0) {
          stack.pop();
          lastCode = "}";
          i++;
          continue;
        }
        t.depth--;
      }
      lastCode = "}";
      i++;
      continue;
    }
    // A `/` starts a regex only after a token that cannot END an expression.
    // The usual heuristic; getting it wrong costs at most a spurious finding,
    // which KNOWN_OK and selfCheck both catch.
    if (ch === "/" && /^[([{=,:;!&|?+\-*%<>~^]?$/.test(lastCode)) {
      let j = i + 1;
      let inClass = false;
      while (j < source.length && source[j] !== "\n") {
        if (source[j] === "\\") {
          j += 2;
          continue;
        }
        if (source[j] === "[") inClass = true;
        else if (source[j] === "]") inClass = false;
        else if (source[j] === "/" && !inClass) break;
        j++;
      }
      if (source[j] === "/") {
        blank(i + 1, j);
        i = j + 1;
        lastCode = "/";
        continue;
      }
    }
    if (!/\s/.test(ch)) lastCode = ch;
    i++;
  }
  return out.join("");
}

/**
 * Both rules over one file's source. Pure, so a test can drive it with a string
 * and the fixtures can drive it off disk.
 *
 * @returns {{rule: string, file: string, line: number, snippet: string}[]}
 */
export function scanSource(source, file) {
  const findings = [];
  const code = blankNonCode(source);
  const lines = source.split("\n");
  /** The ORIGINAL line, which is what a person has to go and look at. */
  const lineText = (n) => collapse(lines[n - 1] ?? "").slice(0, 200);

  for (const match of code.matchAll(DESTRUCTURED_AWAIT)) {
    const bound = match[1]
      .split(",")
      .map((piece) => piece.split(":")[0].trim())
      .filter(Boolean);
    if (!bound.includes("data") && !bound.includes("count")) continue;
    if (bound.includes("error")) continue;
    // Only the STATEMENT is tested for a supabase call, so a `.from(` further
    // down the file cannot vouch for an unrelated destructure. It ends at the
    // first `;`, or 900 characters in, whichever comes first.
    const start = match.index;
    let end = code.indexOf(";", start + match[0].length);
    if (end === -1 || end - start > 900) end = start + 900;
    if (!SUPABASE_CALL.test(code.slice(start, end))) continue;
    const line = lineNumberAt(code, start);
    findings.push({
      rule: "supabase-destructure-drops-error",
      file,
      line,
      snippet: lineText(line),
    });
  }

  for (const match of code.matchAll(NAMED_AWAIT_FETCH)) {
    const name = match[1];
    const from = match.index + match[0].length;
    // "IN SCOPE" IS APPROXIMATED BY THE NEXT REBINDING OF THE SAME NAME.
    //
    // The whole rest of the file is wrong, and wrong in the dangerous
    // direction: `const res = await fetch(a)` with no check passes silently
    // because an unrelated function two hundred lines down also calls its
    // response `res` and DOES check it. `res` is the name in 48 of the 53
    // candidate sites in this repo, so that is not a corner case. Stopping at
    // the next `const/let/var <name> =` gives each binding its own window
    // without needing a parser.
    const rebind = new RegExp(String.raw`\b(?:const|let|var)\s+${name}\s*=`, "g");
    rebind.lastIndex = from;
    const nextBinding = rebind.exec(code);
    const window = code.slice(from, nextBinding ? nextBinding.index : code.length);
    if (new RegExp(String.raw`\b${name}\s*\.\s*(?:ok|status)\b`).test(window)) continue;
    const line = lineNumberAt(code, match.index);
    findings.push({
      rule: "unchecked-fetch-response",
      file,
      line,
      snippet: lineText(line),
    });
  }

  return findings.sort((a, b) => a.line - b.line);
}

/** Repo-relative, forward slashes, so an entry reads the same on both OSes. */
const relative = (full) =>
  full.slice(REPO_ROOT.length + 1).split("\\").join("/");

/** Scan a directory tree and return findings with repo-relative paths. */
export function scanTree(dirRelative, options) {
  const findings = [];
  for (const full of listSources(join(REPO_ROOT, dirRelative), options)) {
    findings.push(...scanSource(readFileSync(full, "utf8"), relative(full)));
  }
  return findings;
}

// ── allowlist reconciliation ────────────────────────────────────────────────

/** True when a finding is the site a KNOWN_OK entry describes. */
export function matchesKnown(finding, entry) {
  return (
    finding.rule === entry.rule &&
    finding.file === entry.file &&
    finding.snippet.includes(collapse(entry.snippet))
  );
}

/**
 * Reconcile findings against KNOWN_OK.
 * Returns { unexpected, stale } - both empty is the passing state.
 */
export function reconcile(findings, known = KNOWN_OK) {
  const unexpected = findings.filter((f) => !known.some((e) => matchesKnown(f, e)));
  const stale = known.filter((e) => !findings.some((f) => matchesKnown(f, e)));
  return { unexpected, stale };
}

// ── self-check ──────────────────────────────────────────────────────────────

/**
 * Prove every rule still fires on its own fixture, and still does NOT fire on
 * the near-miss beside it.
 *
 * The expectations are read out of the fixtures themselves - a `MUST_FIRE
 * <rule>` marker on the exact line that should be reported - so adding a case
 * updates the expectation, and a rule that quietly broadens or narrows fails.
 *
 * @returns {string[]} problems; empty means the rules are alive.
 */
export function selfCheck() {
  const problems = [];
  const dir = join(REPO_ROOT, SELF_CHECK_DIR);
  const files = listSources(dir, { includeFixtures: true });
  if (files.length === 0) {
    return [`${SELF_CHECK_DIR} holds no fixtures. Every assertion below is vacuous.`];
  }

  const expectedByRule = new Map(RULES.map((r) => [r, 0]));
  const actualByRule = new Map(RULES.map((r) => [r, 0]));

  for (const full of files) {
    const source = readFileSync(full, "utf8");
    const lines = source.split("\n");
    const rel = relative(full);

    for (const [i, text] of lines.entries()) {
      const marker = /MUST_FIRE\s+([\w-]+)/.exec(text);
      if (!marker) continue;
      if (!RULES.includes(marker[1])) {
        problems.push(`${rel}:${i + 1} marks an unknown rule id "${marker[1]}".`);
        continue;
      }
      expectedByRule.set(marker[1], expectedByRule.get(marker[1]) + 1);
    }

    for (const finding of scanSource(source, rel)) {
      const text = lines[finding.line - 1] ?? "";
      actualByRule.set(finding.rule, (actualByRule.get(finding.rule) ?? 0) + 1);
      if (text.includes("MUST_NOT_FIRE")) {
        problems.push(
          `${rel}:${finding.line} is a NEAR-MISS and ${finding.rule} reported it. ` +
            `The rule got broader; it will now flag correct code across 226 files.`,
        );
      } else if (!new RegExp(String.raw`MUST_FIRE\s+${finding.rule}\b`).test(text)) {
        problems.push(
          `${rel}:${finding.line} was reported by ${finding.rule} but carries no ` +
            `marker. Add "MUST_FIRE ${finding.rule}" if that is intended.`,
        );
      }
    }
  }

  for (const rule of RULES) {
    const expected = expectedByRule.get(rule);
    const actual = actualByRule.get(rule);
    if (expected === 0) {
      problems.push(
        `${rule} has no fixture. A rule with nothing to fire on looks exactly ` +
          `like a clean codebase - add a textbook instance to ${SELF_CHECK_DIR}.`,
      );
    } else if (expected !== actual) {
      problems.push(
        `${rule} fired ${actual} time(s) on ${expected} marked instance(s) in ` +
          `${SELF_CHECK_DIR}. Either the rule stopped matching one, or the tool ` +
          `changed. Do NOT delete the fixture to make this pass.`,
      );
    }
  }

  return problems;
}

// ── report ──────────────────────────────────────────────────────────────────

/** Everything the CLI and the test both need, computed once. */
export function run() {
  const selfCheckProblems = selfCheck();
  const findings = SUBJECT_ROOTS.flatMap((root) => scanTree(root));
  const { unexpected, stale } = reconcile(findings);
  const files = SUBJECT_ROOTS.reduce(
    (n, root) => n + listSources(join(REPO_ROOT, root)).length,
    0,
  );
  return { selfCheckProblems, findings, unexpected, stale, files };
}

function main(argv) {
  const result = run();

  if (argv.includes("--json")) {
    console.log(JSON.stringify(result, null, 2));
    return result.selfCheckProblems.length + result.unexpected.length + result.stale.length
      ? 1
      : 0;
  }

  let failed = false;

  if (result.selfCheckProblems.length > 0) {
    failed = true;
    console.error(
      `[operator-read-checks] ${result.selfCheckProblems.length} rule(s) no longer ` +
        `behave on their own fixture:`,
    );
    for (const p of result.selfCheckProblems) console.error(`  ${p}`);
  }

  if (result.unexpected.length > 0) {
    failed = true;
    console.error(
      `\n[operator-read-checks] ${result.unexpected.length} finding(s) not in KNOWN_OK:`,
    );
    for (const f of result.unexpected) {
      console.error(`  ${f.file}:${f.line}  [${f.rule}]  ${f.snippet}`);
    }
    console.error(
      "\nA supabase read that drops `error` reports a failed query as an empty\n" +
        "result. An unchecked fetch reports a 401 as an empty result. Either\n" +
        "check it, or add a KNOWN_OK entry saying why the site is defensible.",
    );
  }

  if (result.stale.length > 0) {
    failed = true;
    console.error(
      `\n[operator-read-checks] ${result.stale.length} KNOWN_OK entr(ies) no longer match:`,
    );
    for (const e of result.stale) console.error(`  ${e.file} :: ${e.snippet}`);
    console.error("\nThe site was fixed or moved. Delete the entry - this list only shrinks.");
  }

  if (failed) return 1;
  console.log(
    `[operator-read-checks] OK  ${result.files} script(s) across ` +
      `${SUBJECT_ROOTS.join(" + ")} · ${result.findings.length} finding(s), all ` +
      `${KNOWN_OK.length} in KNOWN_OK.`,
  );
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
