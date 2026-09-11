// US-3401: the operator runbooks for the Postgres restore, held against the
// script they describe.
//
// HOW IT WENT WRONG. US-3394 replaced the restore's production guard. The old
// one refused only when the target string contained "gradethread.com", which no
// GradeThread Postgres DSN contains, so it never fired once. The replacement
// refuses EVERY target and makes the operator name the target back as
// host:port/dbname. `ALLOW_PROD_RESTORE` stopped being read at the same moment.
//
// Four surfaces went on describing the old shape, and one of them ships inside
// the admin UI (src/lib/admin/runbooks.ts), which is what somebody follows
// mid-incident without having read the script. A runbook that is one step short
// during an incident is worse than one that is obviously stale: the operator
// follows it, hits a refusal nobody told them about, and starts improvising
// against a database that --clean is about to drop.
//
// WHAT THIS DERIVES, AND WHY IT DOES NOT NAME THE FLAG.
// `ALLOW_PROD_RESTORE` is the worked example, not the subject. Hard-coding it
// would guard exactly one flag that is already dead and nothing else, which is
// the shape that rots. Everything below comes out of scripts/ops/*.sh:
//
//   READ      every environment variable the ops scripts actually expand
//   INERT     every variable a script declares in its own refusal text as
//             "no longer read" -- today that is ALLOW_PROD_RESTORE, derived
//   REQUIRED  the variable the restore's refusal tells the operator to re-run
//             with, pulled out of its "Re-run with:" block
//
// So a rename of RESTORE_CONFIRM_TARGET, a new inert flag, or a runbook telling
// someone to set a variable nothing reads all turn this red without an edit
// here.
//
// WHAT IT CANNOT DO. READ is every expansion in the file, which includes the
// scripts' own locals. That only makes the accepted set wider, never narrower,
// so it cannot produce a false failure; it can miss a runbook that names a
// shell local as if it were a knob. Sharpening that would mean parsing shell
// scoping, which is not worth a guard's complexity budget.
//
// WHY THE FILE LIST IS WRITTEN DOWN. Discovering surfaces by grepping for the
// script name pulls in notes that mention it in passing (key-rotation,
// encryption-at-rest) and would demand the confirmation step in prose that is
// not a procedure. Same reasoning as runbook-claims.test.ts: a guard that
// invents a finding gets ignored, and the person who dismisses the first
// finding dismisses the rest.

import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const OPS_DIR = join(ROOT, "scripts/ops");
const RESTORE_SCRIPT = "restore-postgres.sh";

/** Environment-variable shape: upper snake case with at least one underscore. */
const VAR = "[A-Z][A-Z0-9_]*_[A-Z0-9_]+";

/**
 * Surfaces that walk an operator through the Postgres restore. The in-app one
 * leads because it is the one read during an incident by someone who has not
 * opened the script.
 */
const SURFACES = [
  "src/lib/admin/runbooks.ts",
  "vault/10-ops/backups.md",
  "vault/10-ops/launch-checklist.md",
  "vault/10-ops/incident-response.md",
  "docs/operator-worklist.md",
];

function opsScripts(): Array<{ name: string; src: string }> {
  return readdirSync(OPS_DIR)
    .filter((f) => f.endsWith(".sh"))
    .map((name) => ({ name, src: readFileSync(join(OPS_DIR, name), "utf8") }));
}

/** Every `$NAME` / `${NAME...}` expansion in a shell source. */
function expansions(src: string): Set<string> {
  const out = new Set<string>();
  for (const m of src.matchAll(new RegExp(`\\$\\{(${VAR})|\\$(${VAR})`, "g"))) {
    out.add((m[1] ?? m[2])!);
  }
  return out;
}

/** Variables a script declares dead in its own operator-facing message. */
function inertVars(src: string): Set<string> {
  const out = new Set<string>();
  for (const m of src.matchAll(new RegExp(`(${VAR})[^\\n]{0,60}?no longer read`, "g"))) {
    out.add(m[1]!);
  }
  return out;
}

const scripts = opsScripts();

const INERT = new Set<string>();
for (const s of scripts) for (const v of inertVars(s.src)) INERT.add(v);

const READ = new Set<string>();
for (const s of scripts) for (const v of expansions(s.src)) READ.add(v);
for (const v of INERT) READ.delete(v);

/** The variable the restore's refusal tells the operator to re-run with. */
function requiredConfirmVar(): string {
  const src = scripts.find((s) => s.name === RESTORE_SCRIPT)?.src;
  expect(src, `${RESTORE_SCRIPT} was renamed or removed`).toBeDefined();
  const at = src!.indexOf("Re-run with:");
  expect(at, `${RESTORE_SCRIPT} no longer prints a "Re-run with:" line`).toBeGreaterThan(-1);
  const m = new RegExp(`(${VAR})=`).exec(src!.slice(at, at + 400));
  expect(m, `${RESTORE_SCRIPT}'s "Re-run with:" block names no variable`).not.toBeNull();
  return m![1]!;
}

/**
 * Sections of a surface: one per markdown heading, or one per runbook entry for
 * the TypeScript surface. Scoping matters: backups.md's PITR section sets
 * `WALG_S3_PREFIX`, a wal-g variable no ops script reads, and it is correct
 * there.
 */
