#!/usr/bin/env node
// US-2355 AC1: which admin mutations write an audit row, and which do not?
//
// The AC asks for "every admin mutation writes an audit row, enforced with a
// drift guard". The guard exists (admin-audit-coverage_test.ts) and holds the
// specific holes that were found. What was still open was described as "a
// judgement pass over 100+ routes" — which is true, and is also why it kept not
// happening. An unbounded review does not get done; a list does.
//
// This is a REPORT, not a gate. It cannot decide policy: whether a given
// mutation deserves an audit row is a judgement about what an investigator would
// need, and several honest answers are "no" (marking your own notification read,
// deleting your own saved view). What it CAN do is put the question in front of
// someone, one line per route, with the easy majority already answered.
//
// Usage:
//   node scripts/audit-admin-mutations.mjs           # summary + the unaudited
//   node scripts/audit-admin-mutations.mjs --all     # every mutation route
//
// `auditRows()` is also imported by src/test/admin-audit-policy.test.ts, which
// turns this report into the drift guard AC1 asks for: a new admin mutation
// that leaves no trail fails CI until someone classifies it.
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Resolved from this file, not from cwd — it is run from the repo root by hand
// and imported by a test whose cwd is not guaranteed to be the same.
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DIR = join(ROOT, "services/edge-functions/src/routes");
const LIB = join(ROOT, "services/edge-functions/src/lib");

// Only admin surfaces. A tenant route writing no audit row is a different
// question with a different answer, and mixing them is how a list becomes
// unreadable.
const isAdminFile = (f) => /^admin-/.test(f) && f.endsWith(".ts");

const MUTATING = new Set(["post", "put", "patch", "delete"]);

/**
 * The handler body for one route registration, up to the NEXT registration.
 *
 * Bounded by the next `xRoutes.method(` rather than by brace matching: the
 * bodies contain template literals, regexes and object literals, and a brace
 * counter gets those wrong often enough to make the report untrustworthy. The
 * cost of this simpler rule is that the last handler in a file runs to EOF,
 * which over-reports audit coverage for exactly one route per file — so the
 * report is conservative in the direction of saying "audited", and the list of
 * UNAUDITED routes it prints is therefore a floor, not a guess.
 */
function bodies(src) {
  const re = /(\w+Routes)\.(get|post|put|patch|delete)\(\s*"([^"]+)"/g;
  const hits = [...src.matchAll(re)];
  return hits.map((m, i) => ({
    method: m[2],
    path: m[3],
    body: src.slice(m.index, hits[i + 1]?.index ?? src.length),
  }));
}

/**
 * Names that count as "writes an audit row" in this file.
 *
 * NOT just `writeAuditLog`. Several files wrap it — admin-grading.ts defines a
 * local helper for uniform actor_role handling and every route calls THAT, so a
 * bare search for the shared name reported all 42 of its mutations as unaudited.
 * The first run of this script did exactly that, and the number would have sent
 * someone to fix 42 routes that are already fine.
 *
 * Worth stating because it inverts the caveat in the header: the naive version
 * was not conservative toward "audited", it was badly wrong in the alarming
 * direction. A report that over-states the problem gets argued with once and
 * ignored afterwards.
 */
/**
 * Every top-level declaration in the file, name → body text.
 *
 * Needed twice, for the two ways a route's audit call ends up somewhere other
 * than the bytes after its own registration:
 *
 *   • a WRAPPER — admin-grading.ts and admin-claims.ts both define a local
 *     `auditLog(...)` over the shared writeAuditLog for uniform actor_role
 *     handling, and the routes call the wrapper;
 *   • a SHARED HANDLER — admin-claims registers approve and reject as
 *     `decisionHandler("approved", …)`, a factory declared ABOVE the
 *     registrations, so the handler body is not in the slice at all.
 *
 * Both shapes made the first runs of this script report audited routes as
 * unaudited: 97 of 210, against 22 once they are resolved. The claims ones
 * mattered most — approving a guarantee claim pays out money, and "the payout
 * route writes no audit row" is exactly the kind of false alarm that gets a
 * report dismissed wholesale, along with the 22 findings that are real.
 */
/**
 * Comments removed.
 *
 * A handler that only MENTIONS an audit call in a note explaining why it does
 * not audit would otherwise read as audited — the exact inversion this report
 * exists to avoid, and one this session has now hit in both directions.
 */
function strip(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/[^\n]*/g, "$1");
}

/**
 * Top-level declarations, name → body, BRACE-MATCHED.
 *
 * It used to slice each declaration from itself to the NEXT declaration, and in
 * a route file that is not the body — everything in between, including whole
 * route handlers, landed inside it. Measured on 2026-08-10: 48 declarations
 * across the admin route files had slices containing `writeAuditLog(` while
 * their real bodies did not, several of them one-line constants. `UUID_RE` in
 * admin-users.ts is 33 bytes and its slice was 15 KB.
 *
 * Both directions of that are bad, and both were observed:
 *
 *  • FALSE AUDITED — a route referencing such a constant (every `:id` route
 *    references UUID_RE) gets the oversized slice appended by expand(), and any
 *    audit call inside it makes the route read as audited. That is a security
 *    guard reporting "fine" about something it never checked.
 *  • FALSE UNAUDITED — adding ONE declaration to a route file moves every
 *    boundary after it. US-2458 added a presentational helper to
 *    admin-billing.ts and three unrelated routes began reporting as writing no
 *    audit row. They audit fine; the slice had moved under them.
 *
 * A declaration ends at the `}` that closes its first `{` at depth 0, or at the
 * first `;` if it never opens one (a constant, a type alias, a regex literal).
 */
export function declarations(code) {
  const re =
    /(?:^|\n)(?:export\s+)?(?:async\s+)?(?:function\s+([A-Za-z0-9_$]+)\s*\(|const\s+([A-Za-z0-9_$]+)\s*=)/g;
  const out = new Map();
  for (const m of code.matchAll(re)) {
    const name = m[1] ?? m[2];
    let depth = 0;
    let opened = false;
    let end = code.length;
    for (let i = m.index; i < code.length; i++) {
      const ch = code[i];

      // Skip string and template literals whole. A brace inside one is text.
      if (ch === '"' || ch === "'" || ch === "`") {
        i = skipQuoted(code, i);
        continue;
      }
      // …and regex literals, which is not a nicety: UUID_RE in admin-users.ts
      // is `/^[0-9a-f-]{36}$/`, and counting the `{36}` as a block closed the
      // declaration mid-pattern. That errs toward under-attributing (a route
      // reads as UNAUDITED), which is the safe direction and still wrong.
      if (ch === "/" && startsRegex(code, i)) {
        i = skipRegex(code, i);
        continue;
      }

      if (ch === "{") {
        depth++;
        opened = true;
      } else if (ch === "}") {
        depth--;
        if (opened && depth === 0) {
          end = i + 1;
          break;
        }
      } else if (ch === ";" && !opened) {
        end = i + 1;
        break;
      }
    }
    out.set(name, code.slice(m.index, end));
  }
  return out;
}

/** Index of the closing quote for the literal opening at `start`. */
function skipQuoted(code, start) {
  const quote = code[start];
  for (let i = start + 1; i < code.length; i++) {
    if (code[i] === "\\") i++;
    else if (code[i] === quote) return i;
  }
  return code.length;
}

/**
 * Is the `/` at `i` the start of a regex literal rather than division?
 *
 * Decided by the previous non-space character: after a value (identifier,
 * closing bracket, number) a slash divides; after `=`, `(`, `,`, `:`, `[`,
 * `!`, `&`, `|`, `?`, `{`, `;` or `return` it opens a pattern. Crude, and
 * sufficient here — these files are declarations and route handlers, not
 * arithmetic.
 */
function startsRegex(code, i) {
  if (code[i + 1] === "/" || code[i + 1] === "*") return false; // a comment
  for (let j = i - 1; j >= 0; j--) {
    const c = code[j];
    if (c === " " || c === "\t" || c === "\n" || c === "\r") continue;
    return "=(,:[!&|?{;".includes(c);
  }
  return true;
}

/** Index of the closing `/` for the regex opening at `start`. */
function skipRegex(code, start) {
  let inClass = false;
  for (let i = start + 1; i < code.length; i++) {
    const c = code[i];
    if (c === "\\") i++;
    else if (c === "[") inClass = true;
    else if (c === "]") inClass = false;
    else if (c === "\n") return i; // unterminated — do not run away
    else if (c === "/" && !inClass) return i;
  }
  return code.length;
}

/** Names that count as "writes an audit row" in this file. */
function auditingNames(decls) {
  const names = new Set(["writeAuditLog"]);
  for (const [name, body] of decls) {
    if (/writeAuditLog\s*\(/.test(body)) names.add(name);
  }
  return names;
}

/**
 * Exported lib functions, name → body. Route handlers delegate across the file
 * boundary constantly, and where the delegate lands decides the finding.
 *
 * The ads routes are the case that forced this. Nine of them looked like the
 * worst cluster in the report — including `/recommendations/:id/approve`, which
 * moves ad spend. They call `recordDecision`, which writes a row to
 * `ads_change_audit`. So the action IS recorded; it is recorded in a DOMAIN
 * table rather than in admin_audit_log.
 *
 * That is not a smaller version of the same finding, it is a different one, and
 * it is the one an operator has to rule on: an investigator reconstructing "what
 * did this admin do" reads the central trail, and anything living only in a
 * per-feature table is invisible to that question — even though the feature's
 * own screen shows it fine. Reporting these as "writes no audit row" would have
 * been false; reporting them as audited would have hidden the real gap.
 */
const libDecls = new Map();
for (const f of readdirSync(LIB).filter((f) => f.endsWith(".ts"))) {
  const code = strip(readFileSync(join(LIB, f), "utf8"));
  for (const [name, body] of declarations(code)) {
    if (!libDecls.has(name)) libDecls.set(name, body);
  }
}

/** An insert into a table whose name reads like an audit/history trail. */
const DOMAIN_TRAIL = /from\(\s*"([a-z_]*(?:_audit|_history|_events|_log))"\s*\)[\s\S]{0,200}\.insert\(/;

/**
 * Every admin mutation route, classified by where its trail lands.
 *
 * `central` — reaches writeAuditLog, so admin_audit_log sees it.
 * `domain`  — reaches an insert into a per-feature trail instead (the table
 *             name is returned, because which table it is IS the finding).
 * `writes`  — changes durable state at all.
 */
export function auditRows() {
  const rows = [];
  for (const file of readdirSync(DIR).filter(isAdminFile)) {
  const code = strip(readFileSync(join(DIR, file), "utf8"));
  const decls = declarations(code);
  const auditors = auditingNames(decls);
  const calls = (body, names) =>
    [...names].some((n) => new RegExp(`\\b${n}\\s*\\(`).test(body));

  // One level of expansion: append the body of any top-level declaration the
  // route references. That resolves a handler registered by name or built by a
  // factory. One level, not transitive — deeper indirection is rare here, and a
  // transitive walk would eventually pull in enough of the file to make every
  // route look audited, which is the failure this report cannot afford.
  const expand = (body) => {
    let out = body;
    for (const [name, declBody] of decls) {
      if (new RegExp(`\\b${name}\\s*\\(`).test(body)) out += "\n" + declBody;
    }
    // ...and across the file boundary, for handlers that delegate into lib/.
    for (const [name, declBody] of libDecls) {
      if (!decls.has(name) && new RegExp(`\\b${name}\\s*\\(`).test(body)) {
        out += "\n" + declBody;
      }
    }
    return out;
  };

  for (const r of bodies(code)) {
    if (!MUTATING.has(r.method)) continue;
    const full = expand(r.body);
    const central = calls(full, auditors);
    const trail = DOMAIN_TRAIL.exec(full);
    rows.push({
      file,
      method: r.method.toUpperCase(),
      path: r.path,
      central,
      // Only interesting when the central trail is absent: that is the case
      // where "is this really unaudited?" has a non-obvious answer.
      domain: !central && trail ? trail[1] : null,
      // Does it change durable state at all? A large share of admin POSTs are
      // read-only computations that merely take a request body — /preview,
      // /simulate, /analyze, /model-comparison. The existing guard already
      // refuses to demand audit rows for those, and rightly: a log full of
      // "someone previewed a newsletter" is a log nobody reads. So the question
      // for each no-trail route is not "does it POST" but "does it WRITE".
      writes: /\.(insert|upsert|update|delete)\(/.test(full),
      stepUp: /requireStepUp\s*\(|requireFreshStepUp\s*\(/.test(full),
    });
    }
  }
  return rows;
}

// Imported by the guard test; only the direct run prints.
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  report();
}

function report() {
const SHOW_ALL = process.argv.includes("--all");
const rows = auditRows();
const elsewhere = rows.filter((r) => !r.central && r.domain);
const nowhere = rows.filter((r) => !r.central && !r.domain);

console.log(`admin mutation routes: ${rows.length}`);
console.log(`  central admin trail:   ${rows.filter((r) => r.central).length}`);
console.log(`  a domain table only:   ${elsewhere.length}`);
console.log(`  no trail found:        ${nowhere.length}`);
console.log("");

const perFile = new Map();
for (const r of nowhere) perFile.set(r.file, (perFile.get(r.file) ?? 0) + 1);
console.log("no trail found, by file:");
for (const [f, n] of [...perFile].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(n).padStart(3)}  ${f}`);
}

const show = SHOW_ALL ? rows : [...nowhere, ...elsewhere];
console.log("");
console.log(SHOW_ALL ? "every mutation route:" : "the routes with no central trail:");
for (const r of show) {
  const where = r.central ? "audit" : r.domain ? `→${r.domain}` : "NONE ";
  const marks = [
    where.padEnd(20),
    r.writes ? "writes  " : "READONLY",
    r.stepUp ? "step-up" : "       ",
  ];
  console.log(`  ${marks.join(" ")} ${r.method.padEnd(6)} ${r.path.padEnd(38)} ${r.file}`);
}
}