function sections(rel: string, src: string): Array<{ name: string; text: string }> {
  if (rel.endsWith(".ts")) {
    const marks = [...src.matchAll(/slug:\s*"([^"]+)"/g)];
    return marks.map((m, i) => ({
      name: m[1]!,
      text: src.slice(m.index!, i + 1 < marks.length ? marks[i + 1]!.index! : src.length),
    }));
  }
  const out: Array<{ name: string; text: string }> = [];
  let name = "(preamble)";
  let buf: string[] = [];
  for (const line of src.split("\n")) {
    if (/^#{1,6}\s/.test(line)) {
      out.push({ name, text: buf.join("\n") });
      name = line.replace(/^#+\s*/, "").trim();
      buf = [];
    }
    buf.push(line);
  }
  out.push({ name, text: buf.join("\n") });
  return out;
}

/** Variables a piece of prose presents as something to SET. */
function namedAsSettable(text: string): Set<string> {
  const out = new Set<string>();
  const re = new RegExp(
    `(?:\\b(${VAR})\\s*=)|(?:\\bset\\s+\`?(${VAR})\`?)|(?:\\bpoint\\s+\`?(${VAR})\`?)`,
    "g",
  );
  for (const m of text.matchAll(re)) {
    const v = m[1] ?? m[2] ?? m[3];
    if (v) out.add(v);
  }
  return out;
}

const SCRIPT_NAMES = scripts.map((s) => s.name);

function surfaceSource(rel: string): string {
  return readFileSync(join(ROOT, rel), "utf8");
}

/**
 * Blanks fenced code blocks, keeping every offset intact. backups.md quotes the
 * OLD guard verbatim so nobody reinstates it, and a quotation of dead code is
 * not an instruction to use it. A code block that really did tell an operator
 * to set a dead flag still gets caught, by the "set a variable nothing reads"
 * case above.
 */
function withoutCodeBlocks(src: string): string {
  let out = "";
  let fenced = false;
  for (const line of src.split("\n")) {
    const fence = /^\s*```/.test(line);
    if (fence) fenced = !fenced;
    out += (fenced || fence ? " ".repeat(line.length) : line) + "\n";
  }
  return out.slice(0, src.length);
}

describe("restore runbooks vs the script they describe", () => {
  it("derives a non-empty picture of the scripts, or the rest of this file is vacuous", () => {
    expect(SCRIPT_NAMES).toContain(RESTORE_SCRIPT);
    expect(READ.size).toBeGreaterThan(5);
    expect(READ.has(requiredConfirmVar())).toBe(true);
  });

  it("no runbook tells an operator to set a variable the ops scripts do not read", () => {
    const findings: string[] = [];
    for (const rel of SURFACES) {
      for (const sec of sections(rel, surfaceSource(rel))) {
        if (!SCRIPT_NAMES.some((n) => sec.text.includes(n))) continue;
        for (const v of namedAsSettable(sec.text)) {
          if (READ.has(v)) continue;
          findings.push(
            `${rel} :: ${sec.name} tells an operator to set ${v}, which no ` +
              `script under scripts/ops/ reads` +
              (INERT.has(v) ? " any more (the script says so itself)" : ""),
          );
        }
      }
    }
    expect(findings, findings.join("\n")).toEqual([]);
  });

  it("every surface that names a variable the script declares dead says it is dead", () => {
    const findings: string[] = [];
    for (const rel of SURFACES) {
      const src = withoutCodeBlocks(surfaceSource(rel));
      for (const v of INERT) {
        let from = 0;
        for (;;) {
          const at = src.indexOf(v, from);
          if (at === -1) break;
          from = at + v.length;
          // Whitespace-normalised: these surfaces are hard-wrapped prose, so
          // "no longer read" routinely straddles a line break.
          const around = src.slice(Math.max(0, at - 200), at + 300).replace(/\s+/g, " ");
          if (!/no longer read/.test(around)) {
            findings.push(
              `${rel} names ${v} without saying it is no longer read. The ` +
                `script prints a note and refuses anyway, so a runbook that ` +
                `presents it as a working escape hatch sends an operator ` +
                `looking for one that does not exist.`,
            );
          }
        }
      }
    }
    expect(findings, findings.join("\n")).toEqual([]);
  });

  it("every surface that walks through the restore carries the confirmation step", () => {
    const required = requiredConfirmVar();
    const findings: string[] = [];
    for (const rel of SURFACES) {
      const src = surfaceSource(rel);
      if (!src.includes(RESTORE_SCRIPT)) continue;
      if (!src.includes(required)) {
        findings.push(
          `${rel} sends an operator to ${RESTORE_SCRIPT} without naming ` +
            `${required}. The script refuses every target until it is set, so ` +
            `this runbook stops one step short of working.`,
        );
      }
    }
    expect(findings, findings.join("\n")).toEqual([]);
  });

  it("the in-app runbook, specifically, carries it in the restore-drill entry", () => {
    const required = requiredConfirmVar();
    const rel = "src/lib/admin/runbooks.ts";
    const entry = sections(rel, surfaceSource(rel)).find((s) => s.name === "restore-drill");
    expect(entry, "the restore-drill runbook was renamed or removed").toBeDefined();
    expect(
      entry!.text.includes(required),
      `the admin-UI restore runbook does not name ${required}. It is the ` +
        `surface followed during an incident by someone who has not read the ` +
        `script, so it is the one that must not be a step short.`,
    ).toBe(true);
  });
});
